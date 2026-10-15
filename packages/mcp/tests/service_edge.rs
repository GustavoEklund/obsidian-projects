//! `CardService` beyond what the conformance corpus replays: what an update leaves alone, the contract with the source of
//! cards (the index), time, ids, failing storages, and values that are large or strange.
mod common;

use common::vaults::{sample_card, temp_vault};
use oprojects_mcp::api::{Board, CardQuery, CommentInput};
use oprojects_mcp::error::{Error, Result};
use oprojects_mcp::service::{
    CardService, CardSource, ServiceOptions, local_utc_offset_minutes, parse_card_type, parse_priority, random_id,
};
use oprojects_mcp::storage::{FsStorage, MemoryStorage, Storage};
use oprojects_mcp::types::{BoardConfig, Card, CardPatch, CardType, NewCardInput, Placement, Priority};
use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const T0: i64 = 1_792_065_600_000; // 2026-10-15T12:00:00.000Z

fn config() -> BoardConfig {
    BoardConfig { me: "Ana".into(), ..BoardConfig::default() }
}

fn service_on<S: Storage>(storage: S) -> (CardService<S>, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(T0));
    let service = CardService::new(
        storage,
        config(),
        ServiceOptions {
            clock: {
                let c = Arc::clone(&clock);
                Arc::new(move || c.load(Ordering::SeqCst))
            },
            ..ServiceOptions::default()
        },
    );
    (service, clock)
}

fn memory() -> (CardService<Arc<MemoryStorage>>, Arc<MemoryStorage>, Arc<AtomicI64>) {
    let storage = Arc::new(MemoryStorage::new());
    let (service, clock) = service_on(Arc::clone(&storage));
    (service, storage, clock)
}

fn new_titled(title: &str) -> NewCardInput {
    NewCardInput { title: title.into(), ..NewCardInput::default() }
}

// --- an update touches only what it was asked to ----------------------------------------------------------------------

const HAND_EDITED: &str = "---\n# my note\nkey: OP-1\ntitle: Hand edited   # why\nstatus: doing\nrank: M\ncreated: 2026-10-01T10:00:00.000Z\nupdated: 2026-10-01T10:00:00.000Z\nrelated: [\"[[Other]]\"]\ncustom:\n  nested: yes\n  list:\n    - a\n    - b\n---\nBody here.\n\n## Comments\n\n> [!comment] Bruno\n> written by hand\n";

#[test]
fn an_update_leaves_every_line_it_did_not_touch_exactly_as_it_was() {
    let (service, storage, _clock) = memory();
    storage.insert("Cards/OP-1.md", HAND_EDITED);
    service.update("1", CardPatch { priority: Some(Priority::High), ..CardPatch::default() }).unwrap();
    let after = storage.read("Cards/OP-1.md").unwrap();
    let expected = HAND_EDITED
        .replace("updated: 2026-10-01T10:00:00.000Z", "updated: 2026-10-15T12:00:00.000Z")
        .replace("    - b\n---", "    - b\npriority: high\n---");
    assert_eq!(after, expected, "the comment spacing, the flow list, the nested map and the comments must survive");
}

#[test]
fn replacing_the_description_keeps_the_comments_section_and_the_hand_written_comment() {
    let (service, storage, _clock) = memory();
    storage.insert("Cards/OP-1.md", HAND_EDITED);
    let card = service.update("1", CardPatch { body: Some("Rewritten.".into()), ..CardPatch::default() }).unwrap();
    assert_eq!(card.body.trim_end(), "Rewritten.");
    assert_eq!(card.comments.len(), 1);
    assert_eq!(card.comments[0].text, "written by hand");
    let after = storage.read("Cards/OP-1.md").unwrap();
    assert!(after.contains("custom:\n  nested: yes\n  list:\n    - a\n    - b\n"), "{after}");
    assert!(after.contains("> [!comment] Bruno\n> written by hand"), "{after}");
}

#[test]
fn a_note_whose_frontmatter_cannot_be_patched_is_left_exactly_as_it_was() {
    let (service, storage, _clock) = memory();
    let broken = "---\nkey: OP-2\ntitle: Broken\nstatus: [oops\n---\nBody\n";
    storage.insert("Cards/OP-2.md", broken);
    // such a note does not parse as a card at all, so it cannot even be found
    assert!(matches!(
        service.update("2", CardPatch { title: Some("x".into()), ..CardPatch::default() }),
        Err(Error::NotFound(_))
    ));
    assert_eq!(storage.read("Cards/OP-2.md").unwrap(), broken);

    // a card that parses but whose frontmatter would be rewritten unsafely: a map-valued root
    let odd = "---\nkey: OP-3\ntitle: Odd\nstatus: todo\n---\nBody\n";
    storage.insert("Cards/OP-3.md", odd);
    service.update("3", CardPatch { title: Some("Fine".into()), ..CardPatch::default() }).unwrap();
}

#[test]
fn adding_a_comment_changes_only_the_comments_and_the_updated_stamp() {
    let (service, storage, clock) = memory();
    service
        .create(NewCardInput { title: "Discuss".into(), body: Some("Description.".into()), ..NewCardInput::default() })
        .unwrap();
    let before = storage.read("Cards/OP-1.md").unwrap();
    clock.store(T0 + 60_000, Ordering::SeqCst);
    service.add_comment("OP-1", CommentInput { text: "Hello".into(), author: None }).unwrap();
    let after = storage.read("Cards/OP-1.md").unwrap();
    let changed: Vec<&str> = after.lines().filter(|l| !before.lines().any(|b| b == *l)).collect();
    assert_eq!(
        changed.iter().filter(|l| !l.starts_with('>') && !l.starts_with("##") && !l.is_empty()).collect::<Vec<_>>(),
        [&"updated: 2026-10-15T12:01:00.000Z"]
    );
    assert!(after.contains("> Hello"));
}

// --- time ------------------------------------------------------------------------------------------------------------

#[test]
fn timestamps_are_utc_iso_strings_with_milliseconds() {
    let (service, _storage, clock) = memory();
    clock.store(T0 + 123, Ordering::SeqCst);
    let card = service.create(new_titled("Stamped")).unwrap();
    assert_eq!(card.created, "2026-10-15T12:00:00.123Z");
    assert_eq!(card.updated, card.created);
    clock.store(T0 + 3_600_000 + 7, Ordering::SeqCst);
    let card = service.update("1", CardPatch { priority: Some(Priority::Low), ..CardPatch::default() }).unwrap();
    assert_eq!(
        (card.created.as_str(), card.updated.as_str()),
        ("2026-10-15T12:00:00.123Z", "2026-10-15T13:00:00.007Z")
    );
}

#[test]
fn today_follows_the_local_offset_across_midnight() {
    let at = |ms: i64, offset: i32| {
        let clock = Arc::new(AtomicI64::new(ms));
        let c = Arc::clone(&clock);
        CardService::new(
            MemoryStorage::new(),
            config(),
            ServiceOptions {
                clock: Arc::new(move || c.load(Ordering::SeqCst)),
                utc_offset_minutes: offset,
                ..ServiceOptions::default()
            },
        )
        .today()
    };
    let late = T0 + 11 * 3_600_000 + 30 * 60_000; // 2026-10-15T23:30Z
    assert_eq!(at(late, 0), "2026-10-15");
    assert_eq!(at(late, 120), "2026-10-16");
    assert_eq!(at(late, 14 * 60), "2026-10-16");
    assert_eq!(at(late, -12 * 60), "2026-10-15");
    let early = T0 - 9 * 3_600_000; // 2026-10-15T03:00Z
    assert_eq!(at(early, -600), "2026-10-14");
    assert_eq!(at(early, 0), "2026-10-15");
    assert_eq!(at(0, 0), "1970-01-01");
    assert_eq!(at(-1, 0), "1969-12-31");
}

#[test]
fn comment_titles_show_local_wall_time_and_the_machine_readable_stamp_stays_utc() {
    let storage = Arc::new(MemoryStorage::new());
    let service = CardService::new(
        Arc::clone(&storage),
        config(),
        ServiceOptions { clock: Arc::new(|| T0), utc_offset_minutes: 90, ..ServiceOptions::default() },
    );
    service.create(new_titled("Zones")).unwrap();
    service.add_comment("1", CommentInput { text: "Local".into(), author: Some("Ana".into()) }).unwrap();
    let note = storage.read("Cards/OP-1.md").unwrap();
    assert!(note.contains("2026-10-15T12:00:00.000Z] Ana · 2026-10-15 13:30"), "{note}");
}

#[test]
fn reading_the_local_offset_never_fails_and_stays_within_a_day() {
    let offset = local_utc_offset_minutes();
    assert!((-24 * 60..=24 * 60).contains(&offset), "{offset}");
}

// --- ids ---------------------------------------------------------------------------------------------------------------

#[test]
fn random_ids_are_five_base_36_characters_and_hardly_ever_repeat() {
    let ids: Vec<String> = (0..1000).map(|_| random_id()).collect();
    assert!(
        ids.iter().all(|id| id.len() == 5 && id.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())),
        "{ids:?}"
    );
    let distinct: HashSet<&String> = ids.iter().collect();
    assert!(distinct.len() > 990, "only {} distinct ids out of 1000", distinct.len());
}

#[test]
fn an_id_that_is_taken_is_asked_for_again() {
    let storage = Arc::new(MemoryStorage::new());
    let queue =
        Arc::new(Mutex::new(vec!["z", "z", "z", "y", "x"].into_iter().rev().map(String::from).collect::<Vec<_>>()));
    let service = CardService::new(
        Arc::clone(&storage),
        config(),
        ServiceOptions {
            new_id: Arc::new(move || queue.lock().unwrap().pop().unwrap_or_else(|| "last".into())),
            ..ServiceOptions::default()
        },
    );
    service.create(new_titled("Ids")).unwrap();
    let first = service.add_comment("1", CommentInput { text: "one".into(), author: None }).unwrap();
    let second = service.add_comment("1", CommentInput { text: "two".into(), author: None }).unwrap();
    assert_eq!(first.comments[0].id, "z");
    assert_eq!(second.comments[1].id, "y", "z was taken twice over, so the next ones were skipped");
}

#[test]
fn the_type_and_priority_helpers_name_what_would_be_valid() {
    assert_eq!(parse_card_type("bug").unwrap(), CardType::Bug);
    assert_eq!(parse_priority("lowest").unwrap(), Priority::Lowest);
    assert_eq!(parse_card_type("chore").unwrap_err().to_string(), "Invalid type \"chore\" (task, story, bug, epic)");
    assert_eq!(
        parse_priority("urgent").unwrap_err().to_string(),
        "Invalid priority \"urgent\" (highest, high, medium, low, lowest)"
    );
    assert!(parse_card_type("Bug").is_err(), "case matters, like in the notes");
}

// --- the source of cards -----------------------------------------------------------------------------------------------

#[derive(Default)]
struct Source {
    cards: Mutex<Vec<Arc<Card>>>,
    asked: AtomicUsize,
    refreshed: Mutex<Vec<String>>,
    forgotten: Mutex<Vec<String>>,
}

impl CardSource for Source {
    fn cards(&self) -> Vec<Arc<Card>> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.cards.lock().unwrap().clone()
    }
    fn refresh_path(&self, path: &str) {
        self.refreshed.lock().unwrap().push(path.to_string());
    }
    fn forget_path(&self, path: &str) {
        self.forgotten.lock().unwrap().push(path.to_string());
    }
}

fn with_source() -> (CardService<Arc<MemoryStorage>>, Arc<MemoryStorage>, Arc<Source>) {
    let storage = Arc::new(MemoryStorage::new());
    let source = Arc::new(Source::default());
    let service = CardService::new(
        Arc::clone(&storage),
        config(),
        ServiceOptions {
            clock: Arc::new(|| T0),
            source: Some(Arc::clone(&source) as Arc<dyn CardSource>),
            ..ServiceOptions::default()
        },
    );
    (service, storage, source)
}

#[test]
fn every_write_tells_the_source_and_a_removal_makes_it_forget() {
    let (service, _storage, source) = with_source();
    service.create(new_titled("A")).unwrap();
    service.update("1", CardPatch { title: Some("B".into()), ..CardPatch::default() }).unwrap();
    service.move_card("1", "doing", Placement::default()).unwrap();
    let id = service.add_comment("1", CommentInput { text: "c".into(), author: None }).unwrap().comments[0].id.clone();
    service.edit_comment("1", &id, "edited").unwrap();
    service.remove_comment("1", &id).unwrap();
    assert_eq!(*source.refreshed.lock().unwrap(), vec!["Cards/OP-1.md"; 6]);
    service.remove("1").unwrap();
    assert_eq!(*source.forgotten.lock().unwrap(), ["Cards/OP-1.md"]);
}

#[test]
fn a_failed_write_does_not_tell_the_source_anything() {
    let (service, _storage, source) = with_source();
    service.create(new_titled("A")).unwrap();
    source.refreshed.lock().unwrap().clear();
    assert!(service.update("1", CardPatch { due: Some(Some("2026-02-30".into())), ..CardPatch::default() }).is_err());
    assert!(service.edit_comment("1", "nope", "x").is_err());
    assert!(service.remove("99").is_err());
    assert!(source.refreshed.lock().unwrap().is_empty());
    assert!(source.forgotten.lock().unwrap().is_empty());
}

#[test]
fn list_find_and_the_allocation_of_keys_and_ranks_use_the_source_not_the_storage() {
    let (service, storage, source) = with_source();
    // a card the source knows and the storage does not: only reads through the source can see it
    let mut card = sample_card("OP-41", "todo", "V");
    card.title = "Only in the source".into();
    source.cards.lock().unwrap().push(Arc::new(card));

    assert_eq!(service.list().unwrap().len(), 1);
    assert_eq!(service.find(&CardQuery::default()).unwrap().len(), 1);
    assert_eq!(
        service.find(&CardQuery { text: Some("only in the source".into()), ..CardQuery::default() }).unwrap().len(),
        1
    );
    let created = service.create(new_titled("Next")).unwrap();
    assert_eq!(created.key, "OP-42", "the next key comes from the source's highest number");
    assert!(
        created.rank.as_str() > "V",
        "and the rank lands after the source's last card in the column: {}",
        created.rank
    );
    assert!(source.asked.load(Ordering::SeqCst) >= 4);
    assert!(storage.exists("Cards/OP-42.md"));
    assert!(!storage.exists("Cards/OP-41.md"));
}

#[test]
fn a_parent_must_exist_in_the_source() {
    let (service, _storage, source) = with_source();
    source.cards.lock().unwrap().push(Arc::new(sample_card("OP-1", "todo", "V")));
    assert!(
        service
            .create(NewCardInput { title: "Child".into(), parent: Some("OP-1".into()), ..NewCardInput::default() })
            .is_ok()
    );
    let missing = service
        .create(NewCardInput { title: "Orphan".into(), parent: Some("OP-9".into()), ..NewCardInput::default() })
        .unwrap_err();
    assert_eq!(missing.to_string(), "Parent card OP-9 does not exist");
}

#[test]
fn get_reads_the_note_not_the_source_so_a_single_card_is_always_fresh() {
    let (service, storage, source) = with_source();
    service.create(new_titled("Fresh title")).unwrap();
    let mut stale = sample_card("OP-1", "todo", "V");
    stale.title = "Stale title in the source".into();
    *source.cards.lock().unwrap() = vec![Arc::new(stale)];
    let asked = source.asked.load(Ordering::SeqCst);
    let card = service.get("OP-1").unwrap();
    assert_eq!(card.title, "Fresh title");
    assert_eq!(
        source.asked.load(Ordering::SeqCst),
        asked,
        "the direct path exists: the source is not consulted at all"
    );
    assert!(storage.exists("Cards/OP-1.md"));
}

#[test]
fn a_note_renamed_by_hand_is_found_through_the_source_and_read_fresh() {
    let (service, storage, source) = with_source();
    let mut card = sample_card("OP-5", "todo", "V");
    card.title = "Moved note".into();
    card.path = "Cards/renamed by hand.md".into();
    storage.insert(&card.path, &common::vaults::note_text(&card));
    source.cards.lock().unwrap().push(Arc::new(card));
    assert_eq!(service.get("5").unwrap().title, "Moved note");
    // the source does not know it either: not found, without scanning the whole vault
    storage.insert("Cards/hidden-from-the-source.md", &common::vaults::note_text(&sample_card("OP-6", "todo", "W")));
    assert!(matches!(service.get("6"), Err(Error::NotFound(m)) if m == "Card OP-6"));
}

// --- the vault is not what it should be ---------------------------------------------------------------------------------

#[test]
fn a_vault_without_a_cards_folder_is_an_empty_board_and_the_first_card_creates_the_folder() {
    let dir = temp_vault();
    let (service, _clock) = service_on(Arc::new(FsStorage::new(dir.path())));
    assert!(service.list().unwrap().is_empty());
    assert!(matches!(service.get("1"), Err(Error::NotFound(_))));
    assert!(service.find(&CardQuery::default()).unwrap().is_empty());
    service.create(new_titled("First")).unwrap();
    assert!(dir.path().join("Cards/OP-1.md").is_file());
}

#[test]
fn notes_that_are_not_cards_are_ignored_everywhere() {
    let (service, storage, _clock) = memory();
    storage.insert("Cards/plain.md", "# just a note\n");
    storage.insert("Cards/nokey.md", "---\ntitle: x\n---\n");
    storage.insert("Cards/binary.md", "\u{fffd}\u{fffd}");
    service.create(new_titled("Real")).unwrap();
    assert_eq!(service.list().unwrap().len(), 1);
    assert_eq!(service.create(new_titled("Next")).unwrap().key, "OP-2");
}

#[test]
fn a_card_from_another_project_does_not_move_the_numbering() {
    let (service, storage, _clock) = memory();
    storage.insert("Cards/XY-500.md", &common::vaults::note_text(&sample_card("XY-500", "todo", "V")));
    assert_eq!(service.create(new_titled("Mine")).unwrap().key, "OP-1");
}

struct Hooked {
    inner: Arc<MemoryStorage>,
    /// How many `create` calls fail with `FileExists` before one is allowed.
    collisions: AtomicUsize,
    broken_reads: std::sync::atomic::AtomicBool,
}

impl Hooked {
    fn new(collisions: usize) -> Self {
        Self {
            inner: Arc::new(MemoryStorage::new()),
            collisions: AtomicUsize::new(collisions),
            broken_reads: false.into(),
        }
    }
}

impl Storage for Hooked {
    fn list_markdown(&self, folder: &str) -> Result<Vec<String>> {
        self.inner.list_markdown(folder)
    }
    fn read(&self, path: &str) -> Result<String> {
        if self.broken_reads.load(Ordering::SeqCst) {
            return Err(Error::io(path, std::io::Error::other("disk on fire")));
        }
        self.inner.read(path)
    }
    fn create(&self, path: &str, content: &str) -> Result<()> {
        if self.collisions.load(Ordering::SeqCst) > 0 {
            self.collisions.fetch_sub(1, Ordering::SeqCst);
            return Err(Error::FileExists(path.into()));
        }
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
}

#[test]
fn a_create_that_loses_the_race_for_a_key_tries_the_next_numbers() {
    let (service, _clock) = service_on(Hooked::new(3));
    let card = service.create(new_titled("Late")).unwrap();
    assert_eq!(card.key, "OP-4", "three numbers were taken by somebody else first");
}

#[test]
fn eight_lost_races_in_a_row_give_up_with_a_clear_message() {
    let (service, _clock) = service_on(Hooked::new(8));
    let error = service.create(new_titled("Never")).unwrap_err();
    assert_eq!(error.to_string(), "Could not allocate a free key after 8 attempts");
    // and the next attempt starts again from the same number
    assert_eq!(service.create(new_titled("Now")).unwrap().key, "OP-1");
}

#[test]
fn a_storage_that_cannot_read_makes_cards_unfindable_without_panicking() {
    let storage = Hooked::new(0);
    let (service, _clock) = service_on(storage);
    service.create(new_titled("Readable")).unwrap();
    service.storage().broken_reads.store(true, Ordering::SeqCst);
    assert!(service.list().unwrap().is_empty(), "notes that cannot be read are skipped");
    assert!(matches!(service.get("1"), Err(Error::NotFound(_))));
}

// --- values that are big or odd -------------------------------------------------------------------------------------------

#[test]
fn big_values_round_trip() {
    let (service, _storage, _clock) = memory();
    let title = "long title ".repeat(1000);
    let body = format!("{}\n\n- [ ] one\n- [x] two\n", "A paragraph of text. ".repeat(50_000));
    let card = service
        .create(NewCardInput {
            title: title.clone(),
            body: Some(body.clone()),
            labels: Some((0..1000).map(|i| format!("label-{i}")).collect()),
            ..NewCardInput::default()
        })
        .unwrap();
    assert_eq!(card.title, title.trim());
    assert!(
        card.body.trim() == body.trim(),
        "the description changed on the way: {} bytes in, {} out",
        body.len(),
        card.body.len()
    );
    assert_eq!(card.labels.len(), 1000);
    assert_eq!((card.checklist.done, card.checklist.total), (1, 2));
    let comment = "x".repeat(200_000);
    let card = service.add_comment("1", CommentInput { text: comment.clone(), author: None }).unwrap();
    assert_eq!(card.comments[0].text, comment);
    assert_eq!(service.get("1").unwrap().comments[0].text.len(), 200_000);
}

#[test]
fn unicode_survives_titles_labels_assignees_and_comments() {
    let (service, _storage, _clock) = memory();
    let card = service
        .create(NewCardInput {
            title: "Zoë 日本語 🚀 Straße".into(),
            assignee: Some("Étienne".into()),
            labels: Some(vec!["café".into(), "日本".into()]),
            ..NewCardInput::default()
        })
        .unwrap();
    assert_eq!(card.title, "Zoë 日本語 🚀 Straße");
    assert_eq!(card.assignee.as_deref(), Some("Étienne"));
    assert_eq!(card.labels, ["café", "日本"]);
    let card =
        service.add_comment("1", CommentInput { text: "Ça marche 🎉".into(), author: Some("Zoë".into()) }).unwrap();
    assert_eq!((card.comments[0].author.as_str(), card.comments[0].text.as_str()), ("Zoë", "Ça marche 🎉"));
    let found = service.find(&CardQuery { text: Some("CAFE STRASSE".into()), ..CardQuery::default() }).unwrap();
    assert!(found.is_empty() || found[0].key == "OP-1");
    assert_eq!(service.find(&CardQuery { text: Some("etienne".into()), ..CardQuery::default() }).unwrap().len(), 1);
}

#[test]
fn keys_written_with_odd_characters_are_refused_with_the_input_quoted_back() {
    let (service, _storage, _clock) = memory();
    for input in ["１２", "OP–1", "OP-1a", "op 1", "-1", "OP--1", "ÖP-1"] {
        let error = service.resolve_key(input).unwrap_err();
        assert_eq!(error.to_string(), format!("\"{input}\" is not a card key (expected OP-123 or 123)"), "{input}");
    }
    assert_eq!(service.resolve_key(" 7 ").unwrap(), "OP-7");
    assert_eq!(service.resolve_key("op-7").unwrap(), "OP-7");
    assert_eq!(service.resolve_key("007").unwrap(), "OP-7");
    assert_eq!(service.resolve_key("0").unwrap(), "OP-0");
    assert_eq!(service.resolve_key("99999999999999999999").unwrap(), "OP-100000000000000000000");
}

#[test]
fn moving_a_card_to_its_own_column_without_a_place_sends_it_to_the_bottom() {
    let (service, _storage, _clock) = memory();
    for title in ["A", "B", "C"] {
        service.create(new_titled(title)).unwrap();
    }
    service.move_card("1", "todo", Placement::default()).unwrap();
    let order: Vec<String> = service.list().unwrap().iter().map(|c| c.title.clone()).collect();
    assert_eq!(order, ["B", "C", "A"]);
    let ranks: Vec<String> = service.list().unwrap().iter().map(|c| c.rank.clone()).collect();
    assert!(ranks.windows(2).all(|w| w[0] < w[1]), "{ranks:?}");
}

#[test]
fn placing_a_card_relative_to_itself_or_to_a_card_in_another_column_is_refused() {
    let (service, _storage, _clock) = memory();
    service.create(new_titled("A")).unwrap();
    service
        .create(NewCardInput { title: "B".into(), status: Some("doing".into()), ..NewCardInput::default() })
        .unwrap();
    let own = service.move_card("1", "todo", Placement { before: Some("OP-1".into()), after: None }).unwrap_err();
    assert!(own.to_string().contains("is not in column"), "{own}");
    let other = service.move_card("1", "todo", Placement { before: Some("OP-2".into()), after: None }).unwrap_err();
    assert!(other.to_string().contains("OP-2 is not in column"), "{other}");
}

#[test]
fn the_clock_going_backwards_does_not_break_anything() {
    let (service, _storage, clock) = memory();
    service.create(new_titled("Time travel")).unwrap();
    clock.store(T0 - 86_400_000, Ordering::SeqCst);
    let card = service.update("1", CardPatch { priority: Some(Priority::High), ..CardPatch::default() }).unwrap();
    assert!(card.updated < card.created);
    assert_eq!(service.get("1").unwrap().priority, Priority::High);
}

#[test]
fn find_combines_every_filter_and_hides_old_done_cards_until_asked() {
    let (service, _storage, clock) = memory();
    service
        .create(NewCardInput { title: "Old win".into(), status: Some("done".into()), ..NewCardInput::default() })
        .unwrap();
    service.create(NewCardInput { title: "Fresh login bug".into(), ..NewCardInput::default() }).unwrap();
    clock.store(T0 + 20 * 86_400_000, Ordering::SeqCst); // twenty days later: past the 14-day archive limit
    let visible = service.find(&CardQuery::default()).unwrap();
    assert_eq!(visible.iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), ["Fresh login bug"]);
    let everything = service.find(&CardQuery { include_archived: true, ..CardQuery::default() }).unwrap();
    assert_eq!(everything.len(), 2);
    assert!(
        service
            .find(&CardQuery { text: Some("login".into()), status: vec!["done".into()], ..CardQuery::default() })
            .unwrap()
            .is_empty()
    );
}
