//! The [`Watcher`]: what it tells an agent about the cards it follows, and when. Time is a parameter of `poll`, so every
//! case runs in microseconds over an in-memory vault, and the quiet window is tested to the half second.
mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::vaults::{note_text, sample_card};
use oprojects_mcp::Error;
use oprojects_mcp::storage::{MemoryStorage, Storage};
use oprojects_mcp::types::{BoardConfig, Card, Comment};
use oprojects_mcp::watch::{Added, UpdateKind, Watcher, command_line, shell_word};

const SETTLE: Duration = Duration::from_secs(3);

struct Setup {
    storage: Arc<MemoryStorage>,
    watcher: Watcher<Arc<MemoryStorage>>,
    start: Instant,
}

impl Setup {
    /// A vault with `OP-1` in progress, followed on behalf of an agent that signs its comments "Claude".
    fn new() -> Self {
        let storage = Arc::new(MemoryStorage::new());
        let mut setup = Self {
            watcher: Watcher::new(Arc::clone(&storage), BoardConfig::default(), "Claude", SETTLE),
            storage,
            start: Instant::now(),
        };
        setup.write(&sample_card("OP-1", "doing", "M"));
        assert!(matches!(setup.watcher.add("1").unwrap(), Added::Following(_)));
        setup
    }

    fn at(&self, seconds: f64) -> Instant {
        self.start + Duration::from_secs_f64(seconds)
    }

    fn write(&mut self, card: &Card) {
        self.storage.insert(&card.path, &note_text(card));
    }

    fn lines(&mut self, seconds: f64) -> Vec<String> {
        let now = self.at(seconds);
        self.watcher.poll(now).into_iter().map(|u| u.line).collect()
    }
}

fn card() -> Card {
    sample_card("OP-1", "doing", "M")
}

fn with_comment(mut card: Card, id: &str, author: &str, text: &str) -> Card {
    card.comments.push(Comment {
        id: id.into(),
        author: author.into(),
        at: "2026-10-04T10:00:00.000Z".into(),
        text: text.into(),
    });
    card
}

#[test]
fn a_card_nobody_touches_says_nothing_however_long_it_is_followed() {
    let mut setup = Setup::new();
    for second in 0..60 {
        assert!(setup.lines(f64::from(second)).is_empty());
    }
    assert!(!setup.watcher.is_empty());
}

#[test]
fn a_comment_is_told_once_the_note_has_been_quiet_for_the_settle_time() {
    let mut setup = Setup::new();
    setup.write(&with_comment(card(), "n1", "Gustavo", "Please check Safari too."));
    assert!(setup.lines(1.0).is_empty(), "seen, but it may still be changing");
    assert!(setup.lines(3.5).is_empty(), "2.5 s of quiet is not 3");
    let told = setup.lines(4.0);
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(
        told[0].starts_with(
            "OP-1 \"Card OP-1 with a reasonably long title\": Gustavo commented: \"Please check Safari too.\""
        ),
        "{}",
        told[0]
    );
    assert!(setup.lines(10.0).is_empty(), "it is told once");
}

#[test]
fn a_burst_of_saves_is_one_line_that_covers_all_of_it() {
    let mut setup = Setup::new();
    let mut edited = card();
    edited.body = "First draft".into();
    setup.write(&edited);
    assert!(setup.lines(1.0).is_empty());
    edited.body = "Second draft".into();
    setup.write(&edited);
    assert!(setup.lines(3.0).is_empty(), "the second save restarted the quiet window");
    assert!(setup.lines(5.5).is_empty());
    let mut edited = with_comment(edited, "n1", "Gustavo", "and a note");
    edited.body = "Final draft".into();
    setup.write(&edited);
    assert!(setup.lines(6.0).is_empty());
    let told = setup.lines(9.0);
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(told[0].contains("Gustavo commented") && told[0].contains("description edited"), "{}", told[0]);
}

#[test]
fn an_edit_that_is_undone_before_it_settles_says_nothing() {
    let mut setup = Setup::new();
    let mut edited = card();
    edited.title = "A different title".into();
    setup.write(&edited);
    assert!(setup.lines(1.0).is_empty());
    setup.write(&card());
    assert!(setup.lines(2.0).is_empty());
    assert!(setup.lines(20.0).is_empty());
}

#[test]
fn the_agents_own_comments_do_not_come_back_but_other_authors_do() {
    let mut setup = Setup::new();
    setup.write(&with_comment(card(), "n1", "claude", "Pushed a fix."));
    assert!(setup.lines(1.0).is_empty());
    assert!(setup.lines(5.0).is_empty(), "signed like the agent, whatever the case");
    let both = with_comment(with_comment(card(), "n1", "claude", "Pushed a fix."), "n2", "Gustavo", "Thanks!");
    setup.write(&both);
    setup.lines(6.0);
    let told = setup.lines(10.0);
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(told[0].contains("Gustavo commented") && !told[0].contains("Pushed a fix"), "{}", told[0]);
}

#[test]
fn moving_the_card_and_changing_its_fields_are_told() {
    let mut setup = Setup::new();
    let mut moved = card();
    moved.status = "review".into();
    moved.priority = oprojects_mcp::types::Priority::Highest;
    setup.write(&moved);
    setup.lines(1.0);
    let told = setup.lines(4.0);
    assert_eq!(told.len(), 1);
    assert!(
        told[0].contains("moved from In Progress to Review") && told[0].contains("priority high → highest"),
        "{}",
        told[0]
    );
}

#[test]
fn a_card_that_is_dragged_inside_its_column_says_nothing() {
    let mut setup = Setup::new();
    let mut dragged = card();
    dragged.rank = "Z".into();
    dragged.updated = "2026-10-09T10:00:00.000Z".into();
    setup.write(&dragged);
    setup.lines(1.0);
    assert!(setup.lines(10.0).is_empty());
}

#[test]
fn done_is_the_last_line_and_ends_the_following() {
    let mut setup = Setup::new();
    let mut finished = card();
    finished.status = "done".into();
    finished.resolved = Some("2026-10-05T10:00:00.000Z".into());
    setup.write(&finished);
    setup.lines(1.0);
    let now = setup.at(4.0);
    let updates = setup.watcher.poll(now);
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].kind, UpdateKind::Done);
    assert_eq!(updates[0].key, "OP-1");
    assert!(
        updates[0].line.contains("moved to Done") && updates[0].line.contains("stop watching it"),
        "{}",
        updates[0].line
    );
    assert!(setup.watcher.is_empty());
    setup.write(&with_comment(finished, "n9", "Gustavo", "late comment"));
    assert!(setup.lines(30.0).is_empty(), "a done card is not followed any more");
}

#[test]
fn a_card_that_is_already_done_is_not_followed() {
    let mut setup = Setup::new();
    setup.write(&sample_card("OP-2", "done", "N"));
    match setup.watcher.add("OP-2").unwrap() {
        Added::AlreadyDone(card) => assert_eq!(card.key, "OP-2"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_card_that_does_not_exist_is_an_error_that_names_it() {
    let mut setup = Setup::new();
    let error = setup.watcher.add("99").unwrap_err();
    assert!(matches!(error, Error::NotFound(_)), "{error}");
    assert!(error.to_string().contains("OP-99"), "{error}");
    assert!(setup.watcher.add("not a key").is_err());
}

#[test]
fn following_a_card_twice_tells_about_it_once() {
    let mut setup = Setup::new();
    assert!(matches!(setup.watcher.add("OP-1").unwrap(), Added::Following(_)));
    setup.write(&with_comment(card(), "n1", "Gustavo", "hi"));
    setup.lines(1.0);
    assert_eq!(setup.lines(5.0).len(), 1);
}

#[test]
fn a_deleted_note_is_told_after_the_settle_time_and_ends_the_following() {
    let mut setup = Setup::new();
    let storage = Arc::clone(&setup.storage);
    storage.remove("Cards/OP-1.md").unwrap();
    assert!(setup.lines(1.0).is_empty(), "it may be about to come back");
    assert!(setup.lines(3.0).is_empty());
    let now = setup.at(4.5);
    let updates = setup.watcher.poll(now);
    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].kind, UpdateKind::Removed);
    assert!(updates[0].line.starts_with("OP-1 was deleted"), "{}", updates[0].line);
    assert!(setup.watcher.is_empty());
}

#[test]
fn a_note_that_is_briefly_missing_and_comes_back_is_not_a_deletion() {
    let mut setup = Setup::new();
    let storage = Arc::clone(&setup.storage);
    storage.remove("Cards/OP-1.md").unwrap();
    setup.lines(1.0);
    setup.write(&card());
    assert!(setup.lines(2.0).is_empty());
    assert!(setup.lines(30.0).is_empty());
    assert!(!setup.watcher.is_empty());
}

#[test]
fn a_renamed_note_is_found_by_its_key_and_still_followed() {
    let mut setup = Setup::new();
    let storage = Arc::clone(&setup.storage);
    storage.remove("Cards/OP-1.md").unwrap();
    let mut renamed = with_comment(card(), "n1", "Gustavo", "after the move");
    renamed.path = "Cards/Archive/login.md".into();
    setup.write(&renamed);
    setup.lines(1.0);
    setup.lines(4.5); // looked for, found, and the change seen
    let told = setup.lines(8.0);
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(told[0].contains("after the move"), "{}", told[0]);
}

#[test]
fn a_note_that_cannot_be_read_as_a_card_right_now_is_ignored_until_it_can() {
    let mut setup = Setup::new();
    let storage = Arc::clone(&setup.storage);
    storage.insert("Cards/OP-1.md", "---\nkey: OP-1\ntitle: [unclosed\n");
    assert!(setup.lines(1.0).is_empty());
    assert!(setup.lines(10.0).is_empty());
    setup.write(&with_comment(card(), "n1", "Gustavo", "fixed the typo"));
    setup.lines(11.0);
    assert_eq!(setup.lines(15.0).len(), 1);
    assert!(!setup.watcher.is_empty());
}

#[test]
fn cards_are_followed_independently() {
    let mut setup = Setup::new();
    setup.write(&sample_card("OP-2", "doing", "N"));
    setup.watcher.add("OP-2").unwrap();
    let mut finished = sample_card("OP-2", "doing", "N");
    finished.status = "done".into();
    setup.write(&finished);
    setup.write(&with_comment(card(), "n1", "Gustavo", "about the first"));
    setup.lines(1.0);
    let now = setup.at(4.5);
    let updates = setup.watcher.poll(now);
    assert_eq!(updates.len(), 2);
    assert_eq!(updates.iter().filter(|u| u.kind == UpdateKind::Done).count(), 1);
    assert!(!setup.watcher.is_empty(), "OP-1 is still followed after OP-2 finished");
}

#[test]
fn shell_words_are_left_alone_when_plain_and_quoted_otherwise() {
    assert_eq!(shell_word("/usr/local/bin/oprojects-mcp"), "/usr/local/bin/oprojects-mcp");
    assert_eq!(shell_word("Claude"), "Claude");
    assert_eq!(shell_word("Claude Code"), "'Claude Code'");
    assert_eq!(shell_word("/home/ana/My Vault"), "'/home/ana/My Vault'");
    assert_eq!(shell_word("it's"), "'it'\\''s'");
    assert_eq!(shell_word(""), "''");
    assert_eq!(shell_word("$(rm -rf ~)"), "'$(rm -rf ~)'");
}

#[test]
fn the_command_line_names_the_program_the_vault_and_the_author() {
    assert_eq!(
        command_line("/opt/bin/oprojects-mcp", std::path::Path::new("/home/ana/My Vault"), "Claude Code"),
        "/opt/bin/oprojects-mcp watch --vault '/home/ana/My Vault' --author 'Claude Code'"
    );
}
