//! The in-memory index against real folders: loading in the background, following changes by events and by
//! reconciliation, reading your own writes, and not reading what did not change.
mod common;

use common::vaults::{
    PATIENCE, eventually, make_all_old, make_old, sample_card, temp_vault, write_card, write_vault_cards,
};
use oprojects_mcp::error::Result;
use oprojects_mcp::index::{CardIndex, IndexOptions};
use oprojects_mcp::service::CardSource;
use oprojects_mcp::storage::{FsStorage, Stamp, Storage};
use oprojects_mcp::types::BoardConfig;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn start_with(root: &Path, watch: bool, reconcile_every: Duration) -> Arc<CardIndex> {
    CardIndex::start(
        Arc::new(FsStorage::new(root)),
        BoardConfig::default(),
        IndexOptions {
            reconcile_every,
            debounce: Duration::from_millis(30),
            watch_vault_root: watch.then(|| root.to_path_buf()),
            first_load_timeout: PATIENCE,
        },
    )
}

/// Watching, with a reconciliation so rare it never runs: what the test sees is the watcher's doing.
fn watched(root: &Path) -> Arc<CardIndex> {
    start_with(root, true, Duration::from_secs(3600))
}

/// No watcher: only the reconciliation (fast) keeps it current.
fn polled(root: &Path) -> Arc<CardIndex> {
    start_with(root, false, Duration::from_millis(40))
}

fn keys(index: &CardIndex) -> Vec<String> {
    index.snapshot().iter().map(|c| c.key.clone()).collect()
}

fn titles(index: &CardIndex) -> Vec<String> {
    index.snapshot().iter().map(|c| c.title.clone()).collect()
}

// --- loading --------------------------------------------------------------------------------------------------------

#[test]
fn start_returns_at_once_and_the_vault_loads_in_the_background() {
    let dir = temp_vault();
    write_vault_cards(dir.path(), 600);
    let began = Instant::now();
    let index = watched(dir.path());
    assert!(began.elapsed() < Duration::from_millis(500), "start waited for the load: {:?}", began.elapsed());
    assert!(index.wait_until_loaded(PATIENCE));
    assert!(index.is_loaded());
    assert_eq!(index.len(), 600);
    assert!(!index.is_empty());
}

#[test]
fn a_snapshot_is_in_board_order_and_shares_its_cards_between_calls() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "doing", "V"));
    write_card(dir.path(), &sample_card("OP-2", "todo", "V"));
    write_card(dir.path(), &sample_card("OP-3", "todo", "F"));
    write_card(dir.path(), &sample_card("OP-4", "done", "V"));
    let index = polled(dir.path());
    // default columns: todo, doing, review, done; inside a column by rank
    assert_eq!(keys(&index), ["OP-3", "OP-2", "OP-1", "OP-4"]);
    let (a, b) = (index.snapshot(), index.snapshot());
    assert!(a.iter().zip(&b).all(|(x, y)| Arc::ptr_eq(x, y)), "snapshots must share the parsed cards, not copy them");
}

#[test]
fn a_missing_or_empty_cards_folder_is_an_empty_index() {
    let dir = temp_vault();
    let index = watched(dir.path());
    assert!(index.snapshot().is_empty());
    assert!(index.is_loaded());
    fs::create_dir(dir.path().join("Cards")).unwrap();
    let again = watched(dir.path());
    assert!(again.snapshot().is_empty());
}

#[test]
fn a_cards_folder_that_appears_after_the_start_is_watched_from_then_on() {
    let dir = temp_vault();
    let index = watched(dir.path());
    assert!(index.wait_until_loaded(PATIENCE));
    assert!(!index.stats().watching, "there is nothing to watch yet");

    // The first card of a new vault: the folder and the note appear together. No reconciliation can explain what follows.
    write_card(dir.path(), &sample_card("OP-1", "todo", "M"));
    assert!(eventually(PATIENCE, || keys(&index) == ["OP-1"]), "{:?}", keys(&index));
    assert!(eventually(PATIENCE, || index.stats().watching));
    write_card(dir.path(), &sample_card("OP-2", "todo", "N"));
    assert!(eventually(PATIENCE, || keys(&index) == ["OP-1", "OP-2"]), "{:?}", keys(&index));
}

#[test]
fn a_nested_cards_folder_that_is_made_one_level_at_a_time_is_found() {
    let dir = temp_vault();
    let config = BoardConfig { folder: "Work/Items".into(), ..BoardConfig::default() };
    let index = CardIndex::start(
        Arc::new(FsStorage::new(dir.path())),
        config,
        IndexOptions {
            reconcile_every: Duration::from_secs(3600),
            debounce: Duration::from_millis(30),
            watch_vault_root: Some(dir.path().to_path_buf()),
            first_load_timeout: PATIENCE,
        },
    );
    assert!(index.wait_until_loaded(PATIENCE));
    fs::create_dir(dir.path().join("Work")).unwrap();
    // Let the first level be noticed (the watch moves down to it) before the second one is made.
    std::thread::sleep(Duration::from_millis(300));
    fs::create_dir(dir.path().join("Work/Items")).unwrap();
    let mut card = sample_card("OP-1", "todo", "M");
    card.path = "Work/Items/OP-1.md".into();
    write_card(dir.path(), &card);
    assert!(eventually(PATIENCE, || index.len() == 1), "{:?}", keys(&index));
    assert!(eventually(PATIENCE, || index.stats().watching));
}

#[test]
fn a_cards_folder_that_is_deleted_and_made_again_is_watched_again() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "M"));
    let index = watched(dir.path());
    assert_eq!(keys(&index), ["OP-1"]);
    assert!(index.stats().watching);

    fs::remove_dir_all(dir.path().join("Cards")).unwrap();
    assert!(eventually(PATIENCE, || index.is_empty()), "{:?}", keys(&index));
    write_card(dir.path(), &sample_card("OP-2", "todo", "N"));
    assert!(eventually(PATIENCE, || keys(&index) == ["OP-2"]), "{:?}", keys(&index));
    write_card(dir.path(), &sample_card("OP-3", "todo", "O"));
    assert!(eventually(PATIENCE, || keys(&index) == ["OP-2", "OP-3"]), "{:?}", keys(&index));
}

#[test]
fn notes_that_are_not_cards_are_left_out_and_nothing_fails() {
    let dir = temp_vault();
    let cards = dir.path().join("Cards");
    fs::create_dir(&cards).unwrap();
    fs::write(cards.join("plain.md"), "# just a note\n").unwrap();
    fs::write(cards.join("broken.md"), "---\nkey: OP-9\ntitle: [oops\n---\nbody\n").unwrap();
    fs::write(cards.join("nokey.md"), "---\ntitle: no key\n---\n").unwrap();
    fs::write(cards.join("binary.md"), [0xff, 0xfe, 0x00, 0x41]).unwrap();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    let index = polled(dir.path());
    assert_eq!(keys(&index), ["OP-1"]);
}

#[test]
fn a_subfolder_of_the_cards_folder_is_part_of_the_board() {
    let dir = temp_vault();
    let mut card = sample_card("OP-1", "todo", "V");
    card.path = "Cards/archive/2026/OP-1.md".into();
    write_card(dir.path(), &card);
    let index = polled(dir.path());
    assert_eq!(index.snapshot()[0].path, "Cards/archive/2026/OP-1.md");
}

#[test]
fn hidden_files_and_other_folders_are_not_cards() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    let mut hidden = sample_card("OP-2", "todo", "V");
    hidden.path = "Cards/.OP-2.md".into();
    write_card(dir.path(), &hidden);
    let mut elsewhere = sample_card("OP-3", "todo", "V");
    elsewhere.path = "Other/OP-3.md".into();
    write_card(dir.path(), &elsewhere);
    let mut trashed = sample_card("OP-4", "todo", "V");
    trashed.path = "Cards/.trash/OP-4.md".into();
    write_card(dir.path(), &trashed);
    fs::write(dir.path().join("Cards/readme.txt"), "not markdown").unwrap();
    let index = polled(dir.path());
    assert_eq!(keys(&index), ["OP-1"]);
}

// --- events ---------------------------------------------------------------------------------------------------------

#[test]
fn a_watched_index_follows_creates_edits_and_deletes() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    let index = watched(dir.path());
    assert!(index.stats().watching, "the watcher should be running");
    assert_eq!(keys(&index), ["OP-1"]);

    write_card(dir.path(), &sample_card("OP-2", "todo", "W"));
    assert!(
        eventually(PATIENCE, || keys(&index) == ["OP-1", "OP-2"]),
        "a new note was not picked up: {:?}",
        keys(&index)
    );

    let mut edited = sample_card("OP-2", "doing", "W");
    edited.title = "Edited on disk".into();
    write_card(dir.path(), &edited);
    assert!(
        eventually(PATIENCE, || titles(&index).contains(&"Edited on disk".to_string())),
        "an edit was not picked up"
    );
    assert!(index.snapshot().iter().any(|c| c.key == "OP-2" && c.status == "doing"));

    fs::remove_file(dir.path().join("Cards/OP-1.md")).unwrap();
    assert!(eventually(PATIENCE, || keys(&index) == ["OP-2"]), "a deleted note stayed: {:?}", keys(&index));
    assert!(index.stats().events_applied > 0);
}

#[test]
fn a_renamed_note_keeps_its_card_under_the_new_path() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    let index = watched(dir.path());
    fs::rename(dir.path().join("Cards/OP-1.md"), dir.path().join("Cards/renamed by hand.md")).unwrap();
    assert!(
        eventually(PATIENCE, || index.snapshot().iter().map(|c| c.path.clone()).collect::<Vec<_>>()
            == ["Cards/renamed by hand.md"]),
        "a renamed note was not followed: {:?}",
        index.snapshot().iter().map(|c| c.path.clone()).collect::<Vec<_>>()
    );
    assert_eq!(index.len(), 1);
}

#[test]
fn a_note_moved_out_of_the_cards_folder_leaves_the_board() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    write_card(dir.path(), &sample_card("OP-2", "todo", "W"));
    let index = watched(dir.path());
    fs::create_dir(dir.path().join("Elsewhere")).unwrap();
    fs::rename(dir.path().join("Cards/OP-1.md"), dir.path().join("Elsewhere/OP-1.md")).unwrap();
    assert!(eventually(PATIENCE, || keys(&index) == ["OP-2"]), "{:?}", keys(&index));
}

#[test]
fn changes_to_ignored_files_never_show_up_and_do_not_disturb_the_rest() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    let index = watched(dir.path());
    let cards = dir.path().join("Cards");
    fs::write(cards.join(".OP-1.md.123.4.tmp"), "temp").unwrap();
    fs::write(cards.join("notes.txt"), "text").unwrap();
    fs::write(cards.join(".hidden.md"), "---\nkey: OP-8\n---\n").unwrap();
    fs::create_dir(dir.path().join("Other")).unwrap();
    fs::write(dir.path().join("Other/OP-7.md"), "---\nkey: OP-7\n---\n").unwrap();
    // a visible change made after them: once it shows up, the earlier events have been dealt with too
    write_card(dir.path(), &sample_card("OP-2", "todo", "W"));
    assert!(eventually(PATIENCE, || keys(&index) == ["OP-1", "OP-2"]), "{:?}", keys(&index));
    assert_eq!(index.len(), 2);
}

#[test]
fn a_note_with_broken_yaml_is_skipped_until_it_is_fixed() {
    let dir = temp_vault();
    let index = watched(dir.path());
    fs::create_dir_all(dir.path().join("Cards")).unwrap();
    fs::write(dir.path().join("Cards/OP-5.md"), "---\nkey: OP-5\ntitle: [oops\n---\nbody\n").unwrap();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    // reconcile: this test writes straight after the folder appears and does not wait for the watcher to catch up
    index.reconcile();
    assert_eq!(keys(&index), ["OP-1"]);
    write_card(dir.path(), &sample_card("OP-5", "todo", "W"));
    index.reconcile();
    assert_eq!(keys(&index), ["OP-1", "OP-5"]);
}

// --- reconciliation -------------------------------------------------------------------------------------------------

#[test]
fn reconciliation_alone_keeps_the_index_current_without_a_watcher() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    let index = polled(dir.path());
    assert!(!index.stats().watching);

    write_card(dir.path(), &sample_card("OP-2", "todo", "W"));
    assert!(eventually(PATIENCE, || keys(&index) == ["OP-1", "OP-2"]));
    let mut edited = sample_card("OP-1", "review", "V");
    edited.title = "Changed".into();
    write_card(dir.path(), &edited);
    assert!(eventually(PATIENCE, || titles(&index).contains(&"Changed".to_string())));
    fs::remove_file(dir.path().join("Cards/OP-2.md")).unwrap();
    assert!(eventually(PATIENCE, || keys(&index) == ["OP-1"]));
    assert!(index.stats().reconciles >= 3);
}

#[test]
fn an_explicit_reconcile_catches_up_at_once() {
    let dir = temp_vault();
    let index = start_with(dir.path(), false, Duration::from_secs(3600));
    assert!(index.snapshot().is_empty());
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    assert!(index.snapshot().is_empty(), "nothing tells the index yet");
    index.reconcile();
    assert_eq!(keys(&index), ["OP-1"]);
}

#[test]
fn reconciling_an_unchanged_vault_reads_nothing_and_a_change_reads_only_that_note() {
    let dir = temp_vault();
    write_vault_cards(dir.path(), 200);
    make_all_old(dir.path()); // notes modified long ago: an equal stamp proves they are unchanged
    let index = start_with(dir.path(), false, Duration::from_secs(3600));
    assert_eq!(index.snapshot().len(), 200);
    let loaded = index.stats().notes_read;
    assert_eq!(loaded, 200);

    for _ in 0..3 {
        index.reconcile();
    }
    assert_eq!(index.stats().notes_read, loaded, "unchanged notes must not be read again");

    let mut edited = sample_card("OP-77", "review", "Zz");
    edited.title = "Only this one changed".into();
    write_card(dir.path(), &edited);
    index.reconcile();
    let after = index.stats().notes_read;
    assert_eq!(after, loaded + 1, "exactly the changed note is read");
    assert!(titles(&index).contains(&"Only this one changed".to_string()));
}

#[test]
fn a_note_modified_a_moment_ago_is_looked_at_again_because_its_stamp_proves_little() {
    // Two edits inside one clock tick can leave the same modification time and length: never trust that.
    let dir = temp_vault();
    let mut card = sample_card("OP-1", "todo", "V");
    card.title = "aaaa".into();
    write_card(dir.path(), &card);
    let index = start_with(dir.path(), false, Duration::from_secs(3600));
    for i in 0..25 {
        let title = if i % 2 == 0 { "bbbb" } else { "cccc" }; // the same length every time
        card.title = title.into();
        write_card(dir.path(), &card);
        index.refresh_path("Cards/OP-1.md");
        assert_eq!(titles(&index), [title], "round {i}: the index missed an edit that left the same stamp");
    }
}

#[test]
fn a_storage_that_cannot_stamp_still_works_and_re_reads_everything() {
    struct NoStamps(FsStorage);
    impl Storage for NoStamps {
        fn list_markdown(&self, folder: &str) -> Result<Vec<String>> {
            self.0.list_markdown(folder)
        }
        fn read(&self, path: &str) -> Result<String> {
            self.0.read(path)
        }
        fn create(&self, path: &str, content: &str) -> Result<()> {
            self.0.create(path, content)
        }
        fn modify(&self, path: &str, f: &mut dyn FnMut(&str) -> Result<String>) -> Result<String> {
            self.0.modify(path, f)
        }
        fn remove(&self, path: &str) -> Result<()> {
            self.0.remove(path)
        }
        fn exists(&self, path: &str) -> bool {
            self.0.exists(path)
        }
        fn stamp(&self, _path: &str) -> Option<Stamp> {
            None
        }
    }
    let dir = temp_vault();
    write_vault_cards(dir.path(), 20);
    let index = CardIndex::start(
        Arc::new(NoStamps(FsStorage::new(dir.path()))),
        BoardConfig::default(),
        IndexOptions { watch_vault_root: None, reconcile_every: Duration::from_secs(3600), ..IndexOptions::default() },
    );
    assert_eq!(index.snapshot().len(), 20);
    index.reconcile();
    assert_eq!(index.stats().notes_read, 40, "without stamps every reconciliation reads everything");
    fs::remove_file(dir.path().join("Cards/OP-3.md")).unwrap();
    index.reconcile();
    assert_eq!(index.len(), 19);
}

// --- reading your own writes ------------------------------------------------------------------------------------------

#[test]
fn refresh_and_forget_make_a_writers_changes_visible_at_once_without_any_watcher() {
    let dir = temp_vault();
    let index = start_with(dir.path(), false, Duration::from_secs(3600));
    assert!(index.snapshot().is_empty());

    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    index.refresh_path("Cards/OP-1.md");
    assert_eq!(keys(&index), ["OP-1"]);

    let mut card = sample_card("OP-1", "done", "V");
    card.title = "Rewritten".into();
    write_card(dir.path(), &card);
    index.refresh_path("Cards/OP-1.md");
    assert_eq!(titles(&index), ["Rewritten"]);

    fs::remove_file(dir.path().join("Cards/OP-1.md")).unwrap();
    index.forget_path("Cards/OP-1.md");
    assert!(index.snapshot().is_empty());
}

#[test]
fn refreshing_a_note_that_is_gone_or_was_never_there_is_harmless() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    let index = start_with(dir.path(), false, Duration::from_secs(3600));
    index.refresh_path("Cards/never-existed.md");
    index.forget_path("Cards/never-existed.md");
    fs::remove_file(dir.path().join("Cards/OP-1.md")).unwrap();
    index.refresh_path("Cards/OP-1.md");
    assert!(index.snapshot().is_empty());
    // the same note comes back
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    index.refresh_path("Cards/OP-1.md");
    assert_eq!(keys(&index), ["OP-1"]);
}

#[test]
fn the_index_is_a_card_source_for_the_service() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    let index = start_with(dir.path(), false, Duration::from_secs(3600));
    let source: &dyn CardSource = index.as_ref();
    assert_eq!(source.cards().len(), 1);
    write_card(dir.path(), &sample_card("OP-2", "todo", "W"));
    source.refresh_path("Cards/OP-2.md");
    assert_eq!(source.cards().len(), 2);
    source.forget_path("Cards/OP-2.md");
    assert_eq!(source.cards().len(), 1);
}

// --- staged races -------------------------------------------------------------------------------------------------------

/// A file storage whose reads can be held back and whose stamps can be made to say nothing, to stage the races an index
/// must survive at exactly the moment they are dangerous instead of hoping a stress test hits them.
struct Staged {
    inner: FsStorage,
    hold_next_read: AtomicBool,
    /// `(reached, released)` of the held read.
    gate: Mutex<(bool, bool)>,
    changed: Condvar,
    /// When set, every note has this stamp, whatever it holds.
    frozen: Option<Stamp>,
}

impl Staged {
    fn new(root: &Path, frozen_modified_ns: Option<u128>) -> Arc<Self> {
        Arc::new(Self {
            inner: FsStorage::new(root),
            hold_next_read: AtomicBool::new(false),
            gate: Mutex::new((false, false)),
            changed: Condvar::new(),
            frozen: frozen_modified_ns.map(|modified_ns| Stamp { modified_ns, len: 1 }),
        })
    }

    /// The next `read` finds the note's content and then waits to be released before handing it over: a slow reader.
    fn hold_next_read(&self) {
        *self.gate.lock().unwrap() = (false, false);
        self.hold_next_read.store(true, Ordering::SeqCst);
    }

    fn wait_reached(&self) {
        let gate = self.gate.lock().unwrap();
        let (gate, timeout) = self.changed.wait_timeout_while(gate, PATIENCE, |g| !g.0).unwrap();
        assert!(gate.0 && !timeout.timed_out(), "the held read was never reached");
    }

    fn release(&self) {
        self.gate.lock().unwrap().1 = true;
        self.changed.notify_all();
    }
}

impl Storage for Staged {
    fn list_markdown(&self, folder: &str) -> Result<Vec<String>> {
        self.inner.list_markdown(folder)
    }
    fn read(&self, path: &str) -> Result<String> {
        let found = self.inner.read(path);
        if self.hold_next_read.swap(false, Ordering::SeqCst) {
            let mut gate = self.gate.lock().unwrap();
            gate.0 = true;
            self.changed.notify_all();
            let _released = self.changed.wait_while(gate, |g| !g.1).unwrap();
        }
        found
    }
    fn create(&self, path: &str, content: &str) -> Result<()> {
        self.inner.create(path, content)
    }
    fn modify(&self, path: &str, f: &mut dyn FnMut(&str) -> Result<String>) -> Result<String> {
        self.inner.modify(path, f)
    }
    fn remove(&self, path: &str) -> Result<()> {
        self.inner.remove(path)
    }
    fn exists(&self, path: &str) -> bool {
        self.inner.exists(path)
    }
    fn stamp(&self, path: &str) -> Option<Stamp> {
        match self.frozen {
            Some(stamp) => self.inner.exists(path).then_some(stamp),
            None => self.inner.stamp(path),
        }
    }
}

fn staged_index(storage: &Arc<Staged>) -> Arc<CardIndex> {
    let index = CardIndex::start(
        Arc::clone(storage),
        BoardConfig::default(),
        IndexOptions {
            reconcile_every: Duration::from_secs(3600),
            debounce: Duration::from_millis(30),
            watch_vault_root: None,
            first_load_timeout: PATIENCE,
        },
    );
    assert!(index.wait_until_loaded(PATIENCE));
    index
}

fn write_titled(root: &Path, title: &str) {
    let mut card = sample_card("OP-1", "todo", "V");
    card.title = title.into();
    write_card(root, &card);
}

fn now_ns() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
}

#[test]
fn a_fresh_stamp_that_never_changes_does_not_hide_an_edit() {
    // A coarse file system can give two different contents of one length the same stamp. While the stamp is that fresh,
    // the index must read again.
    let dir = temp_vault();
    write_titled(dir.path(), "aaaa");
    let storage = Staged::new(dir.path(), Some(now_ns()));
    let index = staged_index(&storage);
    assert_eq!(titles(&index), ["aaaa"]);
    for i in 0..10 {
        let title = if i % 2 == 0 { "bbbb" } else { "cccc" };
        write_titled(dir.path(), title);
        index.refresh_path("Cards/OP-1.md");
        assert_eq!(titles(&index), [title], "round {i}");
    }
}

#[test]
fn an_old_stamp_that_has_not_changed_is_trusted_and_the_note_is_not_read_again() {
    // The other half of the rule above: what makes the saving real.
    let dir = temp_vault();
    write_titled(dir.path(), "aaaa");
    let storage = Staged::new(dir.path(), Some(now_ns() - 3_600_000_000_000));
    let index = staged_index(&storage);
    assert_eq!(index.stats().notes_read, 1);
    write_titled(dir.path(), "bbbb");
    index.refresh_path("Cards/OP-1.md");
    index.reconcile();
    assert_eq!(titles(&index), ["aaaa"], "the stamp said nothing changed");
    assert_eq!(index.stats().notes_read, 1);
}

#[test]
fn a_slow_read_of_an_old_version_cannot_overwrite_a_newer_one() {
    let dir = temp_vault();
    write_titled(dir.path(), "original");
    let storage = Staged::new(dir.path(), None);
    let index = staged_index(&storage);

    write_titled(dir.path(), "stale");
    storage.hold_next_read();
    let slow = {
        let index = Arc::clone(&index);
        std::thread::spawn(move || index.refresh_path("Cards/OP-1.md"))
    };
    storage.wait_reached(); // it has read "stale" and is about to hand it over

    write_titled(dir.path(), "fresh");
    index.refresh_path("Cards/OP-1.md");
    assert_eq!(titles(&index), ["fresh"]);

    storage.release();
    slow.join().unwrap();
    assert_eq!(titles(&index), ["fresh"], "the slow read of the old version won");
}

#[test]
fn a_slow_read_cannot_bring_back_a_note_that_was_deleted_in_the_meantime() {
    let dir = temp_vault();
    write_titled(dir.path(), "original");
    let storage = Staged::new(dir.path(), None);
    let index = staged_index(&storage);

    write_titled(dir.path(), "edited");
    storage.hold_next_read();
    let slow = {
        let index = Arc::clone(&index);
        std::thread::spawn(move || index.refresh_path("Cards/OP-1.md"))
    };
    storage.wait_reached();

    fs::remove_file(dir.path().join("Cards/OP-1.md")).unwrap();
    index.refresh_path("Cards/OP-1.md");
    assert!(index.is_empty());

    storage.release();
    slow.join().unwrap();
    assert!(index.is_empty(), "a note that was seen deleted came back from a slower, older read: {:?}", keys(&index));
}

#[test]
fn a_slow_read_cannot_bring_back_a_note_the_writer_just_removed() {
    let dir = temp_vault();
    write_titled(dir.path(), "original");
    let storage = Staged::new(dir.path(), None);
    let index = staged_index(&storage);

    write_titled(dir.path(), "edited");
    storage.hold_next_read();
    let slow = {
        let index = Arc::clone(&index);
        std::thread::spawn(move || index.refresh_path("Cards/OP-1.md"))
    };
    storage.wait_reached();

    fs::remove_file(dir.path().join("Cards/OP-1.md")).unwrap();
    index.forget_path("Cards/OP-1.md");
    assert!(index.is_empty());

    storage.release();
    slow.join().unwrap();
    assert!(index.is_empty(), "a removed note came back from a slower, older read: {:?}", keys(&index));
}

// --- concurrency ------------------------------------------------------------------------------------------------------

#[test]
fn readers_never_see_a_torn_or_duplicated_snapshot_while_a_writer_adds_notes() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    let index = polled(dir.path());
    let root = dir.path().to_path_buf();
    std::thread::scope(|scope| {
        let writer_index = Arc::clone(&index);
        scope.spawn(move || {
            for i in 2..=150 {
                write_card(&root, &sample_card(&format!("OP-{i}"), "todo", &format!("V{i:04}")));
                writer_index.refresh_path(&format!("Cards/OP-{i}.md"));
            }
        });
        for _ in 0..4 {
            let index = Arc::clone(&index);
            scope.spawn(move || {
                let mut seen = 0;
                for _ in 0..400 {
                    let snapshot = index.snapshot();
                    let unique: std::collections::HashSet<&str> = snapshot.iter().map(|c| c.key.as_str()).collect();
                    assert_eq!(unique.len(), snapshot.len(), "a card appeared twice in one snapshot");
                    assert!(
                        snapshot.len() >= seen,
                        "notes are only added: a snapshot shrank from {seen} to {}",
                        snapshot.len()
                    );
                    seen = snapshot.len();
                }
            });
        }
    });
    assert!(eventually(PATIENCE, || index.len() == 150));
}

#[test]
fn an_index_that_was_hammered_by_creates_deletes_refreshes_and_reconciles_ends_up_equal_to_the_disk() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    let index = polled(dir.path());
    let root = dir.path().to_path_buf();
    std::thread::scope(|scope| {
        for worker in 0..3 {
            let (root, index) = (root.clone(), Arc::clone(&index));
            scope.spawn(move || {
                for round in 0..120 {
                    let key = format!("OP-{}", 10 + (round + worker) % 6);
                    let path = format!("Cards/{key}.md");
                    if round % 3 == 0 {
                        let _ = fs::remove_file(root.join(&path));
                    } else {
                        write_card(&root, &sample_card(&key, "todo", &format!("V{round:03}")));
                    }
                    index.refresh_path(&path);
                    if round % 17 == 0 {
                        index.reconcile();
                    }
                }
            });
        }
    });
    // settle, then compare with what is on disk
    index.reconcile();
    let mut on_disk: Vec<String> = fs::read_dir(dir.path().join("Cards"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().trim_end_matches(".md").to_string())
        .collect();
    on_disk.sort();
    let mut in_index = keys(&index);
    in_index.sort();
    assert_eq!(in_index, on_disk, "the index and the disk disagree after the dust settled");
}

#[test]
fn dropping_an_index_while_it_is_still_loading_does_not_hang() {
    let dir = temp_vault();
    write_vault_cards(dir.path(), 1500);
    let began = Instant::now();
    let index = watched(dir.path());
    drop(index);
    assert!(began.elapsed() < Duration::from_secs(20), "dropping took {:?}", began.elapsed());
}

#[test]
fn a_snapshot_gives_up_waiting_for_a_slow_first_load_and_the_index_still_completes_it() {
    struct Slow(FsStorage);
    impl Storage for Slow {
        fn list_markdown(&self, folder: &str) -> Result<Vec<String>> {
            self.0.list_markdown(folder)
        }
        fn list_stamped(&self, folder: &str) -> Result<Vec<(String, Option<Stamp>)>> {
            std::thread::sleep(Duration::from_millis(600));
            self.0.list_stamped(folder)
        }
        fn read(&self, path: &str) -> Result<String> {
            self.0.read(path)
        }
        fn create(&self, path: &str, content: &str) -> Result<()> {
            self.0.create(path, content)
        }
        fn modify(&self, path: &str, f: &mut dyn FnMut(&str) -> Result<String>) -> Result<String> {
            self.0.modify(path, f)
        }
        fn remove(&self, path: &str) -> Result<()> {
            self.0.remove(path)
        }
        fn exists(&self, path: &str) -> bool {
            self.0.exists(path)
        }
        fn stamp(&self, path: &str) -> Option<Stamp> {
            self.0.stamp(path)
        }
    }
    let dir = temp_vault();
    write_vault_cards(dir.path(), 10);
    let index = CardIndex::start(
        Arc::new(Slow(FsStorage::new(dir.path()))),
        BoardConfig::default(),
        IndexOptions {
            first_load_timeout: Duration::from_millis(50),
            reconcile_every: Duration::from_secs(3600),
            ..IndexOptions::default()
        },
    );
    let began = Instant::now();
    assert!(index.snapshot().is_empty(), "the first load is still running: the snapshot has nothing yet");
    assert!(
        began.elapsed() < Duration::from_millis(400),
        "the snapshot waited for the slow load: {:?}",
        began.elapsed()
    );
    assert!(index.wait_until_loaded(PATIENCE));
    assert_eq!(index.snapshot().len(), 10);
}

#[test]
#[cfg(unix)]
fn a_note_that_cannot_be_read_is_skipped_and_picked_up_when_it_can() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "V"));
    write_card(dir.path(), &sample_card("OP-2", "todo", "W"));
    let locked = dir.path().join("Cards/OP-2.md");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    if fs::read(&locked).is_ok() {
        return; // running as a user that ignores permissions (root): nothing to test
    }
    let index = start_with(dir.path(), false, Duration::from_secs(3600));
    assert_eq!(keys(&index), ["OP-1"], "an unreadable note must not fail the index");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
    make_old(&locked);
    index.reconcile();
    assert_eq!(keys(&index), ["OP-1", "OP-2"]);
}
