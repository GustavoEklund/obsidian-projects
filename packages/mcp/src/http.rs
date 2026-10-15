//! The Streamable HTTP transport (`--http`): one server shared by several MCP clients, instead of one stdio process per
//! client.
//!
//! # Threat model
//!
//! The server edits the user's notes, so who may talk to it matters more than how fast it answers.
//!
//! * **Local only.** It binds to `127.0.0.1` and nothing else; there is deliberately no `--host`. Reaching it from
//!   another machine would mean a different threat model (TLS, real accounts), and that is not what this is for.
//! * **A token is required.** Any program of the user can reach a loopback port, so reachable does not mean allowed:
//!   every request needs `Authorization: Bearer <token>`, compared in constant time ([`crate::token`]). A missing or
//!   wrong token is answered `401` before the request is looked at.
//! * **DNS rebinding.** A web page can make the browser connect to `127.0.0.1` under an attacker's host name. The
//!   protocol layer therefore refuses any request whose `Host` is not a loopback name, and any browser `Origin` that
//!   is not this very server (it is told our two origins explicitly, which also turns the check on: an empty list of
//!   allowed origins would switch it off).
//! * **Bounded resources.** Bodies are limited to 1 MiB, a connection must send its headers within a deadline (so a
//!   client that dribbles bytes cannot hold a slot, and idle keep-alive connections are closed by the same deadline),
//!   a request has an overall deadline, and only [`Limits::max_connections`] connections are served at once: the
//!   next ones are told `503` instead of piling up.
//! * **Nothing sensitive is logged.** Neither the token nor a request body ever reaches stderr.
//!
//! # Why stateless
//!
//! The protocol offers sessions, where the server remembers each client between requests. This server keeps none: every
//! request is complete in itself (the tools take their whole input and the board is the shared state), a restart loses
//! nothing, and an idle client costs no memory. The server answers each request with a plain JSON body, and gives a
//! fresh handler to every request, which is why [`Projects`] is cheap to clone.
//!
//! # Weight
//!
//! The whole transport is a tower service from `rmcp` driven by `hyper` directly: no web framework. Idle, the HTTP
//! server holds about 3 MB; see `DESIGN.md` for the measured numbers.
use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::server::graceful::GracefulShutdown;
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::never::NeverSessionManager,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

use crate::api::Board;
use crate::server::debug;
use crate::token::{self, Source, Token};
use crate::tools::{Projects, ServerOptions};

/// The only path the server answers on.
pub const PATH: &str = "/mcp";

/// The port used when `--port` is not given.
pub const DEFAULT_PORT: u16 = 8765;

type Body = BoxBody<Bytes, Infallible>;

/// The limits that keep one misbehaving client from starving the others. The defaults suit real use; tests shrink them.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Connections served at once; the next ones are refused with `503`.
    pub max_connections: usize,
    /// How long a connection may take to send the headers of a request. It also closes idle keep-alive connections.
    pub header_timeout: Duration,
    /// How long a whole request may take, from its headers to the response.
    pub request_timeout: Duration,
    /// How long a shutdown waits for requests in flight before it stops waiting.
    pub shutdown_grace: Duration,
    /// The largest request body accepted.
    pub max_body_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections: 64,
            header_timeout: Duration::from_secs(30),
            request_timeout: Duration::from_secs(60),
            shutdown_grace: Duration::from_secs(5),
            max_body_bytes: 1 << 20,
        }
    }
}

/// Everything the HTTP server needs to start: the port (0 picks a free one), the secret and the limits.
#[derive(Clone)]
pub struct HttpOptions {
    pub port: u16,
    /// The bearer token every request must carry. Never printed.
    pub token: String,
    pub limits: Limits,
}

impl std::fmt::Debug for HttpOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpOptions")
            .field("port", &self.port)
            .field("token", &"<hidden>")
            .field("limits", &self.limits)
            .finish()
    }
}

impl HttpOptions {
    pub fn new(port: u16, token: &Token) -> Self {
        Self { port, token: token.secret().to_string(), limits: Limits::default() }
    }
}

/// A server that has bound its port but not started answering yet: the caller learns the port (it may have asked for
/// any free one) and can tell the user before serving.
pub struct HttpServer {
    listener: TcpListener,
    options: HttpOptions,
}

impl HttpServer {
    /// Binds `127.0.0.1:<port>`.
    pub async fn bind(options: HttpOptions) -> io::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, options.port))).await?;
        Ok(Self { listener, options })
    }

    pub fn local_addr(&self) -> SocketAddr {
        // A bound listener always has an address.
        self.listener.local_addr().expect("a bound listener has a local address")
    }

    /// The URL clients connect to.
    pub fn url(&self) -> String {
        format!("http://{}{PATH}", self.local_addr())
    }

    /// Serves until `shutdown` resolves, then stops accepting, lets the requests in flight finish (for at most
    /// [`Limits::shutdown_grace`]) and returns.
    pub async fn serve(
        self,
        board: Arc<dyn Board>,
        options: &ServerOptions,
        shutdown: impl Future<Output = ()>,
    ) -> anyhow::Result<()> {
        let Self { listener, options: http } = self;
        let port = listener.local_addr()?.port();
        let state = Arc::new(State::new(board, options, &http, port));
        let permits = Arc::new(Semaphore::new(http.limits.max_connections));
        let graceful = GracefulShutdown::new();
        let mut shutdown = std::pin::pin!(shutdown);

        loop {
            let (stream, _peer) = tokio::select! {
                () = &mut shutdown => break,
                accepted = listener.accept() => match accepted {
                    Ok(connection) => connection,
                    Err(error) => {
                        // Typically "too many open files": back off a moment instead of spinning.
                        debug(format!("accept failed: {error}"));
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                },
            };
            let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
                tokio::spawn(refuse(stream));
                continue;
            };
            let state = Arc::clone(&state);
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(http.limits.header_timeout)
                .keep_alive(true)
                .serve_connection(
                    TokioIo::new(stream),
                    service_fn(move |request| {
                        let state = Arc::clone(&state);
                        async move { Ok::<_, Infallible>(state.respond(request).await) }
                    }),
                );
            let connection = graceful.watch(connection);
            tokio::spawn(async move {
                if let Err(error) = connection.await {
                    debug(format!("connection ended: {error}"));
                }
                drop(permit);
            });
        }

        debug("shutting down: no new connections");
        drop(listener);
        tokio::select! {
            () = graceful.shutdown() => {}
            () = tokio::time::sleep(http.limits.shutdown_grace) => debug("shutdown grace period over: stopping anyway"),
        }
        Ok(())
    }
}

/// Binds and serves in one step.
pub async fn serve_http(
    board: Arc<dyn Board>,
    options: &ServerOptions,
    http: &HttpOptions,
    shutdown: impl Future<Output = ()>,
) -> anyhow::Result<()> {
    HttpServer::bind(http.clone()).await?.serve(board, options, shutdown).await
}

/// What every connection shares.
struct State {
    mcp: StreamableHttpService<Projects, NeverSessionManager>,
    token: String,
    request_timeout: Duration,
}

impl State {
    fn new(board: Arc<dyn Board>, options: &ServerOptions, http: &HttpOptions, port: u16) -> Self {
        let template = Projects::new(board, options);
        let config = StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_max_request_body_bytes(http.limits.max_body_bytes)
            .with_allowed_origins([
                format!("http://127.0.0.1:{port}"),
                format!("http://localhost:{port}"),
                format!("http://[::1]:{port}"),
            ])
            .enforce_origin_validation();
        let mcp =
            StreamableHttpService::new(move || Ok(template.clone()), Arc::new(NeverSessionManager::default()), config);
        Self { mcp, token: http.token.clone(), request_timeout: http.limits.request_timeout }
    }

    /// The pipeline: path, then token, then the protocol layer (Host, Origin, body limit, method, JSON-RPC).
    async fn respond(&self, request: Request<Incoming>) -> Response<Body> {
        if request.uri().path() != PATH {
            return text(StatusCode::NOT_FOUND, "Not found. The MCP endpoint is /mcp.");
        }
        if !self.authorized(&request) {
            let mut response = text(StatusCode::UNAUTHORIZED, "Missing or invalid bearer token.");
            response.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            return response;
        }
        match tokio::time::timeout(self.request_timeout, self.mcp.handle(request)).await {
            Ok(response) => response,
            Err(_) => {
                let mut response = text(StatusCode::REQUEST_TIMEOUT, "The request took too long.");
                response.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("close"));
                response
            }
        }
    }

    fn authorized(&self, request: &Request<Incoming>) -> bool {
        let mut values = Vec::new();
        for value in request.headers().get_all(header::AUTHORIZATION) {
            // A value that is not plain visible text cannot be a token.
            let Ok(text) = value.to_str() else { return false };
            values.push(text);
        }
        token::bearer_matches(&values, &self.token)
    }
}

fn text(status: StatusCode, message: &'static str) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::from_static(message.as_bytes())).boxed());
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Tells a client that arrives when every slot is taken to come back later, and hangs up. Best effort: the client may
/// already be gone, and what it sent is not read.
async fn refuse(mut stream: TcpStream) {
    const RESPONSE: &[u8] = b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 38\r\n\r\nToo many connections. Try again soon.\n";
    let _ = stream.write_all(RESPONSE).await;
    let _ = stream.shutdown().await;
    // Reading what the client already sent keeps the close from turning into a reset that would hide the 503.
    let mut scratch = [0u8; 512];
    let _ = tokio::time::timeout(Duration::from_millis(200), stream.read(&mut scratch)).await;
}

/// Resolves when the user asks the server to stop: Ctrl-C everywhere, and SIGTERM on Unix (what service managers send).
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// What the server tells the user on stderr when it starts: where it listens and how a client connects. A token the
/// user supplied is never repeated; a generated one is shown (this is the only time it can be read).
pub fn banner(url: &str, token: &Token) -> Vec<String> {
    let (credential, note) = match token.source() {
        Source::Supplied => ("<your token>".to_string(), None),
        Source::Generated => (token.secret().to_string(), Some("token (generated for this run only)".to_string())),
        Source::File { path, created } => (
            format!("$(cat {})", path.display()),
            Some(format!("token file {} ({})", path.display(), if *created { "created" } else { "in use" })),
        ),
    };
    let mut lines =
        vec![format!("oprojects-mcp: listening on {url} (Streamable HTTP, this machine only, bearer token required)")];
    if let Some(warning) = token.warning() {
        lines.push(format!("oprojects-mcp: warning: {warning}"));
    }
    if let Some(note) = note {
        let shown =
            if matches!(token.source(), Source::Generated) { format!(": {}", token.secret()) } else { String::new() };
        lines.push(format!("oprojects-mcp: {note}{shown}"));
    }
    lines.push("oprojects-mcp: add it to Claude Code with:".to_string());
    lines.push(format!(
        "  claude mcp add --transport http obsidian-projects {url} --header \"Authorization: Bearer {credential}\""
    ));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const SECRET: &str = "supplied-secret-0123456789";

    #[test]
    fn the_banner_never_repeats_a_supplied_token() {
        let token = Token::supplied(SECRET).unwrap();
        let text = banner("http://127.0.0.1:8765/mcp", &token).join("\n");
        assert!(!text.contains(SECRET), "{text}");
        assert!(text.contains("http://127.0.0.1:8765/mcp"));
        assert!(text.contains("Bearer <your token>"));
        assert!(text.contains("claude mcp add --transport http obsidian-projects http://127.0.0.1:8765/mcp --header"));
    }

    #[test]
    fn the_banner_shows_a_generated_token_once_and_puts_it_in_the_command() {
        let token = Token::generated().unwrap();
        let lines = banner("http://127.0.0.1:1/mcp", &token);
        let text = lines.join("\n");
        assert!(text.contains(&format!("token (generated for this run only): {}", token.secret())));
        assert!(text.contains(&format!("Bearer {}\"", token.secret())));
    }

    #[test]
    fn the_banner_points_at_a_token_file_instead_of_printing_its_content() {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("token");
        let token = token::from_file(&path).unwrap();
        let text = banner("http://127.0.0.1:1/mcp", &token).join("\n");
        assert!(!text.contains(token.secret()), "{text}");
        assert!(text.contains("(created)"));
        assert!(text.contains(&format!("Bearer $(cat {})", path.display())));
        let again = token::from_file(&path).unwrap();
        assert!(banner("http://127.0.0.1:1/mcp", &again).join("\n").contains("(in use)"));
    }

    #[test]
    fn debug_output_hides_the_token() {
        let options = HttpOptions::new(1, &Token::supplied(SECRET).unwrap());
        assert!(!format!("{options:?}").contains(SECRET));
    }

    #[test]
    fn the_default_limits_are_the_documented_ones() {
        let limits = Limits::default();
        assert_eq!(limits.max_connections, 64);
        assert_eq!(limits.max_body_bytes, 1024 * 1024);
        assert_eq!(limits.header_timeout, Duration::from_secs(30));
    }
}
