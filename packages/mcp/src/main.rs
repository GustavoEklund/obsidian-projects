//! `oprojects-mcp`: an MCP server over the cards of an Obsidian vault. See `--help`.
//!
//! In stdio mode stdout belongs to the protocol: this file prints to it only for `--help` and `--version`, which run no
//! server, and for `watch`, which runs none either: there stdout is the stream of updates. In HTTP mode (`--http`)
//! nothing goes to stdout at all; the address and how to connect are told on stderr.
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use oprojects_mcp::api::Board;
use oprojects_mcp::args::{self, Command, HttpArgs, Options, UpdatesMode};
use oprojects_mcp::channel::Channel;
use oprojects_mcp::config::find_vault_root;
use oprojects_mcp::http::{HttpOptions, HttpServer, banner, shutdown_signal};
use oprojects_mcp::server::{debug, http_runtime, runtime, serve_stdio};
use oprojects_mcp::storage::FsStorage;
use oprojects_mcp::token;
use oprojects_mcp::tools::{ServerOptions, Updates};
use oprojects_mcp::vault::{VaultOptions, open_vault};
use oprojects_mcp::watch::{self, SETTLE, WatchArgs, Watcher};

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
        Ok(Command::Watch(watch)) => run_watch(&watch),
        Err(error) => {
            eprintln!("oprojects-mcp: {error}\nTry --help.");
            ExitCode::from(USAGE_ERROR)
        }
    }
}

/// Finds the vault and opens its board. `open_vault` reads the local UTC offset first thing: that is only sound while
/// the process still has a single thread, so nothing may start one before this is called. It then starts the index
/// (its own threads) in the background.
fn open_board(options: &Options) -> Result<(PathBuf, Arc<dyn Board>), ExitCode> {
    let start = std::env::current_dir().map_err(|error| fail(format!("cannot read the current folder: {error}")))?;
    let root = find_vault_root(&start, options.vault.as_deref()).map_err(fail)?;
    debug(format!("vault: {}", root.display()));
    let board: Arc<dyn Board> = open_vault(&root, VaultOptions::default()).map_err(fail)?;
    Ok((root, board))
}

/// How the agent is to hear about the cards it takes. For `watch` that is the command line it is told to run, which names
/// this very program and vault (the agent's working folder is not the vault's, and the program may not be on a `PATH`).
fn updates_for(options: &Options, root: &Path, board: &Arc<dyn Board>) -> Updates {
    match options.updates {
        UpdatesMode::Off => Updates::Off,
        UpdatesMode::Watch => {
            let program = std::env::current_exe().map_or_else(|_| "oprojects-mcp".into(), |p| p.display().to_string());
            Updates::Watch { command: watch::command_line(&program, root, &options.author) }
        }
        UpdatesMode::Channel => {
            let storage = Arc::new(FsStorage::new(root));
            Updates::Channel(Channel::new(Watcher::new(storage, board.config().clone(), &options.author, SETTLE)))
        }
    }
}

fn run(options: Options) -> ExitCode {
    let (root, board) = match open_board(&options) {
        Ok(opened) => opened,
        Err(code) => return code,
    };
    let updates = updates_for(&options, &root, &board);
    let runtime = match runtime() {
        Ok(runtime) => runtime,
        Err(error) => return fail(format!("cannot start the async runtime: {error}")),
    };
    let server_options = ServerOptions { read_only: options.read_only, author: options.author };
    match runtime.block_on(serve_stdio(board, &server_options, updates)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => fail(error),
    }
}

fn run_http(options: Options, args: HttpArgs) -> ExitCode {
    let (root, board) = match open_board(&options) {
        Ok(opened) => opened,
        Err(code) => return code,
    };
    let updates = updates_for(&options, &root, &board);
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
        let server =
            HttpServer::bind(HttpOptions::new(args.port, &token).with_updates(updates)).await.map_err(|error| {
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

/// `oprojects-mcp watch`: no server and no index, only the notes of the cards that are followed.
fn run_watch(args: &WatchArgs) -> ExitCode {
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => return fail(format!("cannot read the current folder: {error}")),
    };
    match watch::run(args, &cwd, &mut std::io::stdout().lock(), &mut std::io::stderr()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => fail(error),
    }
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("oprojects-mcp: {message}");
    ExitCode::FAILURE
}
