//! The stdio server: stdin and stdout carry the protocol and nothing else. Diagnostics go to stderr, and only when asked
//! for (`OPROJECTS_LOG=debug`); a healthy server is silent.
use std::sync::Arc;
use std::time::Duration;

use rmcp::{ServiceExt, service::ServerInitializeError, transport::stdio};

use crate::api::Board;
use crate::tools::{Projects, ServerOptions};

/// The runtime the server runs on: one thread for the protocol, with timers (the protocol layer needs them, notably to
/// shut down). The blocking pool serves the file I/O of the tools, and the stdin reader holds one of its threads for as
/// long as the server runs, so it keeps a few and lets idle ones go quickly.
pub fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .max_blocking_threads(8)
        .thread_keep_alive(Duration::from_secs(2))
        .build()
}

/// The runtime of the HTTP transport: like [`runtime`], plus the network driver. One thread serves the protocol and
/// the connections (they spend their time waiting), the blocking pool runs the file I/O of the tools.
pub fn http_runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .max_blocking_threads(8)
        .thread_keep_alive(Duration::from_secs(2))
        .build()
}

/// Whether `OPROJECTS_LOG` asks for diagnostics on stderr.
pub fn debug_enabled() -> bool {
    std::env::var("OPROJECTS_LOG").is_ok_and(|v| v.eq_ignore_ascii_case("debug"))
}

/// A diagnostic line on stderr, when enabled. Never stdout: that is the protocol.
pub fn debug(message: impl AsRef<str>) {
    if debug_enabled() {
        eprintln!("oprojects-mcp: {}", message.as_ref());
    }
}

/// Serves `board` over stdin/stdout until the client closes its end. A client that goes away before it ever says hello
/// is not an error: there was simply nothing to serve.
pub async fn serve_stdio(board: Arc<dyn Board>, options: &ServerOptions) -> anyhow::Result<()> {
    debug(format!(
        "serving board {} ({} columns), read-only: {}, comment author: {}",
        board.config().prefix,
        board.config().columns.len(),
        options.read_only,
        options.author
    ));
    match Projects::new(board, options).serve(stdio()).await {
        Ok(running) => {
            let reason = running.waiting().await?;
            debug(format!("the client is gone ({reason:?}): exiting"));
            Ok(())
        }
        Err(
            ServerInitializeError::ConnectionClosed(_)
            | ServerInitializeError::ExpectedInitializeRequest(None)
            | ServerInitializeError::Cancelled,
        ) => {
            debug("the client closed the connection before initializing: exiting");
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}
