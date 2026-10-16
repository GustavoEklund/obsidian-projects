//! `oprojects`, the command line: a thin shell over [`CardService`](crate::service::CardService), like the TypeScript one
//! it replaces (`packages/cli`). [`run`] takes the arguments and an [`Io`] (the terminal, the environment, the clock)
//! and returns the exit code, so every behavior can be tested without starting a process; `src/bin/oprojects.rs` builds
//! the real `Io`.
mod commands;
mod json;
mod parse;
mod render;

use crate::config::find_vault_root;
use crate::error::Error;
use crate::query::Now;
use crate::service::{Clock, IdGenerator, ServiceOptions, random_id};
use crate::storage::FsStorage;
use commands::{COMMANDS, Command, Ctx, Failure, find_command};
use render::{Painter, Style};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// What the command line talks to. Tests replace every part of it.
pub struct Io<'a> {
    pub cwd: PathBuf,
    /// The value of an environment variable.
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub out: &'a mut dyn Write,
    pub err: &'a mut dyn Write,
    /// Everything on standard input. Only called when a command asks for it (`--body -`).
    pub read_stdin: &'a mut dyn FnMut() -> std::io::Result<String>,
    /// Hands a URL to the system. Only called by `open`.
    pub open_url: &'a mut dyn FnMut(&str) -> std::io::Result<()>,
    /// Is standard output a terminal? Colors are on for a terminal (or with `FORCE_COLOR`).
    pub is_tty: bool,
    /// The width of the terminal.
    pub columns: i64,
    /// Milliseconds since the epoch.
    pub clock: Clock,
    /// The local time zone's offset east of UTC, in minutes.
    pub utc_offset_minutes: i32,
    /// Comment ids; random ones when `None`.
    pub new_id: Option<IdGenerator>,
}

impl Io<'_> {
    fn write_out(&mut self, text: &str) {
        // A closed pipe (`oprojects list | head`) is not an error worth reporting.
        let _ = self.out.write_all(text.as_bytes());
    }

    fn write_err(&mut self, text: &str) {
        let _ = self.err.write_all(text.as_bytes());
    }

    fn env_set(&self, name: &str) -> bool {
        (self.env)(name).is_some_and(|v| !v.is_empty())
    }
}

/// Lets `--vault`, `--json` and `--no-color` appear anywhere before a `--`, including before the command.
fn hoist_globals(argv: &[String]) -> Vec<String> {
    let mut globals: Vec<String> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < argv.len() && argv[i] != "--" {
        let arg = &argv[i];
        if arg == "--vault" {
            globals.push(arg.clone());
            if i + 1 < argv.len() {
                i += 1;
                globals.push(argv[i].clone());
            }
        } else if arg.starts_with("--vault=") || arg == "--json" || arg == "--no-color" {
            globals.push(arg.clone());
        } else {
            rest.push(arg.clone());
        }
        i += 1;
    }
    // The globals go in front of the `--` terminator; whatever follows it is literal (a title may start with a dash).
    rest.extend(globals);
    rest.extend(argv[i..].iter().cloned());
    rest
}

fn top_help(paint: Painter) -> String {
    let mut lines = vec![
        format!("{} {VERSION} — Jira-style cards for your Obsidian vault", paint.paint(Style::Bold, "oprojects")),
        String::new(),
        paint.paint(Style::Bold, "Usage"),
        "  oprojects <command> [options]".to_string(),
        String::new(),
        paint.paint(Style::Bold, "Commands"),
    ];
    for command in COMMANDS {
        lines.push(format!("  {} {}", paint.paint(Style::Bold, &format!("{:<8}", command.name)), command.summary));
    }
    lines.extend([
        String::new(),
        paint.paint(Style::Bold, "Global options"),
        "  --vault <path>   Vault to use (default: $OPROJECTS_VAULT, else nearest parent with .obsidian)".to_string(),
        "  --json           Machine-readable output".to_string(),
        "  --no-color       Disable colors (also honors NO_COLOR)".to_string(),
        "  -h, --help       Help for a command".to_string(),
        String::new(),
        format!("Run {} for details.", paint.paint(Style::Cyan, "oprojects <command> --help")),
    ]);
    lines.join("\n")
}

fn command_help(command: &Command, paint: Painter) -> String {
    let mut lines = vec![
        format!("{} — {}", paint.paint(Style::Bold, command.name), command.summary),
        String::new(),
        paint.paint(Style::Bold, "Usage"),
        format!("  {}", command.usage),
    ];
    if !command.examples.is_empty() {
        lines.push(String::new());
        lines.push(paint.paint(Style::Bold, "Examples"));
        lines.extend(command.examples.iter().map(|e| format!("  {e}")));
    }
    lines.extend([
        String::new(),
        paint.paint(Style::Bold, "Global options"),
        "  --vault <path>  --json  --no-color  -h/--help".to_string(),
    ]);
    lines.join("\n")
}

/// Runs one command line (without the program name) and returns the exit code: 0 on success, 1 when the command could
/// not do what it was asked, 2 when the command line itself is wrong.
pub fn run(raw_args: &[String], io: &mut Io) -> i32 {
    let argv = hoist_globals(raw_args);
    let color =
        (io.is_tty || io.env_set("FORCE_COLOR")) && !io.env_set("NO_COLOR") && !argv.iter().any(|a| a == "--no-color");
    let paint = Painter { enabled: color };

    let first = argv.first().map_or("", String::as_str);
    if first.is_empty() || first == "help" || first == "--help" || first == "-h" {
        let target = if first == "help" { find_command(argv.get(1).map_or("", String::as_str)) } else { None };
        let text = match target {
            Some(command) => command_help(command, paint),
            None => top_help(paint),
        };
        io.write_out(&(text + "\n"));
        return 0;
    }
    if first == "--version" || first == "-v" {
        io.write_out(&format!("{VERSION}\n"));
        return 0;
    }
    let Some(command) = find_command(first) else {
        io.write_err(&format!(
            "{} unknown command \"{first}\". Run `oprojects --help`.\n",
            paint.paint(Style::Red, "error:")
        ));
        return 2;
    };

    let mut json = false;
    let outcome = (|| -> Result<(), Failure> {
        let options = command.all_options();
        let parsed = parse::parse(&argv[1..], &options).map_err(Failure::Usage)?;
        json = parsed.flag("json");
        if parsed.flag("help") {
            io.write_out(&(command_help(command, paint) + "\n"));
            return Ok(());
        }
        let explicit = parsed.text("vault").map(str::to_string).or_else(|| (io.env)("OPROJECTS_VAULT"));
        let root = find_vault_root(&io.cwd, explicit.as_deref())?;
        let config = crate::config::load_board_config(&root);
        let options = ServiceOptions {
            clock: Arc::clone(&io.clock),
            new_id: io.new_id.clone().unwrap_or_else(|| Arc::new(random_id)),
            source: None,
            utc_offset_minutes: io.utc_offset_minutes,
        };
        let svc = crate::service::CardService::new(Arc::new(FsStorage::new(&root)), config.clone(), options);
        let now = Now::from_utc_offset((io.clock)(), io.utc_offset_minutes);
        let mut ctx = Ctx { io, root, config, svc, paint: Painter { enabled: color && !json }, json, now };
        (command.run)(&mut ctx, &parsed)
    })();

    match outcome {
        Ok(()) => 0,
        Err(Failure::Usage(message)) => {
            io.write_err(&format!(
                "{} {message}\n{}\n",
                paint.paint(Style::Red, "error:"),
                paint.paint(Style::Gray, &format!("See: oprojects {} --help", command.name))
            ));
            2
        }
        Err(Failure::Domain(error)) => {
            let known =
                matches!(error, Error::Validation(_) | Error::NotFound(_) | Error::VaultNotFound(_) | Error::Config(_));
            let message = error.to_string();
            if known && json {
                io.write_err(&(json::compact(&serde_json::json!({ "error": message })) + "\n"));
            } else {
                io.write_err(&format!("{} {message}\n", paint.paint(Style::Red, "error:")));
            }
            1
        }
        Err(Failure::Other(message)) => {
            io.write_err(&format!("{} {message}\n", paint.paint(Style::Red, "error:")));
            1
        }
    }
}
