//! Replays the scenarios of `tests/fixtures/cli.json`, which the TypeScript command line produced: the same vault, the
//! same arguments, stdin, terminal, environment and clock. Every invocation must end with the same exit code and write the
//! same stdout and stderr, and the files in the vault at the end must be the same: byte for byte in the scenarios whose
//! text is ordinary, as the cards they parse to in the others.
mod common;

use common::{fixture, json_eq};
use oprojects_mcp::card::parse_card;
use oprojects_mcp::cli::{Io, run};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Node's `parseArgs` words some of its messages differently from one version to the next, so the corpus keeps only their
/// first line (see `normalizeError` in `scripts/conformance/cli.fixture.ts`); this cuts ours the same way.
fn normalize_error(err: &str) -> String {
    let mut text = err.to_string();
    if let Some(at) = text.find("Unknown option ")
        && let Some(cut) = text[at..].find(". To specify a positional argument")
    {
        let from = at + cut;
        let end = text[from..].find('\n').map_or(text.len(), |n| from + n);
        text.replace_range(from..end, "");
    }
    let marker = "argument is ambiguous.\nDid you forget";
    if let Some(at) = text.find(marker) {
        let from = at + "argument is ambiguous.".len();
        let rest = &text[from + 1..];
        let mut lines = rest.splitn(3, '\n');
        let (_, second, tail) = (lines.next(), lines.next(), lines.next().unwrap_or(""));
        if second.is_some_and(|l| l.starts_with("To specify an option argument")) {
            text = format!("{}{}{}", &text[..from], if tail.is_empty() { "" } else { "\n" }, tail);
        }
    }
    text
}

/// A path below the vault is written with the platform's separator (`<vault>\Cards` on Windows, or `<vault>\\Cards` inside
/// a JSON string); the corpus has `/`. Only on Windows, where a backslash followed by a name is a path.
fn forward_slashes_after(text: &str, placeholder: &str) -> String {
    if !cfg!(windows) {
        return text.to_string();
    }
    let is_name = |c: char| c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | '~' | '$');
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(placeholder) {
        let (head, mut tail) = rest.split_at(at + placeholder.len());
        out.push_str(head);
        loop {
            let separator = if tail.starts_with("\\\\") {
                2
            } else if tail.starts_with('\\') {
                1
            } else {
                0
            };
            if separator == 0 || !tail[separator..].chars().next().is_some_and(is_name) {
                break;
            }
            out.push('/');
            tail = &tail[separator..];
            let end = tail.find(|c: char| !is_name(c)).unwrap_or(tail.len());
            out.push_str(&tail[..end]);
            tail = &tail[end..];
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

fn list_files(root: &Path, dir: &str, out: &mut Vec<String>) {
    let mut entries: Vec<_> = fs::read_dir(root.join(dir)).unwrap().map(|e| e.unwrap()).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if dir.is_empty() { name } else { format!("{dir}/{name}") };
        if entry.file_type().unwrap().is_dir() {
            list_files(root, &rel, out);
        } else {
            out.push(rel);
        }
    }
}

struct Outcome {
    code: i32,
    out: String,
    err: String,
    opened: Vec<String>,
}

/// Runs one invocation in the scenario's vault.
fn invoke(inv: &Value, root: &str, outside: &str, ids: &[String], next_id: &Arc<AtomicUsize>) -> Outcome {
    let into = |t: &str| t.replace("<vault>", root).replace("<outside>", outside);
    let argv: Vec<String> = inv["argv"].as_array().unwrap().iter().map(|a| into(a.as_str().unwrap())).collect();
    let env: BTreeMap<String, String> = inv
        .get("env")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), into(v.as_str().unwrap()))).collect())
        .unwrap_or_default();
    let stdin = inv.get("stdin").and_then(Value::as_str).unwrap_or("").to_string();
    let at = inv["at"].as_i64().unwrap();
    let open_error = inv.get("openError").and_then(Value::as_str).map(str::to_string);

    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut opened = Vec::new();
    let lookup = |name: &str| env.get(name).cloned();
    let mut read_stdin = || Ok(stdin.clone());
    let mut open_url = |url: &str| {
        opened.push(url.to_string());
        match &open_error {
            Some(message) => Err(std::io::Error::other(message.clone())),
            None => Ok(()),
        }
    };
    let ids: Vec<String> = ids.to_vec();
    let counter = Arc::clone(next_id);
    let code = {
        let mut io = Io {
            cwd: inv.get("cwd").and_then(Value::as_str).map_or_else(|| root.into(), |c| into(c).into()),
            env: &lookup,
            out: &mut out,
            err: &mut err,
            read_stdin: &mut read_stdin,
            open_url: &mut open_url,
            is_tty: inv.get("tty").and_then(Value::as_bool).unwrap_or(false),
            columns: inv.get("columns").and_then(Value::as_i64).unwrap_or(100),
            clock: Arc::new(move || at),
            utc_offset_minutes: 0,
            new_id: Some(Arc::new(move || {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                ids.get(n).cloned().unwrap_or_else(|| format!("z{}", n + 1))
            })),
        };
        run(&argv, &mut io)
    };

    // The vault's path is a placeholder in the corpus. On Windows it also appears with doubled backslashes inside JSON.
    let outof = |bytes: Vec<u8>| {
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        for (path, placeholder) in [(root, "<vault>"), (outside, "<outside>")] {
            text = text.replace(&path.replace('\\', "\\\\"), placeholder).replace(path, placeholder);
            text = forward_slashes_after(&text, placeholder);
        }
        text
    };
    Outcome {
        code,
        out: outof(out),
        err: normalize_error(&outof(err)),
        opened: opened.iter().map(|u| u.replace(root, "<vault>")).collect(),
    }
}

fn describe(inv: &Value) -> String {
    let argv: Vec<&str> = inv["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
    format!("{argv:?}")
}

#[test]
fn every_scenario_of_the_corpus_behaves_as_the_typescript_cli_did() {
    let corpus = fixture("cli");
    assert!(corpus.cases.len() > 200, "the corpus looks truncated: {} cases", corpus.cases.len());
    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0;

    for case in &corpus.cases {
        let outside = tempfile::Builder::new().prefix("oprojects-cli-corpus-").tempdir().unwrap();
        let name = case.input.get("vaultName").and_then(Value::as_str).unwrap_or("vault");
        let root_path = outside.path().join(name);
        fs::create_dir_all(root_path.join(".obsidian")).unwrap();
        for (rel, content) in case.input["files"].as_object().unwrap() {
            let file = root_path.join(rel);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, content.as_str().unwrap()).unwrap();
        }
        let root = root_path.to_string_lossy().into_owned();
        let outside_text = outside.path().to_string_lossy().into_owned();
        let ids: Vec<String> =
            case.input["ids"].as_array().unwrap().iter().map(|i| i.as_str().unwrap().to_string()).collect();
        let next_id = Arc::new(AtomicUsize::new(0));

        let runs = case.input["runs"].as_array().unwrap();
        let expected_runs = case.expected["runs"].as_array().unwrap();
        for (i, inv) in runs.iter().enumerate() {
            let want = &expected_runs[i];
            let got = invoke(inv, &root, &outside_text, &ids, &next_id);
            checked += 1;
            let want_opened: Vec<&str> =
                want["opened"].as_array().unwrap().iter().map(|u| u.as_str().unwrap()).collect();
            let same = got.code == want["code"].as_i64().unwrap() as i32
                && got.out == want["out"].as_str().unwrap()
                && got.err == want["err"].as_str().unwrap()
                && got.opened.iter().map(String::as_str).eq(want_opened.iter().copied());
            if !same {
                failures.push(format!(
                    "{} run {i} {}\n  expected code {} out {:?} err {:?} opened {:?}\n  actual   code {} out {:?} err {:?} opened {:?}",
                    case.id,
                    describe(inv),
                    want["code"],
                    want["out"].as_str().unwrap(),
                    want["err"].as_str().unwrap(),
                    want_opened,
                    got.code,
                    got.out,
                    got.err,
                    got.opened
                ));
                // The runs after a difference start from a different vault: say no more about this scenario.
                break;
            }
        }
        if failures.last().is_some_and(|f| f.starts_with(&format!("{} run", case.id))) {
            continue;
        }

        // the files at the end
        let exact = case.expected["exactText"].as_bool().unwrap();
        let mut found = Vec::new();
        list_files(&root_path, "", &mut found);
        let wanted: Vec<&str> =
            case.expected["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
        if found.iter().map(String::as_str).ne(wanted.iter().copied()) {
            failures.push(format!("{}: files differ\n  expected {wanted:?}\n  actual   {found:?}", case.id));
            continue;
        }
        for file in case.expected["files"].as_array().unwrap() {
            let path = file["path"].as_str().unwrap();
            let content = fs::read_to_string(root_path.join(path)).unwrap();
            if let Some(text) = file.get("text").and_then(Value::as_str) {
                if content != text {
                    failures.push(format!("{}: {path} differs\n  expected {text:?}\n  actual   {content:?}", case.id));
                }
            } else if path.ends_with(".md") {
                let actual = parse_card(path, &content).map_or(Value::Null, |c| serde_json::to_value(c).unwrap());
                if !json_eq(&actual, &file["card"]) {
                    failures.push(format!("{}: {path} parses to a different card (exact text: {exact})\n  expected {}\n  actual   {actual}", case.id, file["card"]));
                }
            }
        }
    }

    assert!(
        failures.is_empty(),
        "{} of the {} invocations replayed differ from the TypeScript CLI (showing the first 12):\n{}",
        failures.len(),
        checked,
        failures.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}
