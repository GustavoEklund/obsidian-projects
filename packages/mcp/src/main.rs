//! `oprojects-mcp`: an MCP server over the cards of an Obsidian vault. See `--help`.
//!
//! In stdio mode stdout belongs to the protocol: this file prints to it only for `--help` and `--version`, which run no
//! server. In HTTP mode (`--http`) nothing goes to stdout at all; the address and how to connect are told on stderr.
use std::process::ExitCode;
use std::sync::Arc;

use oprojects_mcp::api::Board;
use oprojects_mcp::args::{self, Command, HttpArgs, Options};
use oprojects_mcp::config::find_vault_root;
use oprojects_mcp::http::{HttpOptions, HttpServer, banner, shutdown_signal};
use oprojects_mcp::server::{debug, http_runtime, runtime, serve_stdio};
use oprojects_mcp::token;
use oprojects_mcp::tools::ServerOptions;
use oprojects_mcp::vault::{VaultOptions, open_vault};

/// The exit code for a command line the program cannot make sense of.
const USAGE_ERROR: u8 = 2;

fn main() -> ExitCode {
    let env = |name: &str| std::env::var(name).ok();
    match args::parse(std::env::args().skip(1), &env) {
        Ok(Command::Help) => {
            print!("{}", args::usage(env!("CARGO_PKG_VERSION")));
            ExitCode::SUCCESS
        }
        Ok(Command::Version) => {
            println!("oprojects-mcp {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Command::Run(options)) => run(options),
        Ok(Command::Http { options, http }) => run_http(options, http),
        Err(error) => {
            eprintln!("oprojects-mcp: {error}\nTry --help.");
            ExitCode::from(USAGE_ERROR)
        }
    }
}

/// Finds the vault and opens its board. `open_vault` reads the local UTC offset first thing: that is only sound while
/// the process still has a single thread, so nothing may start one before this is called. It then starts the index
/// (its own threads) in the background.
fn open_board(options: &Options) -> Result<Arc<dyn Board>, ExitCode> {
    let start = std::env::current_dir().map_err(|error| fail(format!("cannot read the current folder: {error}")))?;
    let root = find_vault_root(&start, options.vault.as_deref()).map_err(fail)?;
    debug(format!("vault: {}", root.display()));
    let board: Arc<dyn Board> = open_vault(&root, VaultOptions::default()).map_err(fail)?;
    Ok(board)
}

fn run(options: Options) -> ExitCode {
    let board = match open_board(&options) {
        Ok(board) => board,
        Err(code) => return code,
    };
    let runtime = match runtime() {
        Ok(runtime) => runtime,
        Err(error) => return fail(format!("cannot start the async runtime: {error}")),
    };
    let server_options = ServerOptions { read_only: options.read_only, author: options.author };
    match runtime.block_on(serve_stdio(board, &server_options)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => fail(error),
    }
}

fn run_http(options: Options, args: HttpArgs) -> ExitCode {
    let board = match open_board(&options) {
        Ok(board) => board,
        Err(code) => return code,
    };
    let token = match token::resolve(args.token.as_deref(), args.token_file.as_deref()) {
        Ok(token) => token,
        Err(error) => return fail(error),
    };
    let runtime = match http_runtime() {
        Ok(runtime) => runtime,
        Err(error) => return fail(format!("cannot start the async runtime: {error}")),
    };
    let server_options = ServerOptions { read_only: options.read_only, author: options.author };
    let outcome = runtime.block_on(async {
        let server = HttpServer::bind(HttpOptions::new(args.port, &token)).await.map_err(|error| {
            anyhow::anyhow!("cannot listen on 127.0.0.1:{}: {error} (--port 0 picks a free port)", args.port)
        })?;
        // The one thing a healthy HTTP server says: where it is and how to connect to it. Never the token of a user.
        for line in banner(&server.url(), &token) {
            eprintln!("{line}");
        }
        server.serve(board, &server_options, shutdown_signal()).await
    });
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => fail(error),
    }
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("oprojects-mcp: {message}");
    ExitCode::FAILURE
}
