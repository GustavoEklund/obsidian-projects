//! The HTTP transport, end to end in process: the real server on a free port of this machine, the board faked, and a
//! hand-written HTTP/1.1 client over raw TCP, so what is checked is exactly the bytes a client would see: status lines,
//! headers, bodies, and what happens to the connection.
mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::fake_board::FakeBoard;
use oprojects_mcp::http::{HttpOptions, HttpServer, Limits, PATH, serve_http};
use oprojects_mcp::token::Token;
use oprojects_mcp::tools::{READ_TOOLS, ServerOptions, WRITE_TOOLS};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

const TOKEN: &str = "test-token-0123456789abcdef0123";

// --- the server under test ------------------------------------------------------------------------------------------

struct Running {
    addr: SocketAddr,
    board: Arc<FakeBoard>,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<anyhow::Result<()>>,
}

impl Running {
    async fn start() -> Self {
        Self::start_with(false, Limits::default()).await
    }

    async fn start_with(read_only: bool, limits: Limits) -> Self {
        let board = FakeBoard::sample();
        let mut http = HttpOptions::new(0, &Token::supplied(TOKEN).unwrap());
        http.limits = limits;
        let server = HttpServer::bind(http).await.expect("binds a free port");
        let addr = server.local_addr();
        let (stop, stopped) = oneshot::channel::<()>();
        let options = ServerOptions { read_only, author: "Claude".into() };
        let served = board.clone();
        let task = tokio::spawn(async move {
            server
                .serve(served, &options, async {
                    let _ = stopped.await;
                })
                .await
        });
        Self { addr, board, stop: Some(stop), task }
    }

    /// Asks the server to stop and waits for it to finish.
    async fn stop(mut self) -> anyhow::Result<()> {
        let _ = self.stop.take().map(|stop| stop.send(()));
        tokio::time::timeout(Duration::from_secs(10), self.task).await.expect("the server stops in time").unwrap()
    }

    async fn client(&self) -> Client {
        Client::connect(self.addr).await
    }

    fn headers(&self) -> Headers {
        Headers::mcp(self.addr)
    }
}

// --- a minimal HTTP/1.1 client --------------------------------------------------------------------------------------

#[derive(Debug)]
struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }
}

/// The headers of a request, easy to bend: `Headers::mcp(addr)` is a valid MCP call, and each test changes the one
/// thing it is about.
#[derive(Clone)]
struct Headers(Vec<(String, String)>);

impl Headers {
    fn mcp(addr: SocketAddr) -> Self {
        Self(vec![
            ("Host".into(), addr.to_string()),
            ("Authorization".into(), format!("Bearer {TOKEN}")),
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "application/json, text/event-stream".into()),
        ])
    }

    fn set(mut self, name: &str, value: impl Into<String>) -> Self {
        self.0.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
        self.0.push((name.into(), value.into()));
        self
    }

    fn add(mut self, name: &str, value: impl Into<String>) -> Self {
        self.0.push((name.into(), value.into()));
        self
    }

    fn without(mut self, name: &str) -> Self {
        self.0.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
        self
    }
}

fn request_bytes(method: &str, path: &str, headers: &Headers, body: &[u8]) -> Vec<u8> {
    let mut out = format!("{method} {path} HTTP/1.1\r\n").into_bytes();
    for (name, value) in &headers.0 {
        out.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
    }
    if !body.is_empty() || method == "POST" {
        out.extend_from_slice(format!("Content-Length: {}\r\n", body.len()).as_bytes());
    }
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(body);
    out
}

fn rpc(id: u64, method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

fn tool_call(id: u64, name: &str, arguments: Value) -> String {
    rpc(id, "tools/call", json!({ "name": name, "arguments": arguments }))
}

struct Client {
    stream: BufReader<TcpStream>,
}

impl Client {
    async fn connect(addr: SocketAddr) -> Self {
        Self { stream: BufReader::new(TcpStream::connect(addr).await.expect("connects")) }
    }

    /// Writes bytes; a server that has already answered and hung up (a refused body, say) makes the write fail, which is
    /// not the client's problem: the answer is still there to read.
    async fn send(&mut self, bytes: &[u8]) {
        let _ = self.stream.get_mut().write_all(bytes).await;
    }

    async fn read(&mut self) -> std::io::Result<Response> {
        self.read_for(false).await
    }

    /// `head` is true for the answer to a HEAD request: it has the headers of a body that is not sent.
    async fn read_for(&mut self, head: bool) -> std::io::Result<Response> {
        tokio::time::timeout(Duration::from_secs(10), read_response(&mut self.stream, head))
            .await
            .unwrap_or_else(|_| Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "no response in 10 s")))
    }

    async fn request(&mut self, method: &str, path: &str, headers: &Headers, body: &[u8]) -> Response {
        self.send(&request_bytes(method, path, headers, body)).await;
        self.read_for(method == "HEAD").await.expect("a response")
    }

    async fn post(&mut self, headers: &Headers, body: &str) -> Response {
        self.request("POST", PATH, headers, body.as_bytes()).await
    }

    /// True when the server closed the connection (end of stream or a reset) within `within`.
    async fn closed_within(&mut self, within: Duration) -> bool {
        let mut byte = [0u8; 1];
        match tokio::time::timeout(within, self.stream.read(&mut byte)).await {
            Err(_) => false,
            Ok(Ok(0)) | Ok(Err(_)) => true,
            Ok(Ok(_)) => false,
        }
    }
}

async fn read_response<R: AsyncBufReadExt + Unpin>(stream: &mut R, head: bool) -> std::io::Result<Response> {
    let eof = || std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the connection closed before a response");
    let mut line = String::new();
    if stream.read_line(&mut line).await? == 0 {
        return Err(eof());
    }
    let status: u16 = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).expect("a status line");
    let mut headers = Vec::new();
    loop {
        line.clear();
        if stream.read_line(&mut line).await? == 0 {
            return Err(eof());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let (name, value) = trimmed.split_once(':').expect("a header line");
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    let find = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
    let mut body = Vec::new();
    if head {
        // No body follows the headers of a HEAD response, whatever they say about its length.
    } else if find("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
        loop {
            line.clear();
            stream.read_line(&mut line).await?;
            let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or("0"), 16).expect("a chunk size");
            if size == 0 {
                line.clear();
                stream.read_line(&mut line).await?; // the empty line after the last chunk
                break;
            }
            let mut chunk = vec![0u8; size];
            stream.read_exact(&mut chunk).await?;
            body.extend_from_slice(&chunk);
            let mut crlf = [0u8; 2];
            stream.read_exact(&mut crlf).await?;
        }
    } else if let Some(length) = find("content-length") {
        body = vec![0u8; length.parse().expect("a content length")];
        stream.read_exact(&mut body).await?;
    } else if !(status == 204 || status == 304 || (100..200).contains(&status)) {
        stream.read_to_end(&mut body).await?;
    }
    Ok(Response { status, headers, body })
}

/// One request on its own connection.
async fn once(running: &Running, method: &str, path: &str, headers: &Headers, body: &str) -> Response {
    running.client().await.request(method, path, headers, body.as_bytes()).await
}

async fn mcp(running: &Running, body: &str) -> Response {
    once(running, "POST", PATH, &running.headers(), body).await
}

fn result_text(response: &Response) -> String {
    response.json()["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
}

// --- authentication ---------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_request_without_a_token_is_refused_with_401_and_says_how_to_authenticate() {
    let running = Running::start().await;
    let response =
        once(&running, "POST", PATH, &running.headers().without("Authorization"), &rpc(1, "tools/list", json!({})))
            .await;
    assert_eq!(response.status, 401);
    assert_eq!(response.header("www-authenticate"), Some("Bearer"));
    assert!(response.text().to_lowercase().contains("bearer token"), "{}", response.text());
    assert_eq!(response.header("cache-control"), Some("no-store"));
    running.stop().await.unwrap();
}

#[tokio::test]
async fn only_the_exact_token_with_the_bearer_scheme_gets_in() {
    let running = Running::start().await;
    let body = rpc(1, "tools/list", json!({}));
    let wrong_but_close = format!("Bearer {}x", TOKEN);
    let prefix = format!("Bearer {}", &TOKEN[..TOKEN.len() - 1]);
    let shifted = format!("Bearer {}", &TOKEN[1..]);
    let refused: [(&str, &str); 12] = [
        ("empty", ""),
        ("scheme only", "Bearer"),
        ("scheme and a space only", "Bearer "),
        ("no scheme", TOKEN),
        ("another scheme", "Basic dXNlcjpwYXNz"),
        ("the token with another scheme", &format!("Token {TOKEN}")),
        ("a wrong token", "Bearer not-the-token-at-all-0123456789"),
        ("a short token", "Bearer abc"),
        ("the token and one more character", &wrong_but_close),
        ("the token without its last character", &prefix),
        ("the token without its first character", &shifted),
        ("no space after the scheme", &format!("Bearer{TOKEN}")),
    ];
    for (name, value) in refused {
        let response = once(&running, "POST", PATH, &running.headers().set("Authorization", value), &body).await;
        assert_eq!(response.status, 401, "{name}: {}", response.text());
        assert!(!response.text().contains(TOKEN), "{name}: the token must never be echoed");
    }
    // The scheme is case-insensitive; the token is not.
    for scheme in ["Bearer", "bearer", "BEARER", "bEaReR"] {
        let ok =
            once(&running, "POST", PATH, &running.headers().set("Authorization", format!("{scheme} {TOKEN}")), &body)
                .await;
        assert_eq!(ok.status, 200, "{scheme}");
    }
    let upper = once(
        &running,
        "POST",
        PATH,
        &running.headers().set("Authorization", format!("Bearer {}", TOKEN.to_uppercase())),
        &body,
    )
    .await;
    assert_eq!(upper.status, 401, "the token is case-sensitive");
    running.stop().await.unwrap();
}

#[tokio::test]
async fn two_authorization_headers_are_refused_even_when_one_is_right() {
    let running = Running::start().await;
    let headers = running.headers().add("Authorization", "Bearer something-else-entirely-0000");
    let response = once(&running, "POST", PATH, &headers, &rpc(1, "tools/list", json!({}))).await;
    assert_eq!(response.status, 401);
    running.stop().await.unwrap();
}

#[tokio::test]
async fn an_authorization_header_that_is_not_plain_text_is_refused() {
    let running = Running::start().await;
    let mut raw = request_bytes("POST", PATH, &running.headers().without("Authorization"), b"{}");
    let at = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 2;
    let mut bad = b"Authorization: Bearer \xff\xfe\r\n".to_vec();
    let tail = raw.split_off(at);
    raw.append(&mut bad);
    raw.extend_from_slice(&tail);
    let mut client = running.client().await;
    client.send(&raw).await;
    let response = client.read().await.expect("a response");
    assert_eq!(response.status, 401);
    running.stop().await.unwrap();
}

#[tokio::test]
async fn the_token_is_checked_before_anything_else_about_the_request() {
    let running = Running::start().await;
    // Wrong Host, foreign Origin and a garbage body: still 401, not 403 or 400, so nothing else about a request is
    // revealed to someone without the token.
    let headers = running
        .headers()
        .without("Authorization")
        .set("Host", "evil.example.com")
        .set("Origin", "http://evil.example.com");
    let response = once(&running, "POST", PATH, &headers, "this is not json").await;
    assert_eq!(response.status, 401);
    running.stop().await.unwrap();
}

// --- routing and methods ----------------------------------------------------------------------------------------------

#[tokio::test]
async fn only_the_mcp_path_exists() {
    let running = Running::start().await;
    for path in ["/", "/mcp/", "/mcp/x", "/MCP", "/other", "/mcp.json", "//mcp", "/api/mcp"] {
        let response = once(&running, "POST", path, &running.headers(), &rpc(1, "tools/list", json!({}))).await;
        assert_eq!(response.status, 404, "{path}");
    }
    // The path comes first: even without a token an unknown path is a 404, a known one a 401.
    let nowhere = once(&running, "GET", "/nowhere", &running.headers().without("Authorization"), "").await;
    assert_eq!(nowhere.status, 404);
    running.stop().await.unwrap();
}

#[tokio::test]
async fn a_query_string_does_not_change_the_path() {
    let running = Running::start().await;
    let response =
        once(&running, "POST", "/mcp?client=test&x=1", &running.headers(), &rpc(1, "tools/list", json!({}))).await;
    assert_eq!(response.status, 200);
    running.stop().await.unwrap();
}

#[tokio::test]
async fn every_method_but_post_is_refused_and_the_server_says_what_it_allows() {
    let running = Running::start().await;
    for method in ["GET", "DELETE", "PUT", "PATCH", "OPTIONS", "HEAD"] {
        let response = once(&running, method, PATH, &running.headers(), "").await;
        assert_eq!(response.status, 405, "{method}");
        assert_eq!(response.header("allow"), Some("POST"), "{method}");
    }
    // Without the token a GET is a 401: the token comes before the method.
    let response = once(&running, "GET", PATH, &running.headers().without("Authorization"), "").await;
    assert_eq!(response.status, 401);
    running.stop().await.unwrap();
}

// --- DNS rebinding: Host and Origin ----------------------------------------------------------------------------------

#[tokio::test]
async fn a_host_that_is_not_this_machine_is_refused() {
    let running = Running::start().await;
    let body = rpc(1, "tools/list", json!({}));
    for host in [
        "evil.example.com",
        "evil.example.com:80",
        "127.0.0.1.evil.example.com",
        "localhost.evil.example.com",
        "192.168.1.5",
        "0.0.0.0",
    ] {
        let response = once(&running, "POST", PATH, &running.headers().set("Host", host), &body).await;
        assert_eq!(response.status, 403, "Host: {host}");
    }
    let port = running.addr.port();
    for host in
        [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("LOCALHOST:{port}"), format!("[::1]:{port}")]
    {
        let response = once(&running, "POST", PATH, &running.headers().set("Host", host.clone()), &body).await;
        assert_eq!(response.status, 200, "Host: {host}");
    }
    running.stop().await.unwrap();
}

#[tokio::test]
async fn a_browser_origin_that_is_not_this_server_is_refused() {
    let running = Running::start().await;
    let body = rpc(1, "tools/list", json!({}));
    let port = running.addr.port();
    for origin in [
        "http://evil.example.com".to_string(),
        "https://evil.example.com".to_string(),
        "http://127.0.0.1:1".to_string(),
        format!("http://127.0.0.1.evil.example.com:{port}"),
        format!("https://127.0.0.1:{port}"),
        "null".to_string(),
    ] {
        let response = once(&running, "POST", PATH, &running.headers().set("Origin", origin.clone()), &body).await;
        assert_eq!(response.status, 403, "Origin: {origin}");
    }
    for origin in [format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")] {
        let response = once(&running, "POST", PATH, &running.headers().set("Origin", origin.clone()), &body).await;
        assert_eq!(response.status, 200, "Origin: {origin}");
    }
    // Programs (every MCP client that is not a browser) send no Origin at all.
    assert_eq!(mcp(&running, &body).await.status, 200);
    running.stop().await.unwrap();
}

// --- the protocol over HTTP -------------------------------------------------------------------------------------------

#[tokio::test]
async fn initialize_answers_in_json_with_the_server_and_its_instructions() {
    let running = Running::start().await;
    let params = json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "http-test", "version": "0" } });
    let response = mcp(&running, &rpc(1, "initialize", params)).await;
    assert_eq!(response.status, 200);
    assert!(
        response.header("content-type").is_some_and(|v| v.starts_with("application/json")),
        "{:?}",
        response.headers
    );
    let body = response.json();
    assert_eq!(body["id"], 1);
    assert_eq!(body["result"]["serverInfo"]["name"], "oprojects-mcp");
    assert!(body["result"]["instructions"].as_str().unwrap().contains("OP-12"));
    assert!(body["result"]["capabilities"]["tools"].is_object());
    assert!(response.header("mcp-session-id").is_none(), "the server is stateless: no session is created");
    running.stop().await.unwrap();
}

#[tokio::test]
async fn tools_list_has_the_ten_tools_and_read_only_mode_leaves_three() {
    let running = Running::start().await;
    let names = |response: &Response| -> Vec<String> {
        let mut names: Vec<String> = response.json()["result"]["tools"]
            .as_array()
            .expect("a tools array")
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        names.sort();
        names
    };
    let mut all: Vec<String> = READ_TOOLS.iter().chain(WRITE_TOOLS.iter()).map(|s| s.to_string()).collect();
    all.sort();
    assert_eq!(names(&mcp(&running, &rpc(1, "tools/list", json!({}))).await), all);
    running.stop().await.unwrap();

    let read_only = Running::start_with(true, Limits::default()).await;
    let mut reads: Vec<String> = READ_TOOLS.iter().map(|s| s.to_string()).collect();
    reads.sort();
    assert_eq!(names(&mcp(&read_only, &rpc(1, "tools/list", json!({}))).await), reads);
    read_only.stop().await.unwrap();
}

#[tokio::test]
async fn a_tool_call_returns_the_text_of_the_tool() {
    let running = Running::start().await;
    let response = mcp(&running, &tool_call(7, "board_summary", json!({}))).await;
    assert_eq!(response.status, 200);
    assert_eq!(response.json()["id"], 7);
    let text = result_text(&response);
    assert!(text.contains("Board OP"), "{text}");
    assert!(text.contains("todo"), "{text}");
    running.stop().await.unwrap();
}

#[tokio::test]
async fn a_board_error_is_a_tool_result_flagged_as_an_error_and_not_a_protocol_error() {
    let running = Running::start().await;
    let response = mcp(&running, &tool_call(2, "get_card", json!({ "key": "OP-999" }))).await;
    assert_eq!(response.status, 200);
    let body = response.json();
    assert!(body.get("error").is_none(), "{body}");
    assert_eq!(body["result"]["isError"], true);
    assert!(result_text(&response).contains("OP-999"), "{}", result_text(&response));
    running.stop().await.unwrap();
}

#[tokio::test]
async fn an_unknown_tool_and_an_unknown_method_are_protocol_errors() {
    let running = Running::start().await;
    let unknown_tool = mcp(&running, &tool_call(3, "does_not_exist", json!({}))).await;
    assert!(unknown_tool.json().get("error").is_some(), "{}", unknown_tool.text());
    let unknown_method = mcp(&running, &rpc(4, "no/such/method", json!({}))).await;
    assert!(unknown_method.json().get("error").is_some(), "{}", unknown_method.text());
    running.stop().await.unwrap();
}

#[tokio::test]
async fn write_tools_change_the_board_over_http() {
    let running = Running::start().await;
    let before = running.board.cards().len();
    let response = mcp(&running, &tool_call(1, "create_card", json!({ "title": "From HTTP" }))).await;
    assert_ne!(response.json()["result"]["isError"], json!(true), "{}", response.text());
    assert!(result_text(&response).starts_with("Created:"), "{}", response.text());
    assert_eq!(running.board.cards().len(), before + 1);
    assert!(running.board.cards().iter().any(|c| c.title == "From HTTP"));
    running.stop().await.unwrap();
}

#[tokio::test]
async fn read_only_mode_refuses_every_write_tool_and_touches_nothing() {
    let running = Running::start_with(true, Limits::default()).await;
    let before = running.board.cards();
    let writes = [
        ("create_card", json!({ "title": "no" })),
        ("update_card", json!({ "key": "OP-1", "title": "no" })),
        ("move_card", json!({ "key": "OP-1", "column": "done" })),
        ("delete_card", json!({ "key": "OP-1" })),
        ("add_comment", json!({ "key": "OP-1", "text": "no" })),
        ("edit_comment", json!({ "key": "OP-2", "comment_id": "c1", "text": "no" })),
        ("delete_comment", json!({ "key": "OP-2", "comment_id": "c1" })),
    ];
    for (tool, arguments) in writes {
        let response = mcp(&running, &tool_call(1, tool, arguments)).await;
        assert!(response.json().get("error").is_some(), "{tool} must not exist in read-only mode: {}", response.text());
    }
    assert_eq!(running.board.cards(), before);
    assert!(
        running.board.call_log().iter().all(|c| !c.starts_with("create") && !c.starts_with("delete")),
        "{:?}",
        running.board.call_log()
    );
    // The reads still work.
    assert!(result_text(&mcp(&running, &tool_call(2, "board_summary", json!({}))).await).contains("Board OP"));
    running.stop().await.unwrap();
}

#[tokio::test]
async fn the_comment_author_given_at_startup_signs_comments_over_http_too() {
    let running = Running::start().await;
    mcp(&running, &tool_call(1, "add_comment", json!({ "key": "OP-1", "text": "Seen over HTTP" }))).await;
    let comment = running.board.last_comment.lock().unwrap().clone().expect("the board got a comment");
    assert_eq!(comment.author.as_deref(), Some("Claude"));
    running.stop().await.unwrap();
}

// --- bad requests ------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_body_that_is_not_json_is_a_client_error_and_the_server_carries_on() {
    let running = Running::start().await;
    for garbage in ["this is not json", "{", "[1,2", "", "{\"jsonrpc\":\"2.0\"}", "null"] {
        let response = mcp(&running, garbage).await;
        assert!((400..500).contains(&response.status), "{garbage:?} -> {}", response.status);
    }
    assert_eq!(mcp(&running, &rpc(1, "tools/list", json!({}))).await.status, 200);
    running.stop().await.unwrap();
}

#[tokio::test]
async fn a_request_must_say_it_sends_and_accepts_json() {
    let running = Running::start().await;
    let body = rpc(1, "tools/list", json!({}));
    let no_accept = once(&running, "POST", PATH, &running.headers().without("Accept"), &body).await;
    assert!((400..500).contains(&no_accept.status), "{}", no_accept.status);
    let plain = once(&running, "POST", PATH, &running.headers().set("Content-Type", "text/plain"), &body).await;
    assert!((400..500).contains(&plain.status), "{}", plain.status);
    assert_eq!(mcp(&running, &body).await.status, 200);
    running.stop().await.unwrap();
}

#[tokio::test]
async fn a_body_over_the_limit_is_refused_with_413() {
    let limits = Limits { max_body_bytes: 1024, ..Limits::default() };
    let running = Running::start_with(false, limits).await;
    let small = tool_call(1, "board_summary", json!({}));
    assert_eq!(mcp(&running, &small).await.status, 200);
    let padded = format!("{small}{}", " ".repeat(2000));
    let response = mcp(&running, &padded).await;
    assert_eq!(response.status, 413, "{}", response.text());
    assert_eq!(mcp(&running, &small).await.status, 200, "the server is fine afterwards");
    running.stop().await.unwrap();
}

#[tokio::test]
async fn the_default_limit_is_one_mebibyte() {
    let running = Running::start().await;
    let small = tool_call(1, "board_summary", json!({}));
    let just_under = format!("{small}{}", " ".repeat((1 << 20) - small.len() - 1));
    assert_eq!(mcp(&running, &just_under).await.status, 200);
    let over = format!("{small}{}", " ".repeat((1 << 20) + 1));
    assert_eq!(mcp(&running, &over).await.status, 413);
    running.stop().await.unwrap();
}

// --- connections -------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn one_connection_serves_many_requests() {
    let running = Running::start().await;
    let mut client = running.client().await;
    for id in 0..40 {
        let response = client.post(&running.headers(), &tool_call(id, "board_summary", json!({}))).await;
        assert_eq!(response.status, 200, "request {id}");
        assert_eq!(response.json()["id"], id);
    }
    running.stop().await.unwrap();
}

#[tokio::test]
async fn a_refused_request_does_not_poison_the_connection_it_came_on() {
    let running = Running::start().await;
    let mut client = running.client().await;
    let refused = client.post(&running.headers().without("Authorization"), "{}").await;
    assert_eq!(refused.status, 401);
    let ok = client.post(&running.headers(), &tool_call(1, "board_summary", json!({}))).await;
    assert_eq!(ok.status, 200, "the same connection is still good");
    let missing = client.request("POST", "/missing", &running.headers(), b"{}").await;
    assert_eq!(missing.status, 404);
    assert_eq!(client.post(&running.headers(), &tool_call(2, "board_summary", json!({}))).await.status, 200);
    running.stop().await.unwrap();
}

#[tokio::test]
async fn fifty_clients_at_once_all_get_their_own_answers() {
    let running = Arc::new(Running::start().await);
    let mut tasks = Vec::new();
    for client_no in 0..50u64 {
        let running = Arc::clone(&running);
        tasks.push(tokio::spawn(async move {
            let mut client = running.client().await;
            for n in 0..5u64 {
                let id = client_no * 100 + n;
                let response = client.post(&running.headers(), &tool_call(id, "board_summary", json!({}))).await;
                assert_eq!(response.status, 200);
                assert_eq!(response.json()["id"], id, "an answer must go to the client that asked");
            }
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    Arc::into_inner(running).expect("no other owner").stop().await.unwrap();
}

#[tokio::test]
async fn concurrent_writes_from_many_clients_all_land() {
    let running = Arc::new(Running::start().await);
    let before = running.board.cards().len();
    let mut tasks = Vec::new();
    for n in 0..20u64 {
        let running = Arc::clone(&running);
        tasks.push(tokio::spawn(async move {
            let response =
                mcp(&running, &tool_call(n, "create_card", json!({ "title": format!("Parallel {n}") }))).await;
            assert_eq!(response.status, 200);
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    assert_eq!(running.board.cards().len(), before + 20);
    Arc::into_inner(running).expect("no other owner").stop().await.unwrap();
}

#[tokio::test]
async fn connections_over_the_cap_are_told_503_and_the_slot_comes_back_when_one_closes() {
    let limits = Limits { max_connections: 3, ..Limits::default() };
    let running = Running::start_with(false, limits).await;
    let mut held = Vec::new();
    for _ in 0..3 {
        let mut client = running.client().await;
        // A request makes sure the server has accepted the connection and given it a slot.
        assert_eq!(client.post(&running.headers(), &tool_call(1, "board_summary", json!({}))).await.status, 200);
        held.push(client);
    }
    let mut extra = running.client().await;
    let response = extra.post(&running.headers(), &tool_call(1, "board_summary", json!({}))).await;
    assert_eq!(response.status, 503);
    assert_eq!(response.header("retry-after"), Some("1"));

    drop(held.pop());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut again = running.client().await;
        again
            .send(&request_bytes("POST", PATH, &running.headers(), tool_call(2, "board_summary", json!({})).as_bytes()))
            .await;
        match again.read().await {
            Ok(r) if r.status == 200 => break,
            _ => assert!(Instant::now() < deadline, "the freed slot never came back"),
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    running.stop().await.unwrap();
}

#[tokio::test]
async fn a_client_that_dribbles_its_headers_is_cut_off() {
    let limits = Limits { header_timeout: Duration::from_millis(300), ..Limits::default() };
    let running = Running::start_with(false, limits).await;
    let mut slow = running.client().await;
    slow.send(b"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: ").await; // and then nothing
    assert!(slow.closed_within(Duration::from_secs(5)).await, "a stalled client must not hold a slot for ever");
    // Meanwhile the server serves everybody else.
    assert_eq!(mcp(&running, &rpc(1, "tools/list", json!({}))).await.status, 200);
    running.stop().await.unwrap();
}

#[tokio::test]
async fn an_idle_keep_alive_connection_is_closed() {
    let limits = Limits { header_timeout: Duration::from_millis(300), ..Limits::default() };
    let running = Running::start_with(false, limits).await;
    let mut client = running.client().await;
    assert_eq!(client.post(&running.headers(), &tool_call(1, "board_summary", json!({}))).await.status, 200);
    assert!(client.closed_within(Duration::from_secs(5)).await, "an idle connection must not hold a slot for ever");
    running.stop().await.unwrap();
}

#[tokio::test]
async fn a_request_whose_body_never_arrives_gets_408() {
    let limits = Limits { request_timeout: Duration::from_millis(300), ..Limits::default() };
    let running = Running::start_with(false, limits).await;
    let mut client = running.client().await;
    let headers = running.headers().add("Content-Length", "500");
    let mut head = format!("POST {PATH} HTTP/1.1\r\n").into_bytes();
    for (name, value) in &headers.0 {
        head.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());
    }
    head.extend_from_slice(b"\r\n{\"jsonrpc\":"); // 13 of the promised 500 bytes
    client.send(&head).await;
    let response = client.read().await.expect("a response");
    assert_eq!(response.status, 408);
    assert_eq!(response.header("connection"), Some("close"));
    running.stop().await.unwrap();
}

// --- shutdown ----------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn shutdown_stops_accepting_and_returns_promptly_with_idle_connections_open() {
    let running = Running::start().await;
    let addr = running.addr;
    let mut idle = running.client().await;
    assert_eq!(idle.post(&running.headers(), &tool_call(1, "board_summary", json!({}))).await.status, 200);

    let started = Instant::now();
    running.stop().await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(3), "shutdown took {:?}", started.elapsed());
    assert!(idle.closed_within(Duration::from_secs(3)).await, "the idle connection is closed by the shutdown");
    assert!(TcpStream::connect(addr).await.is_err(), "nothing listens any more");
}

#[tokio::test]
async fn shutdown_does_not_wait_for_ever_for_a_connection_that_is_stuck() {
    let limits = Limits {
        header_timeout: Duration::from_secs(60),
        shutdown_grace: Duration::from_millis(300),
        ..Limits::default()
    };
    let running = Running::start_with(false, limits).await;
    let mut stuck = running.client().await;
    stuck.send(b"POST /mcp HTTP/1.1\r\nHost: x\r\nX-Never: finished").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let started = Instant::now();
    running.stop().await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(3), "shutdown took {:?}", started.elapsed());
}

#[tokio::test]
async fn requests_are_answered_until_shutdown_begins() {
    let running = Running::start().await;
    for id in 0..5 {
        assert_eq!(mcp(&running, &tool_call(id, "board_summary", json!({}))).await.status, 200);
    }
    running.stop().await.unwrap();
}

// --- binding ------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn port_zero_picks_a_free_port_on_the_loopback_interface_only() {
    let running = Running::start().await;
    assert!(running.addr.ip().is_loopback());
    assert_ne!(running.addr.port(), 0);
    let other = Running::start().await;
    assert_ne!(other.addr.port(), running.addr.port());
    running.stop().await.unwrap();
    other.stop().await.unwrap();
}

#[tokio::test]
async fn a_port_in_use_is_an_error_not_a_panic() {
    let running = Running::start().await;
    let http = HttpOptions::new(running.addr.port(), &Token::supplied(TOKEN).unwrap());
    let error = HttpServer::bind(http).await.err().expect("the port is taken");
    assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
    running.stop().await.unwrap();
}

#[tokio::test]
async fn serve_http_binds_and_serves_in_one_step() {
    let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let http = HttpOptions::new(port, &Token::supplied(TOKEN).unwrap());
    let (stop, stopped) = oneshot::channel::<()>();
    let board: Arc<dyn oprojects_mcp::api::Board> = FakeBoard::sample();
    let options = ServerOptions { read_only: false, author: "Claude".into() };
    let task = tokio::spawn(async move {
        serve_http(board, &options, &http, async {
            let _ = stopped.await;
        })
        .await
    });
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut response = None;
    for _ in 0..100 {
        if let Ok(stream) = TcpStream::connect(addr).await {
            let mut client = Client { stream: BufReader::new(stream) };
            response = Some(client.post(&Headers::mcp(addr), &tool_call(1, "board_summary", json!({}))).await);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(response.expect("the server came up").status, 200);
    let _ = stop.send(());
    task.await.unwrap().unwrap();
}

// --- nothing leaks -----------------------------------------------------------------------------------------------------

#[tokio::test]
async fn no_response_ever_contains_the_token() {
    let running = Running::start().await;
    let attempts = [
        once(&running, "POST", PATH, &running.headers().without("Authorization"), "{}").await,
        once(&running, "POST", PATH, &running.headers().set("Authorization", format!("Bearer {TOKEN}x")), "{}").await,
        once(&running, "GET", PATH, &running.headers(), "").await,
        once(&running, "POST", "/nope", &running.headers(), "{}").await,
        mcp(&running, "garbage").await,
        mcp(&running, &tool_call(1, "get_card", json!({ "key": "nope" }))).await,
    ];
    for response in attempts {
        assert!(!response.text().contains(TOKEN), "{}", response.text());
        assert!(response.headers.iter().all(|(_, v)| !v.contains(TOKEN)), "{:?}", response.headers);
    }
    running.stop().await.unwrap();
}
