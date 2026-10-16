//! `oprojects`: Jira-style cards for an Obsidian vault, from the command line. See `oprojects --help`.
//!
//! This file only connects [`oprojects_mcp::cli::run`] to the real terminal, environment, clock and operating system.
use std::io::{IsTerminal, Read, Write};
use std::process::{Command, ExitCode, Stdio};
use std::sync::Arc;

use oprojects_mcp::cli::{self, Io};
use oprojects_mcp::jscompat::js_to_number;
use oprojects_mcp::service::{local_utc_offset_minutes, system_clock_ms};

/// The width used when the terminal does not say how wide it is.
const DEFAULT_COLUMNS: i64 = 100;

/// Turns on the escape codes for colors in the Windows console, which does not understand them until asked.
#[cfg(windows)]
fn colors_work() -> bool {
    anstyle_query::windows::enable_ansi_colors().unwrap_or(true)
}

#[cfg(not(windows))]
fn colors_work() -> bool {
    true
}

/// What `process.stdout.columns || Number(env.COLUMNS) || 100` is in the TypeScript.
fn terminal_columns(is_tty: bool, env: &dyn Fn(&str) -> Option<String>) -> i64 {
    if is_tty && let Some((width, _)) = terminal_size::terminal_size() {
        let width = i64::from(width.0);
        if width > 0 {
            return width;
        }
    }
    let from_env = env("COLUMNS").map_or(f64::NAN, |value| js_to_number(&value));
    if from_env.is_finite() && from_env != 0.0 { from_env.floor().max(0.0) as i64 } else { DEFAULT_COLUMNS }
}

fn open_url(url: &str) -> std::io::Result<()> {
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(windows) {
        // Not `cmd /c start`: that would hand the `&` in the URL to a shell.
        ("rundll32", vec!["url.dll,FileProtocolHandler", url])
    } else {
        ("xdg-open", vec![url])
    };
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
        .map_err(|e| std::io::Error::new(e.kind(), format!("could not start {program}: {e}")))
}

fn main() -> ExitCode {
    // First thing, while there is a single thread: the time zone cannot be read soundly afterwards.
    let utc_offset_minutes = local_utc_offset_minutes();
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let env = |name: &str| std::env::var(name).ok();

    let stdout = std::io::stdout();
    let is_tty = stdout.is_terminal() && colors_work();
    let columns = terminal_columns(stdout.is_terminal(), &env);
    let mut out = std::io::BufWriter::new(stdout.lock());
    let mut err = std::io::stderr();
    let mut read_stdin = || {
        let mut bytes = Vec::new();
        std::io::stdin().read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    };
    let mut open = open_url;
    let mut io = Io {
        cwd: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
        env: &env,
        out: &mut out,
        err: &mut err,
        read_stdin: &mut read_stdin,
        open_url: &mut open,
        is_tty,
        columns,
        clock: Arc::new(system_clock_ms),
        utc_offset_minutes,
        new_id: None,
    };
    let code = cli::run(&args, &mut io);
    let _ = out.flush();
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
