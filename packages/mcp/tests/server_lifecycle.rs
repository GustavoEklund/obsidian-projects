//! The server's whole life on the runtime `main` really uses (not the one `#[tokio::test]` builds, which enables every
//! driver and would hide a missing one): serve, answer, and shut down when the client goes away. A runtime without timers
//! made every client disconnect abort the process once.
mod common;

use std::time::Duration;

use common::fake_board::FakeBoard;
use oprojects_mcp::server::runtime;
use oprojects_mcp::tools::{Projects, ServerOptions};
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;

fn options() -> ServerOptions {
    ServerOptions { read_only: false, author: "Claude".into() }
}

#[test]
fn serving_and_disconnecting_on_the_real_runtime_does_not_panic() {
    runtime().expect("the runtime starts").block_on(async {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let server = Projects::new(FakeBoard::sample(), &options());
        let task = tokio::spawn(async move { server.serve(server_io).await.unwrap().waiting().await });
        let client = ().serve(client_io).await.unwrap();
        let tools = client.list_all_tools().await.unwrap();
        assert_eq!(tools.len(), 10);
        let result = client.call_tool(CallToolRequestParams::new("board_summary")).await.unwrap();
        assert_eq!(result.is_error, Some(false));
        drop(client);
        let outcome = tokio::time::timeout(Duration::from_secs(5), task).await.expect("the server stops").unwrap();
        assert!(outcome.is_ok());
    });
}

#[test]
fn a_client_that_never_says_hello_does_not_hang_or_panic_the_server() {
    runtime().expect("the runtime starts").block_on(async {
        let (client_io, server_io) = tokio::io::duplex(1024);
        let server = Projects::new(FakeBoard::sample(), &options());
        let task = tokio::spawn(async move { server.serve(server_io).await.map(|_| ()) });
        drop(client_io);
        let outcome = tokio::time::timeout(Duration::from_secs(5), task).await.expect("the server gives up").unwrap();
        assert!(outcome.is_err(), "initialization cannot succeed without a client");
    });
}

#[test]
fn blocking_work_still_runs_when_the_pool_is_busy_with_a_stdin_reader() {
    // `main` keeps one blocking thread parked on stdin for as long as it runs; tool calls need the pool too.
    runtime().expect("the runtime starts").block_on(async {
        let parked = tokio::task::spawn_blocking(|| std::thread::sleep(Duration::from_millis(400)));
        let sum = tokio::task::spawn_blocking(|| 2 + 2).await.unwrap();
        assert_eq!(sum, 4);
        parked.await.unwrap();
    });
}
