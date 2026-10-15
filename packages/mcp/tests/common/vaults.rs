//! Throwaway vaults and notes for the service and index tests.
#![allow(dead_code)] // each test file uses a different part of this module
use oprojects_mcp::card::new_card_content;
use oprojects_mcp::types::{Card, CardType, Checklist, Comment, Priority};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};
use tempfile::TempDir;

/// An empty vault: a temp folder with `.obsidian` in it.
pub fn temp_vault() -> TempDir {
    let dir = tempfile::Builder::new().prefix("oprojects-test-vault-").tempdir().unwrap();
    fs::create_dir(dir.path().join(".obsidian")).unwrap();
    dir
}

/// A card shaped like the ones real boards hold: a description with a checklist, two comments, labels.
pub fn sample_card(key: &str, status: &str, rank: &str) -> Card {
    let body = format!(
        "The user lands on the home page instead of the page they came from after signing in through the SSO redirect. \
         Keep this note around {key}.\n\n- [x] Reproduce\n- [ ] Fix in the gateway\n- [ ] Regression test\n"
    );
    Card {
        key: key.to_string(),
        path: format!("Cards/{key}.md"),
        title: format!("Card {key} with a reasonably long title"),
        status: status.to_string(),
        card_type: CardType::Bug,
        priority: Priority::High,
        assignee: Some("Ana".into()),
        labels: vec!["api".into(), "backend".into()],
        due: Some("2026-11-05".into()),
        estimate: Some(3.0),
        parent: None,
        rank: rank.to_string(),
        created: "2026-10-01T10:00:00.000Z".into(),
        updated: "2026-10-02T10:00:00.000Z".into(),
        resolved: None,
        checklist: Checklist { done: 1, total: 3 },
        body,
        comments: vec![
            Comment {
                id: format!("{key}a"),
                author: "Ana".into(),
                at: "2026-10-02T10:00:00.000Z".into(),
                text: "I can only reproduce it in Safari.".into(),
            },
            Comment {
                id: format!("{key}b"),
                author: "Bruno".into(),
                at: "2026-10-03T10:00:00.000Z".into(),
                text: "Found it: the SSO redirect drops the query string.".into(),
            },
        ],
    }
}

/// The text of the note of `card`, written the way the service writes it (UTC titles).
pub fn note_text(card: &Card) -> String {
    new_card_content(card, 0).unwrap()
}

/// Writes the note of `card` under the vault's `Cards` folder, like another program (the plugin, a sync client) would.
pub fn write_card(root: &Path, card: &Card) {
    try_write_card(root, card).unwrap();
}

/// [`write_card`] that reports a failure instead of panicking. File operations that race each other can fail for a
/// moment on Windows (a file that is being deleted refuses to be opened), which is not what a test about something
/// else is asking about.
pub fn try_write_card(root: &Path, card: &Card) -> std::io::Result<()> {
    let path = root.join(&card.path);
    fs::create_dir_all(path.parent().unwrap())?;
    fs::write(path, note_text(card))
}

/// Writes `count` realistic notes `OP-1`..`OP-count`, spread over the four default columns with ascending ranks.
pub fn write_vault_cards(root: &Path, count: usize) {
    let columns = ["todo", "doing", "review", "done"];
    let ranks = oprojects_mcp::rank::spread_ranks(count / columns.len() + 1);
    for i in 1..=count {
        let card = sample_card(&format!("OP-{i}"), columns[i % columns.len()], &ranks[i / columns.len()]);
        write_card(root, &card);
    }
}

/// Gives a file an old modification time, so the index does not treat it as "just modified".
pub fn make_old(path: &Path) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
}

pub fn make_all_old(root: &Path) {
    for entry in fs::read_dir(root.join("Cards")).unwrap() {
        make_old(&entry.unwrap().path());
    }
}

/// Polls until `condition` holds or `timeout` runs out. Returns whether it held.
pub fn eventually(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

/// How long to wait for something a watcher or a reconciliation should deliver. Generous: CI machines stall.
pub const PATIENCE: Duration = Duration::from_secs(20);

/// The number of threads of this process (Linux), or `None` where it cannot be told.
pub fn thread_count() -> Option<usize> {
    fs::read_dir("/proc/self/task").ok().map(|d| d.count())
}

/// Resident memory of this process in MB (Linux), or `None` where it cannot be told.
pub fn rss_mb() -> Option<f64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let kb: f64 =
        status.lines().find_map(|l| l.strip_prefix("VmRSS:"))?.trim().trim_end_matches("kB").trim().parse().ok()?;
    Some(kb / 1024.0)
}
