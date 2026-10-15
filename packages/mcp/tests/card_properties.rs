//! Properties of reading and writing cards, independent of the TypeScript corpus: what is written reads back as what was
//! asked (after the trimming the reader does), the readers never panic, and the small rules agree with a plain
//! reference implementation.
use oprojects_mcp::card::{
    apply_patch, count_checklist, is_valid_date, is_valid_key, new_card_content, normalize_labels, parse_card,
    parse_key,
};
use oprojects_mcp::jscompat::{is_js_whitespace, js_trim};
use oprojects_mcp::types::{Card, CardPatch, CardType, Checklist, Comment, Priority};
use proptest::prelude::*;

fn text() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => "[ -~]{0,16}",
        2 => any::<String>(),
        1 => prop::sample::select(vec![
            "", " ", "  padded  ", "a: b", "- x", "#tag", "multi\nline", "tab\there", "\u{a0}nbsp\u{a0}", "'q'", "\"d\"",
            "12", "true", "null", "~", "1e3", ".inf", "日本語 🙂", "---", "a #b", "x\u{feff}", "\u{2028}", "0x1F",
        ]).prop_map(str::to_string),
    ]
}

fn optional_text() -> impl Strategy<Value = Option<String>> {
    prop::option::of(text())
}

fn card() -> impl Strategy<Value = Card> {
    let identity = ("[A-Z][A-Z0-9]{1,9}-[0-9]{1,6}", text(), text(), text());
    let classes = (
        prop::sample::select(vec![CardType::Task, CardType::Story, CardType::Bug, CardType::Epic]),
        prop::sample::select(vec![
            Priority::Highest,
            Priority::High,
            Priority::Medium,
            Priority::Low,
            Priority::Lowest,
        ]),
    );
    let optional = (
        optional_text(),
        prop::collection::vec(text(), 0..4),
        prop::option::of("[0-9]{4}-[0-9]{2}-[0-9]{2}"),
        prop::option::of(prop_oneof![(-1000i32..1000).prop_map(f64::from), (-1.0e6f64..1.0e6)]),
        prop::option::of("[A-Za-z][A-Za-z0-9]{1,5}-[0-9]{1,4}"),
    );
    let times = (text(), text(), optional_text(), text());
    let comments = prop::collection::vec(("[a-z0-9]{3,6}", "[A-Za-z]{1,8}", "[ -~]{1,20}"), 0..3);
    (identity, classes, optional, times, comments).prop_map(
        |(
            (key, title, status, rank),
            (card_type, priority),
            (assignee, labels, due, estimate, parent),
            (created, updated, resolved, body),
            comments,
        )| Card {
            path: format!("Cards/{key}.md"),
            key,
            title,
            status,
            card_type,
            priority,
            assignee,
            labels,
            due,
            estimate,
            parent,
            rank,
            created,
            updated,
            resolved,
            body,
            checklist: Checklist::default(),
            comments: comments
                .into_iter()
                .enumerate()
                .map(|(i, (id, author, body))| Comment {
                    id: format!("{id}{i}"),
                    author,
                    at: "2026-10-14T17:02:00.000Z".into(),
                    text: body.trim().to_string(),
                })
                .filter(|c| !c.text.is_empty())
                .collect(),
        },
    )
}

/// What the reader makes of a string field: trimmed, or nothing when blank.
fn read_text(s: &str) -> Option<String> {
    let t = js_trim(s);
    (!t.is_empty()).then(|| t.to_string())
}

/// A reference for `is_valid_date`: the calendar, with no help from the library's own date arithmetic.
fn reference_date(year: u32, month: u32, day: u32) -> bool {
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 28 + u32::from(leap),
        _ => return false,
    };
    (1..=days).contains(&day)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, failure_persistence: None, ..ProptestConfig::default() })]

    /// A new card reads back as what was asked, after the reader's trimming.
    #[test]
    fn a_new_card_reads_back(card in card()) {
        let note = new_card_content(&card, 0).unwrap();
        let read = parse_card(&card.path, &note).unwrap_or_else(|| panic!("not a card: {note:?}"));
        prop_assert_eq!(&read.key, &card.key);
        prop_assert_eq!(read.title, read_text(&card.title).unwrap_or_else(|| card.key.clone()));
        prop_assert_eq!(read.status, read_text(&card.status).unwrap_or_default());
        prop_assert_eq!(read.card_type, card.card_type);
        prop_assert_eq!(read.priority, card.priority);
        prop_assert_eq!(read.assignee, card.assignee.as_deref().and_then(read_text));
        prop_assert_eq!(read.labels, normalize_labels(&card.labels));
        prop_assert_eq!(read.due, card.due.clone().filter(|d| is_valid_date(d)));
        prop_assert_eq!(read.estimate, card.estimate);
        prop_assert_eq!(read.parent, card.parent.as_ref().map(|p| p.to_uppercase()));
        prop_assert_eq!(read.rank, read_text(&card.rank).unwrap_or_default());
        let created = read_text(&card.created).unwrap_or_default();
        prop_assert_eq!(&read.created, &created);
        prop_assert_eq!(read.updated, read_text(&card.updated).unwrap_or(created));
        prop_assert_eq!(read.resolved, card.resolved.as_deref().and_then(read_text));
        let trimmed = js_trim(&card.body);
        prop_assert_eq!(&read.body, &if trimmed.is_empty() { String::new() } else { format!("\n{trimmed}\n") });
        prop_assert_eq!(read.checklist, count_checklist(&read.body));
        prop_assert_eq!(read.comments.len(), card.comments.len());
        for (got, want) in read.comments.iter().zip(&card.comments) {
            prop_assert_eq!((&got.id, &got.at, &got.text), (&want.id, &want.at, &want.text));
        }
    }

    /// Writing what was read changes nothing more: the second note is the first one.
    #[test]
    fn writing_what_was_read_is_a_fixpoint(card in card()) {
        let first = new_card_content(&card, 0).unwrap();
        let read = parse_card(&card.path, &first).unwrap();
        let second = new_card_content(&read, 0).unwrap();
        let again = parse_card(&card.path, &second).unwrap();
        prop_assert_eq!(&read, &again);
        prop_assert_eq!(new_card_content(&again, 0).unwrap(), second);
    }

    #[test]
    fn labels_are_clean_unique_and_stable(labels in prop::collection::vec(text(), 0..8)) {
        let clean = normalize_labels(&labels);
        for (i, label) in clean.iter().enumerate() {
            prop_assert!(!label.is_empty() && !label.starts_with('#'), "{label:?}");
            prop_assert!(!label.chars().any(is_js_whitespace), "{label:?}");
            prop_assert!(!clean[..i].contains(label), "{label:?} twice");
        }
        prop_assert_eq!(normalize_labels(&clean), clean);
    }

    #[test]
    fn checklists_never_count_more_done_than_total(body in any::<String>()) {
        let c = count_checklist(&body);
        prop_assert!(c.done <= c.total);
    }

    #[test]
    fn a_checklist_made_of_items_counts_them(done in 0usize..8, open in 0usize..8) {
        let body: String = (0..done).map(|i| format!("- [x] done {i}\n")).chain((0..open).map(|i| format!("* [ ] open {i}\n"))).collect();
        prop_assert_eq!(count_checklist(&body), Checklist { done: done as u32, total: (done + open) as u32 });
        // the same items in a code fence do not count
        prop_assert_eq!(count_checklist(&format!("```\n{body}```\n")), Checklist::default());
    }

    #[test]
    fn dates_match_the_calendar(year in 0u32..10_000, month in 0u32..15, day in 0u32..35) {
        let text = format!("{year:04}-{month:02}-{day:02}");
        prop_assert_eq!(is_valid_date(&text), reference_date(year, month, day), "{}", text);
    }

    #[test]
    fn keys_match_their_grammar(prefix in "[A-Z][A-Z0-9]{1,9}", number in "[0-9]{1,25}") {
        let key = format!("{prefix}-{number}");
        prop_assert_eq!(parse_key(&key), Some((prefix.as_str(), number.as_str())));
        prop_assert!(is_valid_key(&key));
        for broken in [format!("{key}\n"), format!(" {key}"), key.to_lowercase(), format!("{prefix}-"), format!("{prefix}x-{number}-1")] {
            prop_assert!(!is_valid_key(&broken), "{broken:?}");
        }
    }

    #[test]
    fn reading_never_panics(note in any::<String>(), path in "[a-z/.]{0,12}") {
        if let Some(card) = parse_card(&path, &note) {
            prop_assert!(is_valid_key(&card.key));
            prop_assert!(card.checklist.done <= card.checklist.total);
        }
    }

    /// A patch is idempotent, and an empty one changes nothing.
    #[test]
    fn a_patch_applies_once(
        card in card(),
        title in prop::option::of(text()),
        assignee in prop::option::of(optional_text()),
        labels in prop::option::of(prop::collection::vec(text(), 0..4)),
        parent in prop::option::of(optional_text()),
        body in prop::option::of(text()),
    ) {
        let patch = CardPatch { title, assignee, labels, parent, body, ..CardPatch::default() };
        let once = apply_patch(&card, &patch);
        prop_assert_eq!(apply_patch(&once, &patch), once.clone());
        prop_assert_eq!(apply_patch(&card, &CardPatch::default()), card.clone());
        prop_assert!(!once.title.is_empty() || card.title.is_empty());
        prop_assert_eq!(once.checklist, patch.body.as_deref().map_or(card.checklist, count_checklist));
    }
}
