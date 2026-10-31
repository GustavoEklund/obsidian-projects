//! `oprojects-mcp watch` as a process, the way the Monitor tool runs it: every line on stdout is an update, and the
//! command ends by itself when the card is done.
mod common;

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use common::vaults::{note_text, sample_card, temp_vault};
use oprojects_mcp::types::{Card, Comment};

const BIN: &str = env!("CARGO_BIN_EXE_oprojects-mcp");
/// More than any wait below needs, so a failure is a failure and not a slow machine.
const PATIENCE: Duration = Duration::from_secs(15);

/// A running `watch`. It is killed when the test ends, passed or not: no process is left behind.
struct Watching {
    child: Child,
    stdout: Receiver<String>,
}

impl Drop for Watching {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn lines_of(reader: impl std::io::Read + Send + 'static) -> Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                return;
            }
        }
    });
    receiver
}

fn command(vault: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(BIN);
    command
        .args(args)
        .current_dir(vault)
        .env_remove("OPROJECTS_VAULT")
        .env_remove("OPROJECTS_AUTHOR")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Starts `watch` and returns once it says it is following (so the baseline has been read).
fn start(vault: &Path, args: &[&str]) -> Watching {
    let mut child = command(vault, args).spawn().expect("the binary starts");
    let stdout = lines_of(child.stdout.take().unwrap());
    let stderr = lines_of(child.stderr.take().unwrap());
    let said = stderr.recv_timeout(PATIENCE).expect("it says what it follows");
    assert!(said.contains("following OP-1"), "{said}");
    Watching { child, stdout }
}

fn write_card(vault: &Path, card: &Card) {
    fs::create_dir_all(vault.join("Cards")).unwrap();
    fs::write(vault.join(&card.path), note_text(card)).unwrap();
}

fn expect_exit(child: &mut Child) -> i32 {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status.code().unwrap_or(-1);
        }
        assert!(started.elapsed() < PATIENCE, "the command did not end");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn it_tells_about_a_comment_then_about_done_and_ends_with_success() {
    let vault = temp_vault();
    let mut card = sample_card("OP-1", "doing", "M");
    write_card(vault.path(), &card);
    let mut watching = start(vault.path(), &["watch", "1", "--settle", "0.2", "--author", "Claude"]);

    card.comments.push(Comment {
        id: "n1".into(),
        author: "Gustavo".into(),
        at: "2026-10-04T10:00:00.000Z".into(),
        text: "Please also check Safari.".into(),
    });
    write_card(vault.path(), &card);
    let line = watching.stdout.recv_timeout(PATIENCE).expect("the comment is told");
    assert!(line.starts_with("OP-1 \""), "{line}");
    assert!(line.contains("Gustavo commented: \"Please also check Safari.\""), "{line}");

    card.status = "done".into();
    write_card(vault.path(), &card);
    let line = watching.stdout.recv_timeout(PATIENCE).expect("the finish is told");
    assert!(line.contains("moved to Done") && line.contains("stop watching it"), "{line}");
    assert_eq!(expect_exit(&mut watching.child), 0);
    assert!(watching.stdout.recv_timeout(Duration::from_millis(200)).is_err(), "nothing after the last line");
}

#[test]
fn what_the_agent_wrote_itself_is_not_told_back() {
    let vault = temp_vault();
    let mut card = sample_card("OP-1", "doing", "M");
    write_card(vault.path(), &card);
    let watching = start(vault.path(), &["watch", "OP-1", "--settle", "0.2", "--author", "Claude"]);

    card.comments.push(Comment {
        id: "n1".into(),
        author: "Claude".into(),
        at: "2026-10-04T10:00:00.000Z".into(),
        text: "Working on it.".into(),
    });
    write_card(vault.path(), &card);
    std::thread::sleep(Duration::from_millis(1500));
    card.status = "done".into();
    write_card(vault.path(), &card);
    let line = watching.stdout.recv_timeout(PATIENCE).expect("the finish is told");
    assert!(!line.contains("Working on it"), "{line}");
    assert!(line.contains("moved to Done"), "{line}");
}

#[test]
fn a_card_that_is_already_done_is_said_so_and_the_command_ends_at_once() {
    let vault = temp_vault();
    write_card(vault.path(), &sample_card("OP-1", "done", "M"));
    let output = command(vault.path(), &["watch", "1"]).output().unwrap();
    assert_eq!(output.status.code(), Some(0));
    let out = String::from_utf8_lossy(&output.stdout);
    assert!(out.contains("OP-1") && out.contains("already done"), "{out}");
    assert!(output.stderr.is_empty(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn a_card_that_does_not_exist_is_an_error_on_stderr_and_nothing_on_stdout() {
    let vault = temp_vault();
    write_card(vault.path(), &sample_card("OP-1", "doing", "M"));
    let output = command(vault.path(), &["watch", "99"]).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("OP-99"), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn a_command_line_that_names_no_card_is_a_usage_mistake() {
    let vault = temp_vault();
    let output = command(vault.path(), &["watch"]).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("at least one card key"));
}

#[test]
fn the_vault_can_be_named_from_anywhere() {
    let vault = temp_vault();
    write_card(vault.path(), &sample_card("OP-1", "done", "M"));
    let elsewhere = tempfile::tempdir().unwrap();
    let vault_arg = vault.path().to_str().unwrap();
    let output = command(elsewhere.path(), &["watch", "1", "--vault", vault_arg]).output().unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("already done"));
}
