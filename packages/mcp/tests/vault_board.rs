//! `open_vault`: the composition root. Configuration from the vault, the index and its watcher wired in, reads that see
//! other programs' edits, writes that other readers see, and a board that can be handed around as a `dyn Board`.
mod common;

use common::vaults::{PATIENCE, eventually, sample_card, temp_vault, write_card, write_vault_cards};
use oprojects_mcp::Error;
use oprojects_mcp::api::{Board, CardQuery, CommentInput};
use oprojects_mcp::index::IndexOptions;
use oprojects_mcp::types::{BoardConfig, CardPatch, NewCardInput, Placement, Priority};
use oprojects_mcp::vault::{VaultBoard, VaultOptions, open_vault};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

const T0: i64 = 1_792_065_600_000; // 2026-10-15T12:00:00.000Z

/// Quick events, no periodic reconciliation to speak of: what a test sees came from the watcher.
fn watching() -> VaultOptions {
    VaultOptions {
        index: IndexOptions {
            reconcile_every: Duration::from_secs(3600),
            debounce: Duration::from_millis(30),
            first_load_timeout: PATIENCE,
            ..IndexOptions::default()
        },
        utc_offset_minutes: Some(0),
        ..VaultOptions::default()
    }
}

/// No watcher: only the (fast) reconciliation keeps the index current.
fn polling() -> VaultOptions {
    VaultOptions {
        watch: false,
        index: IndexOptions {
            reconcile_every: Duration::from_millis(40),
            first_load_timeout: PATIENCE,
            ..IndexOptions::default()
        },
        utc_offset_minutes: Some(0),
        ..VaultOptions::default()
    }
}

fn titled(title: &str) -> NewCardInput {
    NewCardInput { title: title.into(), ..NewCardInput::default() }
}

fn keys(board: &dyn Board) -> Vec<String> {
    board.list().unwrap().iter().map(|c| c.key.clone()).collect()
}

fn write_data(root: &Path, json: &str) {
    let file = root.join(".obsidian/plugins/obsidian-projects/data.json");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, json).unwrap();
}

// --- opening ----------------------------------------------------------------------------------------------------------

#[test]
fn a_folder_that_does_not_exist_is_not_a_vault() {
    let dir = temp_vault();
    let error = open_vault(&dir.path().join("nowhere"), VaultOptions::default()).err().expect("must fail");
    assert!(matches!(error, Error::VaultNotFound(_)), "{error:?}");
    assert!(error.to_string().contains("nowhere"), "{error}");
}

#[test]
fn a_file_is_not_a_vault_either() {
    let dir = temp_vault();
    fs::write(dir.path().join("note.md"), "hi").unwrap();
    let error = open_vault(&dir.path().join("note.md"), VaultOptions::default()).err().expect("must fail");
    assert!(matches!(error, Error::VaultNotFound(_)), "{error:?}");
}

#[test]
fn a_vault_without_settings_gets_the_default_board() {
    let dir = temp_vault();
    let board = open_vault(dir.path(), watching()).unwrap();
    assert_eq!(board.config(), &BoardConfig::default());
    // The root is the path that was given (made absolute, lexically clean), not its canonical form: on macOS the temp
    // folder is reached through the `/var` symlink and must stay spelled that way.
    assert_eq!(board.root(), dir.path());
    assert!(board.list().unwrap().is_empty());

    let card = board.create(titled("First")).unwrap();
    assert_eq!(card.key, "OP-1");
    assert_eq!(card.path, "Cards/OP-1.md");
    assert_eq!(card.status, "todo");
    assert!(dir.path().join("Cards/OP-1.md").is_file());
}

#[test]
fn the_boards_prefix_folder_and_columns_come_from_the_plugins_data_file() {
    let dir = temp_vault();
    write_data(
        dir.path(),
        r#"{"board":{"folder":"Work/Items","prefix":"ACME","me":"Ana","members":["Ana","Bruno"],
            "columns":[{"id":"backlog","name":"Backlog"},{"id":"shipped","name":"Shipped","done":true}]}}"#,
    );
    let board = open_vault(dir.path(), watching()).unwrap();
    assert_eq!(board.config().prefix, "ACME");
    assert_eq!(board.config().folder, "Work/Items");
    assert_eq!(board.config().me, "Ana");
    assert_eq!(board.config().columns.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["backlog", "shipped"]);

    let card = board.create(titled("Custom")).unwrap();
    assert_eq!(card.key, "ACME-1");
    assert_eq!(card.path, "Work/Items/ACME-1.md");
    assert_eq!(card.status, "backlog");
    assert!(dir.path().join("Work/Items/ACME-1.md").is_file());
    // Cards outside the configured folder are not this board's.
    write_card(dir.path(), &sample_card("OP-1", "todo", "M"));
    assert_eq!(keys(&*board), ["ACME-1"]);
}

#[test]
fn a_data_file_that_is_not_json_falls_back_to_the_defaults() {
    let dir = temp_vault();
    write_data(dir.path(), "{ this is not json");
    let board = open_vault(dir.path(), watching()).unwrap();
    assert_eq!(board.config(), &BoardConfig::default());
}

#[test]
fn open_returns_quickly_even_when_the_vault_is_big() {
    let dir = temp_vault();
    write_vault_cards(dir.path(), 1500);
    let began = std::time::Instant::now();
    let board = open_vault(dir.path(), watching()).unwrap();
    assert!(began.elapsed() < Duration::from_millis(500), "open waited for the load: {:?}", began.elapsed());
    // The first list waits for the load and then has everything.
    assert_eq!(board.list().unwrap().len(), 1500);
}

// --- reading what others write ---------------------------------------------------------------------------------------

#[test]
fn an_edit_made_by_another_program_shows_in_get_at_once_and_in_list_when_the_event_arrives() {
    let dir = temp_vault();
    write_card(dir.path(), &sample_card("OP-1", "todo", "M"));
    let board = open_vault(dir.path(), watching()).unwrap();
    assert_eq!(board.list().unwrap().len(), 1);

    // The plugin (or a sync client) rewrites the note and adds another.
    let mut edited = sample_card("OP-1", "doing", "M");
    edited.title = "Edited elsewhere".into();
    write_card(dir.path(), &edited);
    write_card(dir.path(), &sample_card("OP-2", "todo", "N"));

    assert_eq!(board.get("OP-1").unwrap().title, "Edited elsewhere");
    assert_eq!(board.get("OP-2").unwrap().key, "OP-2");
    assert!(
        eventually(PATIENCE, || {
            let cards = board.list().unwrap();
            cards.len() == 2 && cards.iter().any(|c| c.title == "Edited elsewhere" && c.status == "doing")
        }),
        "the watcher never delivered: {:?}",
        keys(&*board)
    );
    assert!(board.index().unwrap().stats().watching);
}

#[test]
fn a_note_deleted_by_another_program_leaves_the_list() {
    let dir = temp_vault();
    write_vault_cards(dir.path(), 3);
    let board = open_vault(dir.path(), watching()).unwrap();
    assert_eq!(board.list().unwrap().len(), 3);
    fs::remove_file(dir.path().join("Cards/OP-2.md")).unwrap();
    assert!(eventually(PATIENCE, || !keys(&*board).contains(&"OP-2".to_string())));
    assert!(matches!(board.get("OP-2"), Err(Error::NotFound(_))));
}

#[test]
fn without_a_watcher_the_reconciliation_picks_up_what_others_wrote() {
    let dir = temp_vault();
    write_vault_cards(dir.path(), 2);
    let board = open_vault(dir.path(), polling()).unwrap();
    assert_eq!(board.list().unwrap().len(), 2);
    assert!(!board.index().unwrap().stats().watching);

    write_card(dir.path(), &sample_card("OP-9", "review", "Z"));
    assert!(eventually(PATIENCE, || keys(&*board).contains(&"OP-9".to_string())));
}

#[test]
fn without_an_index_every_read_sees_the_disk() {
    let dir = temp_vault();
    write_vault_cards(dir.path(), 2);
    let board = open_vault(dir.path(), VaultOptions { use_index: false, ..VaultOptions::default() }).unwrap();
    assert!(board.index().is_none());
    assert_eq!(board.list().unwrap().len(), 2);

    write_card(dir.path(), &sample_card("OP-7", "todo", "Z"));
    assert_eq!(board.list().unwrap().len(), 3, "no index means no waiting for events");
    fs::remove_file(dir.path().join("Cards/OP-1.md")).unwrap();
    assert!(!keys(&*board).contains(&"OP-1".to_string()));
    let created = board.create(titled("Next")).unwrap();
    assert_eq!(created.key, "OP-8");
}

// --- writing: the next read sees it -----------------------------------------------------------------------------------

#[test]
fn my_own_writes_are_visible_to_the_very_next_read_without_waiting_for_events() {
    let dir = temp_vault();
    // Reconciliation and watcher are both out of the picture: only the service telling the index can explain what follows.
    let board = open_vault(
        dir.path(),
        VaultOptions {
            watch: false,
            index: IndexOptions { reconcile_every: Duration::from_secs(3600), ..IndexOptions::default() },
            ..watching()
        },
    )
    .unwrap();
    assert!(board.list().unwrap().is_empty());

    let a = board.create(titled("A")).unwrap();
    let b = board.create(titled("B")).unwrap();
    assert_eq!(keys(&*board), [a.key.clone(), b.key.clone()]);

    board.update(&a.key, CardPatch { priority: Some(Priority::Highest), ..CardPatch::default() }).unwrap();
    assert_eq!(
        board.find(&CardQuery { text: Some("a".into()), ..CardQuery::default() }).unwrap()[0].priority,
        Priority::Highest
    );

    board.move_card(&b.key, "doing", Placement::default()).unwrap();
    let listed = board.list().unwrap();
    assert_eq!(listed.iter().find(|c| c.key == b.key).unwrap().status, "doing");

    board.add_comment(&a.key, CommentInput { text: "hello".into(), author: Some("Ana".into()) }).unwrap();
    assert_eq!(board.list().unwrap().iter().find(|c| c.key == a.key).unwrap().comments.len(), 1);

    board.remove(&a.key).unwrap();
    assert_eq!(keys(&*board), std::slice::from_ref(&b.key));
    assert!(matches!(board.get(&a.key), Err(Error::NotFound(_))));
}

#[test]
fn two_boards_on_one_vault_never_hand_out_the_same_key_and_see_each_other() {
    let dir = temp_vault();
    let first = open_vault(dir.path(), watching()).unwrap();
    let second = open_vault(dir.path(), watching()).unwrap();

    let made: Vec<String> = std::thread::scope(|scope| {
        let workers: Vec<_> = [&first, &second]
            .into_iter()
            .map(|board| {
                scope.spawn(move || {
                    (0..15).map(|i| board.create(titled(&format!("Card {i}"))).unwrap().key).collect::<Vec<_>>()
                })
            })
            .collect();
        workers.into_iter().flat_map(|w| w.join().unwrap()).collect()
    });
    let unique: HashSet<&String> = made.iter().collect();
    assert_eq!(unique.len(), 30, "a key was handed out twice: {made:?}");
    assert_eq!(fs::read_dir(dir.path().join("Cards")).unwrap().count(), 30);

    // Each sees the other's cards: directly at once, and in the list once the events have been delivered.
    for key in &made {
        assert_eq!(first.get(key).unwrap().key, *key);
        assert_eq!(second.get(key).unwrap().key, *key);
    }
    assert!(eventually(PATIENCE, || first.list().unwrap().len() == 30 && second.list().unwrap().len() == 30));
}

// --- time -------------------------------------------------------------------------------------------------------------

fn clocked(offset: i32, now_ms: i64) -> (Arc<VaultBoard>, tempfile::TempDir, Arc<AtomicI64>) {
    let dir = temp_vault();
    let clock = Arc::new(AtomicI64::new(now_ms));
    let board = open_vault(
        dir.path(),
        VaultOptions {
            utc_offset_minutes: Some(offset),
            clock: Some({
                let c = Arc::clone(&clock);
                Arc::new(move || c.load(Ordering::SeqCst))
            }),
            ..watching()
        },
    )
    .unwrap();
    (board, dir, clock)
}

#[test]
fn today_follows_the_local_offset_not_utc() {
    let early = T0 - 630 * 60_000; // 2026-10-15T01:30Z
    let late = T0 + 690 * 60_000; // 2026-10-15T23:30Z
    for (offset, now, expected) in [
        (-180, early, "2026-10-14"),
        (0, early, "2026-10-15"),
        (14 * 60, early, "2026-10-15"),
        (0, late, "2026-10-15"),
        (120, late, "2026-10-16"),
        (-12 * 60, late, "2026-10-15"),
    ] {
        let (board, _dir, _clock) = clocked(offset, now);
        assert_eq!(board.today(), expected, "offset {offset} at {now}");
    }
}

#[test]
fn the_injected_clock_stamps_created_and_updated() {
    let (board, _dir, clock) = clocked(0, T0);
    let card = board.create(titled("Stamped")).unwrap();
    assert_eq!(card.created, "2026-10-15T12:00:00.000Z");
    clock.store(T0 + 5_000, Ordering::SeqCst);
    let moved = board.move_card(&card.key, "done", Placement::default()).unwrap();
    assert_eq!(moved.updated, "2026-10-15T12:00:05.000Z");
    assert_eq!(moved.resolved.as_deref(), Some("2026-10-15T12:00:05.000Z"));
}

#[test]
fn without_an_injected_offset_the_board_reads_the_local_one_once() {
    let dir = temp_vault();
    let board = open_vault(dir.path(), VaultOptions::default()).unwrap();
    let today = board.today();
    assert_eq!(today.len(), 10);
    assert_eq!(today.matches('-').count(), 2);
}

// --- as a trait object --------------------------------------------------------------------------------------------------

#[test]
fn it_works_as_the_arc_dyn_board_the_tools_are_given() {
    let dir = temp_vault();
    let board: Arc<dyn Board> = open_vault(dir.path(), watching()).unwrap();
    let shared = Arc::clone(&board);
    let handle = std::thread::spawn(move || shared.create(titled("From a thread")).unwrap().key);
    let key = handle.join().unwrap();
    assert_eq!(board.resolve_key("1").unwrap(), key);
    assert_eq!(board.list().unwrap().len(), 1);
    assert_eq!(board.config().prefix, "OP");
}

#[test]
fn dropping_the_board_leaves_the_vault_alone() {
    let dir = temp_vault();
    let board = open_vault(dir.path(), watching()).unwrap();
    board.create(titled("Stays")).unwrap();
    drop(board);
    assert!(dir.path().join("Cards/OP-1.md").is_file());
    let reopened = open_vault(dir.path(), watching()).unwrap();
    assert_eq!(reopened.list().unwrap()[0].title, "Stays");
}
