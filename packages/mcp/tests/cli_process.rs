//! The real `oprojects` binary as a process: what the in-process corpus replay cannot show (the real terminal detection,
//! standard input, the environment, the exit code the operating system sees, a closed pipe).
mod common;

use common::vaults::temp_vault;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_oprojects");

struct Ran {
    code: i32,
    out: String,
    err: String,
}

/// The binary, in `dir`, with nothing from the environment of the test that changes its behavior.
fn command(dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(BIN);
    command
        .args(args)
        .current_dir(dir)
        .env_remove("OPROJECTS_VAULT")
        .env_remove("NO_COLOR")
        .env_remove("FORCE_COLOR")
        .env_remove("COLUMNS")
        .stdin(Stdio::null());
    command
}

fn finish(command: &mut Command, stdin: Option<&[u8]>) -> Ran {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().expect("the binary starts");
    if let Some(bytes) = stdin {
        child.stdin.take().unwrap().write_all(bytes).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    Ran {
        code: output.status.code().unwrap_or(-1),
        out: String::from_utf8_lossy(&output.stdout).into_owned(),
        err: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn run(dir: &Path, args: &[&str]) -> Ran {
    finish(&mut command(dir, args), None)
}

fn json(dir: &Path, args: &[&str]) -> Value {
    let ran = run(dir, args);
    assert_eq!(ran.code, 0, "{args:?} failed: {}", ran.err);
    serde_json::from_str(&ran.out).unwrap_or_else(|e| panic!("{args:?} did not print JSON ({e}): {}", ran.out))
}

#[test]
fn it_reports_its_version_and_lists_its_commands() {
    let dir = temp_vault();
    let version = run(dir.path(), &["--version"]);
    assert_eq!((version.code, version.out.as_str()), (0, concat!(env!("CARGO_PKG_VERSION"), "\n")));
    let help = run(dir.path(), &["--help"]);
    assert_eq!(help.code, 0);
    for word in ["add", "list", "board", "show", "comment", "move", "edit", "rm", "open", "config", "init"] {
        assert!(help.out.contains(&format!("  {word}")), "the help lists {word}:\n{}", help.out);
    }
}

#[test]
fn exit_codes_tell_a_usage_mistake_from_a_failure_from_success() {
    let dir = temp_vault();
    assert_eq!(run(dir.path(), &["frobnicate"]).code, 2);
    assert_eq!(run(dir.path(), &["add"]).code, 2);
    assert_eq!(run(dir.path(), &["show", "OP-9"]).code, 1);
    assert_eq!(run(dir.path(), &["list"]).code, 0);
    let ran = run(dir.path(), &["show", "OP-9"]);
    assert_eq!(ran.out, "");
    assert_eq!(ran.err, "error: Card OP-9 not found\n");
}

#[test]
fn a_whole_session_on_a_real_vault() {
    let dir = temp_vault();
    let d = dir.path();
    assert!(run(d, &["init", "--prefix", "web", "--me", "Ana"]).out.contains("Board ready"));
    assert_eq!(json(d, &["add", "Fix the login", "-t", "bug", "-p", "high", "--json"])["key"], "WEB-1");
    assert_eq!(json(d, &["add", "Second card", "-a", "me", "--json"])["assignee"], "Ana");
    let listed = json(d, &["list", "--json"]);
    assert_eq!(listed.as_array().unwrap().len(), 2);
    assert!(listed[0].get("body").is_none() && listed[0]["commentCount"] == 0);

    assert_eq!(json(d, &["move", "1", "doing", "--json"])["status"], "doing");
    assert_eq!(json(d, &["edit", "2", "--title", "Renamed", "--add-label", "x", "--json"])["labels"][0], "x");
    let commented = json(d, &["comment", "1", "Looks good", "--json"]);
    assert_eq!(commented["comments"][0]["author"], "Ana");
    assert!(run(d, &["show", "WEB-1"]).out.contains("Looks good"));
    assert!(run(d, &["board"]).out.contains("IN PROGRESS 1"));
    assert!(run(d, &["rm", "2"]).out.contains("(in .trash)"));
    assert_eq!(json(d, &["list", "--json"]).as_array().unwrap().len(), 1);
    assert!(d.join(".trash/WEB-2.md").is_file());
    assert_eq!(json(d, &["config", "--json"])["prefix"], "WEB");
}

#[test]
fn the_vault_comes_from_the_flag_the_environment_or_the_folder_we_are_in() {
    let vault = temp_vault();
    let elsewhere = tempfile::tempdir().unwrap();
    let v = vault.path().to_str().unwrap();
    run(vault.path(), &["add", "In the vault"]);

    assert!(run(elsewhere.path(), &["list"]).err.contains("No Obsidian vault found"));
    assert!(run(elsewhere.path(), &["list", "--vault", v]).out.contains("In the vault"));
    assert!(finish(command(elsewhere.path(), &["list"]).env("OPROJECTS_VAULT", v), None).out.contains("In the vault"));
    std::fs::create_dir(vault.path().join("Cards/sub")).unwrap();
    assert!(run(&vault.path().join("Cards/sub"), &["list"]).out.contains("In the vault"));
    let nowhere = run(elsewhere.path(), &["list", "--vault", elsewhere.path().to_str().unwrap()]);
    assert_eq!(nowhere.code, 1);
    assert!(nowhere.err.contains("is not an Obsidian vault"));
}

#[test]
fn colors_follow_the_terminal_and_the_environment() {
    let dir = temp_vault();
    run(dir.path(), &["add", "Colorful"]);
    let escape = '\u{1b}';
    // a pipe is not a terminal
    assert!(!run(dir.path(), &["list"]).out.contains(escape));
    let forced = finish(command(dir.path(), &["list"]).env("FORCE_COLOR", "1"), None);
    assert!(forced.out.contains(escape), "FORCE_COLOR turns colors on");
    assert!(
        !finish(command(dir.path(), &["list"]).env("FORCE_COLOR", "1").env("NO_COLOR", "1"), None).out.contains(escape)
    );
    assert!(!finish(command(dir.path(), &["list", "--no-color"]).env("FORCE_COLOR", "1"), None).out.contains(escape));
    assert!(!finish(command(dir.path(), &["list", "--json"]).env("FORCE_COLOR", "1"), None).out.contains(escape));
    // an empty variable does not count, as in the TypeScript
    assert!(!finish(command(dir.path(), &["list"]).env("FORCE_COLOR", ""), None).out.contains(escape));
}

#[test]
fn the_width_comes_from_the_columns_variable_when_there_is_no_terminal() {
    let dir = temp_vault();
    run(
        dir.path(),
        &["add", "A title that is long enough to be cut when the terminal is narrow, with more words after"],
    );
    let widest = |columns: &str| {
        let ran = finish(command(dir.path(), &["list"]).env("COLUMNS", columns), None);
        ran.out.lines().map(|l| l.chars().count()).max().unwrap()
    };
    assert!(widest("50") < widest("120"));
    assert_eq!(widest("0"), widest("100"), "0 means unknown");
    assert_eq!(widest("nonsense"), widest("100"));
}

#[test]
fn text_can_come_from_standard_input() {
    let dir = temp_vault();
    let d = dir.path();
    let added = finish(
        &mut command(d, &["add", "From stdin", "--body", "-", "--json"]),
        Some("Line one\r\nLine two\r\n".as_bytes()),
    );
    assert_eq!(added.code, 0, "{}", added.err);
    let card: Value = serde_json::from_str(&added.out).unwrap();
    assert_eq!(card["body"].as_str().unwrap().trim(), "Line one\nLine two", "CRLF became LF");

    let commented = finish(
        &mut command(d, &["comment", "1", "-", "--author", "Ana", "--json"]),
        Some(b"A comment\nin two lines\n"),
    );
    assert_eq!(
        serde_json::from_str::<Value>(&commented.out).unwrap()["comments"][0]["text"],
        "A comment\nin two lines"
    );

    // bytes that are not UTF-8 become the replacement character instead of failing
    let broken =
        finish(&mut command(d, &["comment", "1", "-", "--author", "Ana", "--json"]), Some(&[b'o', b'k', 0xff, 0xfe]));
    assert_eq!(broken.code, 0, "{}", broken.err);
    assert_eq!(serde_json::from_str::<Value>(&broken.out).unwrap()["comments"][1]["text"], "ok\u{fffd}\u{fffd}");

    let empty = finish(&mut command(d, &["comment", "1", "-"]), Some(b"  \n"));
    assert_eq!(empty.code, 2);
    assert!(empty.err.contains("Missing comment text"));
}

#[test]
fn arguments_and_notes_in_any_script() {
    let dir = temp_vault();
    let added = json(dir.path(), &["add", "日本語のタイトル 🚀 Zoë", "-l", "żółć,日本", "--json"]);
    assert_eq!(added["title"], "日本語のタイトル 🚀 Zoë");
    assert_eq!(added["labels"], serde_json::json!(["żółć", "日本"]));
    assert!(run(dir.path(), &["list", "-q", "ZOE"]).out.contains("日本語のタイトル"));
}

#[test]
fn open_prints_the_url_the_system_would_be_given() {
    let dir = temp_vault();
    run(dir.path(), &["add", "Open me"]);
    let ran = run(dir.path(), &["open", "1", "--print"]);
    let name = dir.path().file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(ran.out, format!("obsidian://open?vault={name}&file=Cards%2FOP-1\n"));
}

#[test]
fn a_vault_of_hundreds_of_cards_is_read_in_full() {
    let dir = temp_vault();
    let cards = dir.path().join("Cards");
    std::fs::create_dir(&cards).unwrap();
    for n in 1..=300 {
        std::fs::write(
            cards.join(format!("OP-{n}.md")),
            format!("---\nkey: OP-{n}\ntitle: Card {n}\nstatus: todo\nrank: r{n:04}\ncreated: 2026-10-01T10:00:00.000Z\nupdated: 2026-10-01T10:00:00.000Z\n---\n"),
        )
        .unwrap();
    }
    assert_eq!(json(dir.path(), &["list", "--json"]).as_array().unwrap().len(), 300);
    assert_eq!(json(dir.path(), &["add", "One more", "--json"])["key"], "OP-301");
}

#[test]
fn a_closed_pipe_ends_quietly() {
    let dir = temp_vault();
    let cards = dir.path().join("Cards");
    std::fs::create_dir(&cards).unwrap();
    for n in 1..=3000 {
        std::fs::write(
            cards.join(format!("OP-{n}.md")),
            format!("---\nkey: OP-{n}\ntitle: A card with a title long enough to fill a few thousand lines of output {n}\nstatus: todo\nrank: r{n:05}\ncreated: 2026-10-01T10:00:00.000Z\nupdated: 2026-10-01T10:00:00.000Z\n---\n"),
        )
        .unwrap();
    }
    let mut child = command(dir.path(), &["list"]).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut first = [0_u8; 16];
    child.stdout.take().unwrap().read_exact(&mut first).unwrap();
    // the reader goes away while the rest is still being written
    let output = child.wait_with_output().unwrap();
    assert!(
        output.stderr.is_empty(),
        "nothing is said about a closed pipe: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// The date `today` stands for follows the time zone of the machine, not UTC. Two zones that never change their offset.
#[cfg(unix)]
#[test]
fn today_is_the_date_where_the_user_is() {
    use oprojects_mcp::jscompat::wall_clock;
    let dir = temp_vault();
    let date_in = |offset_minutes: i32| {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let (y, m, d, _, _) = wall_clock(now, offset_minutes);
        format!("{y}-{m:02}-{d:02}")
    };
    for (zone, offset) in [("Pacific/Kiritimati", 14 * 60), ("Pacific/Pago_Pago", -11 * 60)] {
        let before = date_in(offset);
        let added = finish(command(dir.path(), &["add", zone, "--due", "today", "--json"]).env("TZ", zone), None);
        let after = date_in(offset);
        let due = serde_json::from_str::<Value>(&added.out).unwrap()["due"].as_str().unwrap().to_string();
        assert!(due == before || due == after, "{zone}: due {due}, expected {before} (or {after} across midnight)");
    }
}
