//! A card as a note: reading one (leniently, because people edit notes by hand), writing a new one, and the small
//! rules around keys, dates, labels and checklists. A port of `packages/core/src/card.ts`.
use crate::body::{format_section, join_body, parse_comments, split_body};
use crate::error::Result;
use crate::frontmatter::{parse_frontmatter_js, patch_frontmatter, split_frontmatter};
use crate::jscompat::{civil_from_days, days_from_civil, is_js_whitespace, js_trim, number_to_js_string};
use crate::types::{Card, CardPatch, CardType, Checklist, Priority};
use serde_json::{Number, Value};

/// A card key split into its prefix and number: `OP-12` is `("OP", "12")`. A key is `[A-Z][A-Z0-9]{1,9}-\d+`.
pub fn parse_key(key: &str) -> Option<(&str, &str)> {
    let (prefix, digits) = key.split_once('-')?;
    let first = *prefix.as_bytes().first()?;
    let rest = &prefix.as_bytes()[1..];
    let prefix_ok = first.is_ascii_uppercase()
        && (1..=9).contains(&rest.len())
        && rest.iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    (prefix_ok && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some((prefix, digits))
}

pub fn is_valid_key(key: &str) -> bool {
    parse_key(key).is_some()
}

/// `YYYY-MM-DD` in shape (digits only, ASCII), whether or not it is a real date.
pub fn is_date_shaped(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

pub fn is_card_type(text: &str) -> bool {
    CardType::parse(text).is_some()
}

pub fn is_priority(text: &str) -> bool {
    Priority::parse(text).is_some()
}

/// A real calendar date written as `YYYY-MM-DD` (no 30 February).
pub fn is_valid_date(text: &str) -> bool {
    if !is_date_shaped(text) {
        return false;
    }
    let number = |range: std::ops::Range<usize>| text[range].parse::<i64>().unwrap_or(0);
    let (year, month, day) = (number(0..4), number(5..7), number(8..10));
    (1..=12).contains(&month) && civil_from_days(days_from_civil(year, month, day)) == (year, month, day)
}

/// `PREFIX-12` gives 12; `None` when the key has another prefix or is malformed. A JavaScript number, like the core's, so
/// a key with a very long number loses precision the same way.
pub fn key_number(key: &str, prefix: &str) -> Option<f64> {
    parse_key(key).filter(|(p, _)| *p == prefix).and_then(|(_, digits)| digits.parse::<f64>().ok())
}

/// Counts `- [ ]` and `- [x]` items outside fenced code blocks.
pub fn count_checklist(body: &str) -> Checklist {
    let (mut done, mut total) = (0, 0);
    let mut fence: Option<&str> = None;
    for line in body.split('\n') {
        let text = line.trim_start_matches(is_js_whitespace);
        let marker = ["```", "~~~"].into_iter().find(|m| text.starts_with(m));
        if let Some(marker) = marker {
            match fence {
                None => fence = Some(marker),
                Some(open) if open == marker => fence = None,
                Some(_) => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some(checked) = checkbox(text) {
            total += 1;
            if checked {
                done += 1;
            }
        }
    }
    Checklist { done, total }
}

/// `/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s/` on a line whose leading blanks are already gone: `Some(checked)`.
fn checkbox(text: &str) -> Option<bool> {
    let after = match text.as_bytes().first()? {
        b'-' | b'*' | b'+' => &text[1..],
        b'0'..=b'9' => {
            let rest = text.trim_start_matches(|c: char| c.is_ascii_digit());
            rest.strip_prefix(['.', ')'])?
        }
        _ => return None,
    };
    let spaced = after.trim_start_matches(is_js_whitespace);
    if spaced.len() == after.len() {
        return None; // `\s+` needs at least one
    }
    let inner = spaced.strip_prefix('[')?;
    let mark = inner.chars().next().filter(|c| matches!(c, ' ' | 'x' | 'X'))?;
    let closed = inner[1..].strip_prefix(']')?;
    closed.chars().next().filter(|c| is_js_whitespace(*c))?;
    Some(mark != ' ')
}

/// What the core's `asString` makes of a frontmatter value: a non-blank string, trimmed, or a number as JavaScript
/// writes it. Anything else is nothing.
fn as_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) => {
            let trimmed = js_trim(s);
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Number(n) => n.as_f64().map(number_to_js_string),
        _ => None,
    }
}

fn as_labels(value: Option<&Value>) -> Vec<String> {
    let raw: Vec<String> = match value {
        Some(Value::Array(items)) => items.iter().map(|v| as_string(Some(v)).unwrap_or_default()).collect(),
        Some(Value::String(s)) => {
            s.split(',').map(|part| as_string(Some(&Value::String(part.to_string()))).unwrap_or_default()).collect()
        }
        _ => Vec::new(),
    };
    normalize_labels(&raw)
}

/// Labels as stored: trimmed, without leading `#`, spaces inside a label turned into `-`, empty ones and repeats dropped.
pub fn normalize_labels<S: AsRef<str>>(labels: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for label in labels {
        // Every leading `#` goes (`##tag` is `tag`): stripping one would not be idempotent.
        let stripped = js_trim(label.as_ref()).trim_start_matches('#');
        let mut clean = String::with_capacity(stripped.len());
        let mut in_space = false;
        for c in stripped.chars() {
            if is_js_whitespace(c) {
                if !in_space {
                    clean.push('-');
                }
                in_space = true;
            } else {
                clean.push(c);
                in_space = false;
            }
        }
        if !clean.is_empty() && !out.contains(&clean) {
            out.push(clean);
        }
    }
    out
}

/// The first 10 UTF-16 code units of `text`: `None` when the cut would split a surrogate pair (the core would then
/// hold half a character, which is never a date).
fn first_ten_units(text: &str) -> Option<&str> {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        let next = units + c.len_utf16();
        if next > 10 {
            return if units == 10 { Some(&text[..at]) } else { None };
        }
        units = next;
        if units == 10 {
            return Some(&text[..at + c.len_utf8()]);
        }
    }
    Some(text)
}

fn as_due(value: Option<&Value>) -> Option<String> {
    let text = as_string(value)?;
    let head = first_ten_units(&text)?;
    is_valid_date(head).then(|| head.to_string())
}

/// Parses a note into a card. `None` when the note is not a card (no valid `key`). Lenient on purpose: notes get edited
/// by hand, so unknown or broken values degrade to defaults instead of hiding the card.
pub fn parse_card(path: &str, content: &str) -> Option<Card> {
    let fm = parse_frontmatter_js(content);
    let key = as_string(fm.get("key"))?.to_uppercase();
    if !is_valid_key(&key) {
        return None;
    }

    let full_body = split_frontmatter(content).body;
    let body = split_body(full_body).description;
    let estimate = fm.get("estimate").and_then(Value::as_f64).filter(|n| n.is_finite());
    let created = as_string(fm.get("created")).unwrap_or_default();
    let parent = as_string(fm.get("parent")).map(|p| p.to_uppercase()).filter(|p| is_valid_key(p));

    Some(Card {
        title: as_string(fm.get("title")).unwrap_or_else(|| key.clone()),
        status: as_string(fm.get("status")).unwrap_or_default(),
        card_type: fm.get("type").and_then(Value::as_str).and_then(CardType::parse).unwrap_or(CardType::Task),
        priority: fm.get("priority").and_then(Value::as_str).and_then(Priority::parse).unwrap_or(Priority::Medium),
        assignee: as_string(fm.get("assignee")),
        labels: as_labels(fm.get("labels")),
        due: as_due(fm.get("due")),
        estimate,
        parent,
        rank: as_string(fm.get("rank")).unwrap_or_default(),
        updated: as_string(fm.get("updated")).unwrap_or_else(|| created.clone()),
        created,
        resolved: as_string(fm.get("resolved")),
        checklist: count_checklist(&body),
        comments: parse_comments(full_body),
        body,
        path: path.to_string(),
        key,
    })
}

/// The text of a new card's note: its frontmatter in the order cards are written (`path` and `checklist` are not
/// stored), then the description, then the comments section. `utc_offset_minutes` is the local time zone's offset, which
/// the comment titles show.
pub fn new_card_content(card: &Card, utc_offset_minutes: i32) -> Result<String> {
    let text = |v: &str| Value::String(v.to_string());
    let optional = |v: &Option<String>| v.as_deref().map_or(Value::Null, text);
    let description = match js_trim(&card.body) {
        "" => String::new(),
        trimmed => format!("\n{trimmed}\n"),
    };
    let body = if card.comments.is_empty() {
        description
    } else {
        join_body(&description, Some(&format_section(&card.comments, utc_offset_minutes)))
    };
    let patch = [
        ("key", text(&card.key)),
        ("title", text(&card.title)),
        ("status", text(&card.status)),
        ("type", text(card.card_type.as_str())),
        ("priority", text(card.priority.as_str())),
        ("assignee", optional(&card.assignee)),
        (
            "labels",
            if card.labels.is_empty() {
                Value::Null
            } else {
                Value::Array(card.labels.iter().map(|l| text(l)).collect())
            },
        ),
        ("due", optional(&card.due)),
        ("estimate", card.estimate.and_then(Number::from_f64).map_or(Value::Null, Value::Number)),
        ("parent", optional(&card.parent)),
        ("rank", text(&card.rank)),
        ("created", text(&card.created)),
        ("updated", text(&card.updated)),
        ("resolved", optional(&card.resolved)),
    ];
    patch_frontmatter("", &patch, Some(&body))
}

/// Cheap structural equality, used to skip re-renders after our own writes. The checklist is derived from the body, so
/// it is not compared.
pub fn same_card(a: &Card, b: &Card) -> bool {
    a.key == b.key
        && a.path == b.path
        && a.title == b.title
        && a.status == b.status
        && a.card_type == b.card_type
        && a.priority == b.priority
        && a.assignee == b.assignee
        && a.due == b.due
        && a.estimate == b.estimate
        && a.parent == b.parent
        && a.rank == b.rank
        && a.updated == b.updated
        && a.resolved == b.resolved
        && a.body == b.body
        && a.comments == b.comments
        && a.labels == b.labels
}

/// What a card would look like after `patch`, computed locally. No validation: that is the service's job.
pub fn apply_patch(card: &Card, patch: &CardPatch) -> Card {
    let mut next = card.clone();
    if let Some(title) = &patch.title {
        let mut collapsed = String::with_capacity(title.len());
        let mut in_space = false;
        for c in title.chars() {
            if is_js_whitespace(c) {
                if !in_space {
                    collapsed.push(' ');
                }
                in_space = true;
            } else {
                collapsed.push(c);
                in_space = false;
            }
        }
        let trimmed = js_trim(&collapsed);
        next.title = if trimmed.is_empty() { card.title.clone() } else { trimmed.to_string() };
    }
    if let Some(status) = &patch.status {
        next.status.clone_from(status);
    }
    if let Some(card_type) = patch.card_type {
        next.card_type = card_type;
    }
    if let Some(priority) = patch.priority {
        next.priority = priority;
    }
    if let Some(rank) = &patch.rank {
        next.rank.clone_from(rank);
    }
    if let Some(assignee) = &patch.assignee {
        next.assignee = assignee.as_deref().map(js_trim).filter(|a| !a.is_empty()).map(str::to_string);
    }
    if let Some(labels) = &patch.labels {
        next.labels = normalize_labels(labels);
    }
    if let Some(due) = &patch.due {
        next.due.clone_from(due);
    }
    if let Some(estimate) = patch.estimate {
        next.estimate = estimate;
    }
    if let Some(parent) = &patch.parent {
        next.parent = parent.as_deref().filter(|p| !p.is_empty()).map(str::to_uppercase);
    }
    if let Some(body) = &patch.body {
        next.checklist = count_checklist(body);
        next.body.clone_from(body);
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Comment;

    const NOTE: &str = "---\nkey: op-12\ntitle:   Fix the login   \nstatus: doing\ntype: bug\npriority: high\nassignee: Ana\nlabels: [\"#auth\", web app, auth]\ndue: 2026-10-20\nestimate: 3\nparent: op-3\nrank: V\ncreated: 2026-10-14T17:02:00.000Z\nupdated: 2026-10-15T09:00:00.000Z\nresolved: 2026-10-16T09:00:00.000Z\ncustom: kept\n---\n\nThe login fails.\n\n- [x] reproduce\n- [ ] fix\n\n## Comments\n\n> [!comment|c1,2026-10-14T17:02:00.000Z] Ana · 2026-10-14 17:02\n> Reproduced on Safari\n";

    #[test]
    fn reads_a_note_into_a_card() {
        let card = parse_card("Cards/OP-12.md", NOTE).unwrap();
        assert_eq!(card.key, "OP-12");
        assert_eq!(card.path, "Cards/OP-12.md");
        assert_eq!(card.title, "Fix the login");
        assert_eq!((card.status.as_str(), card.card_type, card.priority), ("doing", CardType::Bug, Priority::High));
        assert_eq!(card.assignee.as_deref(), Some("Ana"));
        assert_eq!(card.labels, ["auth", "web-app"]);
        assert_eq!(
            (card.due.as_deref(), card.estimate, card.parent.as_deref()),
            (Some("2026-10-20"), Some(3.0), Some("OP-3"))
        );
        assert_eq!(card.rank, "V");
        assert_eq!(card.resolved.as_deref(), Some("2026-10-16T09:00:00.000Z"));
        assert_eq!(card.body, "\nThe login fails.\n\n- [x] reproduce\n- [ ] fix\n");
        assert_eq!(card.checklist, Checklist { done: 1, total: 2 });
        assert_eq!(card.comments.len(), 1);
        assert_eq!((card.comments[0].author.as_str(), card.comments[0].text.as_str()), ("Ana", "Reproduced on Safari"));
    }

    #[test]
    fn a_note_without_a_valid_key_is_not_a_card() {
        for note in [
            "",
            "text",
            "---\n---\n",
            "---\ntitle: x\n---\n",
            "---\nkey: nope\n---\n",
            "---\nkey: A-1\n---\n",
            "---\nkey: [OP-1]\n---\n",
            "---\nkey: OP-1\nkey: OP-2\n---\n",
        ] {
            assert!(parse_card("x.md", note).is_none(), "{note:?}");
        }
        assert!(parse_card("x.md", "---\nkey: OP-1\n---\n").is_some());
        assert!(parse_card("x.md", "---\nkey: 12\n---\n").is_none(), "a bare number is not a key");
    }

    #[test]
    fn hand_edited_values_degrade_to_defaults_instead_of_hiding_the_card() {
        let card = parse_card(
            "x.md",
            "---\nkey: OP-1\ntitle: [a]\ntype: Bug\npriority: urgent\nlabels: 12\ndue: 2026-02-30\nestimate: \"3\"\nparent: nope\ncreated: 12\n---\n",
        )
        .unwrap();
        assert_eq!(card.title, "OP-1", "no usable title: the key stands in");
        assert_eq!((card.card_type, card.priority), (CardType::Task, Priority::Medium));
        assert!(card.labels.is_empty(), "only a list or a comma separated string holds labels");
        assert_eq!((card.due, card.estimate, card.parent), (None, None, None));
        assert_eq!((card.created.as_str(), card.updated.as_str()), ("12", "12"), "updated falls back to created");
        assert_eq!((card.status.as_str(), card.rank.as_str()), ("", ""));
    }

    #[test]
    fn numbers_and_non_finite_numbers_read_like_javascript_strings() {
        let card = parse_card(
            "x.md",
            "---\nkey: OP-1\ntitle: .nan\nassignee: .inf\nstatus: 1e21\nrank: 0.5\nestimate: .inf\n---\n",
        )
        .unwrap();
        assert_eq!(
            (card.title.as_str(), card.assignee.as_deref(), card.status.as_str(), card.rank.as_str()),
            ("NaN", Some("Infinity"), "1e+21", "0.5")
        );
        assert_eq!(card.estimate, None);
    }

    #[test]
    fn writes_a_new_card_in_the_order_cards_are_written() {
        let card = Card {
            key: "OP-1".into(),
            path: "Cards/OP-1.md".into(),
            title: "Fix the login".into(),
            status: "todo".into(),
            card_type: CardType::Bug,
            priority: Priority::High,
            assignee: Some("Ana".into()),
            labels: vec!["a".into(), "b".into()],
            due: Some("2026-10-20".into()),
            estimate: Some(3.0),
            parent: None,
            rank: "V".into(),
            created: "2026-10-14T17:02:00.000Z".into(),
            updated: "2026-10-14T17:02:00.000Z".into(),
            resolved: None,
            body: "  The description  ".into(),
            checklist: Checklist::default(),
            comments: vec![Comment {
                id: "c1".into(),
                author: "Ana".into(),
                at: "2026-10-14T17:02:00.000Z".into(),
                text: "Hello".into(),
            }],
        };
        assert_eq!(
            new_card_content(&card, 0).unwrap(),
            "---\nkey: OP-1\ntitle: Fix the login\nstatus: todo\ntype: bug\npriority: high\nassignee: Ana\nlabels: [ a, b ]\ndue: 2026-10-20\nestimate: 3\nrank: V\ncreated: 2026-10-14T17:02:00.000Z\nupdated: 2026-10-14T17:02:00.000Z\n---\n\nThe description\n\n## Comments\n\n> [!comment|c1,2026-10-14T17:02:00.000Z] Ana · 2026-10-14 17:02\n> Hello\n"
        );
        let bare = Card {
            assignee: None,
            labels: vec![],
            due: None,
            estimate: None,
            body: "  ".into(),
            comments: vec![],
            ..card
        };
        assert_eq!(
            new_card_content(&bare, 0).unwrap(),
            "---\nkey: OP-1\ntitle: Fix the login\nstatus: todo\ntype: bug\npriority: high\nrank: V\ncreated: 2026-10-14T17:02:00.000Z\nupdated: 2026-10-14T17:02:00.000Z\n---\n"
        );
    }

    #[test]
    fn the_comment_titles_show_the_given_offset() {
        let mut card = parse_card("x.md", NOTE).unwrap();
        card.comments[0].at = "2026-10-14T23:30:00.000Z".into();
        assert!(new_card_content(&card, 0).unwrap().contains("Ana · 2026-10-14 23:30"));
        assert!(new_card_content(&card, 180).unwrap().contains("Ana · 2026-10-15 02:30"));
        assert!(new_card_content(&card, -180).unwrap().contains("Ana · 2026-10-14 20:30"));
    }

    #[test]
    fn keys_follow_the_pattern() {
        for key in ["AB-1", "OP-007", "A1-2", "ABCDEFGHIJ-99999999999999999999"] {
            assert!(is_valid_key(key), "{key}");
        }
        for key in
            ["A-1", "ABCDEFGHIJK-1", "ab-1", "1A-1", "OP-", "OP-1\n", "OP--1", "OP-1-2", "OP-١", "", "-1", "ÀB-1"]
        {
            assert!(!is_valid_key(key), "{key:?}");
        }
        assert_eq!(parse_key("OP-12"), Some(("OP", "12")));
        assert_eq!(key_number("OP-007", "OP"), Some(7.0));
        assert_eq!(key_number("OP-7", "AB"), None);
        assert_eq!(key_number("nope", "OP"), None);
        assert_eq!(key_number("OP-99999999999999999999", "OP"), Some(1e20));
    }

    #[test]
    fn dates_must_exist() {
        for date in ["2026-10-20", "2024-02-29", "2000-02-29", "0000-02-29", "9999-12-31"] {
            assert!(is_valid_date(date), "{date}");
        }
        for date in [
            "2023-02-29",
            "1900-02-29",
            "2026-04-31",
            "2026-13-01",
            "2026-00-10",
            "2026-10-00",
            "2026-1-01",
            " 2026-01-01",
            "２０２６-01-01",
            "",
        ] {
            assert!(!is_valid_date(date), "{date:?}");
        }
    }

    #[test]
    fn counts_checkboxes_outside_code() {
        let body = "- [ ] a\n* [x] b\n1. [X] c\n  - [ ] nested\n```\n- [ ] in code\n```\n~~~\n- [x] in tildes\n~~~\n- [ ]no space\n- [] empty\n- [x]\n> - [ ] quote\n- [-] dash\n- [ ] after";
        assert_eq!(count_checklist(body), Checklist { done: 2, total: 5 });
        assert_eq!(count_checklist("```\n- [ ] never closed\n- [x] x"), Checklist { done: 0, total: 0 });
        assert_eq!(
            count_checklist("~~~\n```\n- [x] still in the tildes\n~~~\n- [x] out"),
            Checklist { done: 1, total: 1 }
        );
        assert_eq!(count_checklist(""), Checklist::default());
    }

    #[test]
    fn labels_are_cleaned_and_deduplicated() {
        assert_eq!(
            normalize_labels(&["#bug", "##bug", " a  b ", "", "#", "# a", "Bug", "x\u{a0}y"]),
            ["bug", "a-b", "-a", "Bug", "x-y"]
        );
        let none: [&str; 0] = [];
        assert!(normalize_labels(&none).is_empty());
    }

    #[test]
    fn a_patch_applies_locally() {
        let card = parse_card("x.md", NOTE).unwrap();
        let patch = CardPatch {
            title: Some("  New \n title ".into()),
            assignee: Some(None),
            labels: Some(vec!["#x".into(), "x".into()]),
            due: Some(None),
            estimate: Some(Some(5.0)),
            parent: Some(Some("ab-9".into())),
            body: Some("- [x] one".into()),
            ..CardPatch::default()
        };
        let next = apply_patch(&card, &patch);
        assert_eq!(next.title, "New title");
        assert_eq!((next.assignee, next.due, next.estimate), (None, None, Some(5.0)));
        assert_eq!((next.labels, next.parent.as_deref()), (vec!["x".to_string()], Some("AB-9")));
        assert_eq!((next.body.as_str(), next.checklist), ("- [x] one", Checklist { done: 1, total: 1 }));
        assert_eq!(next.comments, card.comments, "comments are not part of a patch");
        // a blank title keeps the old one, an empty parent clears it
        let kept = apply_patch(
            &card,
            &CardPatch { title: Some("   ".into()), parent: Some(Some(String::new())), ..CardPatch::default() },
        );
        assert_eq!((kept.title.as_str(), kept.parent), ("Fix the login", None));
        assert_eq!(apply_patch(&card, &CardPatch::default()), card);
    }

    #[test]
    fn same_card_ignores_the_derived_checklist_only() {
        let a = parse_card("x.md", NOTE).unwrap();
        let mut b = a.clone();
        assert!(same_card(&a, &b));
        b.checklist = Checklist { done: 9, total: 9 };
        assert!(same_card(&a, &b));
        for change in [
            |c: &mut Card| c.title.push('!'),
            |c: &mut Card| c.labels.push("z".into()),
            |c: &mut Card| c.comments[0].text.push('!'),
            |c: &mut Card| c.estimate = None,
            |c: &mut Card| c.path.push('x'),
            |c: &mut Card| c.resolved = None,
        ] {
            let mut changed = a.clone();
            change(&mut changed);
            assert!(!same_card(&a, &changed));
        }
    }
}
