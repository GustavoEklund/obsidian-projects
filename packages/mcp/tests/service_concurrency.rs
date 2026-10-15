//! Many writers at once: threads sharing one service, and several real operating-system processes each with its own,
//! all on one vault. This is where the TypeScript service had its races (more than eight parallel creates failed, edits
//! of one note lost each other), so each of those has a test here.
mod common;

use common::vaults::{temp_vault, write_card};
use oprojects_mcp::api::{Board, CardQuery, CommentInput};
use oprojects_mcp::card::parse_card;
use oprojects_mcp::error::Error;
use oprojects_mcp::service::{CardService, ServiceOptions};
use oprojects_mcp::storage::{FsStorage, MemoryStorage, Storage};
use oprojects_mcp::types::{BoardConfig, CardPatch, CardType, NewCardInput, Placement, Priority};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

fn counting_ids() -> ServiceOptions {
    let next = Arc::new(AtomicU64::new(0));
    ServiceOptions {
        new_id: Arc::new(move || format!("c{}", next.fetch_add(1, Ordering::SeqCst))),
        ..ServiceOptions::default()
    }
}

fn board() -> BoardConfig {
    BoardConfig { me: "Ana".into(), ..BoardConfig::default() }
}

fn titled(title: &str) -> NewCardInput {
    NewCardInput { title: title.into(), ..NewCardInput::default() }
}

// --- threads ----------------------------------------------------------------------------------------------------------

fn parallel_creates_get_consecutive_keys<S: Storage>(storage: S) {
    let service = Arc::new(CardService::new(storage, board(), counting_ids()));
    let (threads, each) = (8, 12);
    let keys: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let service = Arc::clone(&service);
                scope.spawn(move || {
                    (0..each).map(|i| service.create(titled(&format!("t{t} n{i}"))).unwrap().key).collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    let unique: BTreeSet<&String> = keys.iter().collect();
    assert_eq!(unique.len(), threads * each, "a key was handed out twice");
    let wanted: BTreeSet<String> = (1..=threads * each).map(|n| format!("OP-{n}")).collect();
    assert_eq!(
        keys.iter().cloned().collect::<BTreeSet<_>>(),
        wanted,
        "the keys must be consecutive, with no gap and no failure"
    );
    assert_eq!(service.list().unwrap().len(), threads * each);
}

#[test]
fn more_than_eight_parallel_creates_all_succeed_with_consecutive_keys_in_memory() {
    parallel_creates_get_consecutive_keys(Arc::new(MemoryStorage::new()));
}

#[test]
fn more_than_eight_parallel_creates_all_succeed_with_consecutive_keys_on_disk() {
    let dir = temp_vault();
    parallel_creates_get_consecutive_keys(Arc::new(FsStorage::new(dir.path())));
}

#[test]
fn updates_to_different_fields_of_one_card_from_many_threads_are_all_kept() {
    let service = Arc::new(CardService::new(Arc::new(MemoryStorage::new()), board(), counting_ids()));
    service.create(titled("Contended")).unwrap();
    service.create(titled("Parent")).unwrap();
    let patches: Vec<CardPatch> = vec![
        CardPatch { title: Some("Retitled".into()), ..CardPatch::default() },
        CardPatch { priority: Some(Priority::Highest), ..CardPatch::default() },
        CardPatch { card_type: Some(CardType::Epic), ..CardPatch::default() },
        CardPatch { assignee: Some(Some("Bruno".into())), ..CardPatch::default() },
        CardPatch { labels: Some(vec!["x".into(), "y".into()]), ..CardPatch::default() },
        CardPatch { due: Some(Some("2027-01-31".into())), ..CardPatch::default() },
        CardPatch { estimate: Some(Some(8.0)), ..CardPatch::default() },
        CardPatch { parent: Some(Some("OP-2".into())), ..CardPatch::default() },
        CardPatch { body: Some("A new description".into()), ..CardPatch::default() },
    ];
    std::thread::scope(|scope| {
        for patch in &patches {
            let service = Arc::clone(&service);
            scope.spawn(move || {
                for _ in 0..25 {
                    service.update("OP-1", patch.clone()).unwrap();
                }
            });
        }
    });
    let card = service.get("OP-1").unwrap();
    assert_eq!(card.title, "Retitled");
    assert_eq!(card.priority, Priority::Highest);
    assert_eq!(card.card_type, CardType::Epic);
    assert_eq!(card.assignee.as_deref(), Some("Bruno"));
    assert_eq!(card.labels, ["x", "y"]);
    assert_eq!(card.due.as_deref(), Some("2027-01-31"));
    assert_eq!(card.estimate, Some(8.0));
    assert_eq!(card.parent.as_deref(), Some("OP-2"));
    assert_eq!(card.body.trim(), "A new description");
}

#[test]
fn comments_added_at_the_same_moment_are_all_there_with_their_own_ids() {
    let service = Arc::new(CardService::new(Arc::new(MemoryStorage::new()), board(), counting_ids()));
    service.create(titled("Busy thread")).unwrap();
    let (threads, each) = (16, 5);
    std::thread::scope(|scope| {
        for t in 0..threads {
            let service = Arc::clone(&service);
            scope.spawn(move || {
                for i in 0..each {
                    service.add_comment("1", CommentInput { text: format!("t{t} c{i}"), author: None }).unwrap();
                }
            });
        }
    });
    let card = service.get("1").unwrap();
    assert_eq!(card.comments.len(), threads * each, "a comment was lost");
    let ids: BTreeSet<&str> = card.comments.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids.len(), threads * each, "two comments share an id");
    let texts: BTreeSet<&str> = card.comments.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(texts.len(), threads * each);
}

#[test]
fn a_storm_of_every_operation_at_once_leaves_a_consistent_board_and_panics_nowhere() {
    let dir = temp_vault();
    let service = Arc::new(CardService::new(Arc::new(FsStorage::new(dir.path())), board(), counting_ids()));
    for i in 0..10 {
        service.create(titled(&format!("seed {i}"))).unwrap();
    }
    let columns = ["todo", "doing", "review", "done"];
    std::thread::scope(|scope| {
        for t in 0..6u64 {
            let service = Arc::clone(&service);
            scope.spawn(move || {
                let mut x = t * 7919 + 13;
                let mut next = || {
                    x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    (x >> 33) as usize
                };
                for _ in 0..80 {
                    let key = format!("OP-{}", 1 + next() % 30);
                    // Errors are fine (the card may be gone, a column may be crowded); panics and corruption are not.
                    let _ = match next() % 9 {
                        0 => service.create(titled("storm")).map(drop),
                        1 => service
                            .update(
                                &key,
                                CardPatch { title: Some(format!("t{}", next() % 100)), ..CardPatch::default() },
                            )
                            .map(drop),
                        2 => service
                            .update(
                                &key,
                                CardPatch { status: Some(columns[next() % 4].into()), ..CardPatch::default() },
                            )
                            .map(drop),
                        3 => service.move_card(&key, columns[next() % 4], Placement::default()).map(drop),
                        4 => service
                            .move_card(
                                &key,
                                columns[next() % 4],
                                Placement { before: Some(format!("OP-{}", 1 + next() % 30)), after: None },
                            )
                            .map(drop),
                        5 => service.add_comment(&key, CommentInput { text: "storm".into(), author: None }).map(drop),
                        6 => service.remove(&key).map(drop),
                        7 => service.find(&CardQuery { text: Some("storm".into()), ..CardQuery::default() }).map(drop),
                        _ => service.list().map(drop),
                    };
                }
            });
        }
    });
    // everything on disk is a card, and no key appears twice
    let mut keys = Vec::new();
    for entry in fs::read_dir(dir.path().join("Cards")).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(!name.starts_with('.'), "a temp file was left behind: {name}");
        let card = parse_card(&format!("Cards/{name}"), &fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|| panic!("{name} is no longer a card"));
        keys.push(card.key);
    }
    let unique: BTreeSet<&String> = keys.iter().collect();
    assert_eq!(unique.len(), keys.len(), "a key appeared in two notes: {keys:?}");
    assert_eq!(service.list().unwrap().len(), keys.len());
}

#[test]
fn two_services_over_one_vault_never_hand_out_the_same_key() {
    // Two services stand for two programs (the plugin and the server) that do not know about each other.
    let dir = temp_vault();
    let services: Vec<Arc<CardService<Arc<FsStorage>>>> = (0..2)
        .map(|_| Arc::new(CardService::new(Arc::new(FsStorage::new(dir.path())), board(), counting_ids())))
        .collect();
    let keys: Vec<String> = std::thread::scope(|scope| {
        let handles: Vec<_> = services
            .iter()
            .map(|service| {
                let service = Arc::clone(service);
                scope.spawn(move || {
                    (0..30).map(|i| service.create(titled(&format!("n{i}"))).unwrap().key).collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    let unique: BTreeSet<&String> = keys.iter().collect();
    assert_eq!(unique.len(), 60, "{keys:?}");
}

// --- processes --------------------------------------------------------------------------------------------------------
//
// These re-run this very test binary as child processes (`child_entry` does nothing unless the environment asks), so the
// writers are separate operating-system processes with nothing in common but the folder.

fn spawn_children(root: &Path, count: usize, each: usize) -> Vec<std::process::Child> {
    (0..count)
        .map(|id| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "child_entry", "--nocapture", "--test-threads=1"])
                .env("OPROJECTS_SERVICE_ROOT", root)
                .env("OPROJECTS_SERVICE_ID", id.to_string())
                .env("OPROJECTS_SERVICE_EACH", each.to_string())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn a child")
        })
        .collect()
}

#[test]
fn child_entry() {
    let Ok(root) = std::env::var("OPROJECTS_SERVICE_ROOT") else { return };
    let id = std::env::var("OPROJECTS_SERVICE_ID").unwrap();
    let each: usize = std::env::var("OPROJECTS_SERVICE_EACH").unwrap().parse().unwrap();
    while !Path::new(&root).join(".go").exists() {
        std::thread::yield_now();
    }
    let service = CardService::new(FsStorage::new(&root), board(), ServiceOptions::default());
    let mut created = String::new();
    let mut gave_up = 0;
    for i in 0..each {
        // like a client would: losing the race for a key eight times in a row is an error worth retrying
        let mut result = service.create(titled(&format!("writer {id} card {i}")));
        for _ in 0..20 {
            match &result {
                Err(Error::Format(m)) if m.starts_with("Could not allocate") => {
                    result = service.create(titled(&format!("writer {id} card {i}")));
                }
                _ => break,
            }
        }
        match result {
            Ok(card) => created.push_str(&format!("{}\n", card.key)),
            Err(_) => gave_up += 1,
        }
    }
    fs::write(Path::new(&root).join(format!(".created-{id}")), created).unwrap();
    std::process::exit(gave_up);
}

#[test]
fn several_processes_creating_cards_in_one_vault_never_collide_or_lose_a_card() {
    for round in 0..3 {
        let dir = temp_vault();
        let (children, each) = (4, 15);
        let running = spawn_children(dir.path(), children, each);
        fs::write(dir.path().join(".go"), "").unwrap();
        let codes: Vec<i32> = running.into_iter().map(|mut c| c.wait().unwrap().code().unwrap_or(-1)).collect();
        assert!(codes.iter().all(|c| *c == 0), "round {round}: a writer gave up or crashed: {codes:?}");

        let mut claimed = Vec::new();
        for id in 0..children {
            claimed.extend(
                fs::read_to_string(dir.path().join(format!(".created-{id}"))).unwrap().lines().map(String::from),
            );
        }
        let unique: BTreeSet<&String> = claimed.iter().collect();
        assert_eq!(claimed.len(), children * each, "round {round}: some creates did not finish");
        assert_eq!(unique.len(), claimed.len(), "round {round}: two processes were given the same key: {claimed:?}");

        // every key a writer was told about is a note on disk holding that writer's card, and there is nothing else
        let service = CardService::new(FsStorage::new(dir.path()), board(), ServiceOptions::default());
        let cards = service.list().unwrap();
        assert_eq!(cards.len(), children * each, "round {round}: a card was lost");
        for card in &cards {
            assert!(unique.contains(&card.key), "round {round}: {} is on disk but nobody was told about it", card.key);
            assert!(card.title.starts_with("writer "), "{}", card.title);
        }
    }
}

#[test]
fn a_card_written_by_another_program_between_two_creates_is_not_overwritten() {
    let dir = temp_vault();
    let service = CardService::new(FsStorage::new(dir.path()), board(), ServiceOptions::default());
    service.create(titled("Mine")).unwrap();
    write_card(dir.path(), &common::vaults::sample_card("OP-2", "todo", "Z"));
    let next = service.create(titled("Also mine")).unwrap();
    assert_eq!(next.key, "OP-3");
    assert!(fs::read_to_string(dir.path().join("Cards/OP-2.md")).unwrap().contains("with a reasonably long title"));
}
