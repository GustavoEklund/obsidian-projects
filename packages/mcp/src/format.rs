//! Compact text for the agent. Everything a tool returns is read by a model, and every character costs context, so the
//! output is plain text with a fixed layout rather than JSON, and lists carry one line per card.
//!
//! # A card in a list
//!
//! ```text
//! OP-12 [doing] high bug "Fix redirect after login" @Ana due:2026-10-20(soon) est:3 labels:auth,backend parent:OP-1 tasks:1/3 comments:2
//! ```
//!
//! In this order: key, `[column id]`, priority, type, the title in double quotes (a `"` or `\` inside is escaped),
//! then, only when present: `@assignee` (quoted when it has spaces), `due:` with `(overdue)` or `(soon)` when it
//! applies, `est:` the estimate, `labels:` comma separated, `parent:` the parent key, `tasks:` checklist done/total and
//! `comments:` the number of comments.
//!
//! The layout is part of the tools' contract: tests pin it exactly, so a change is deliberate.
use std::borrow::Borrow;
use std::fmt::Write;

use crate::jscompat::number_to_js_string;
use crate::query::{DueState, Now, due_state, group_by_column};
use crate::types::{BoardConfig, Card};

/// How many cards `list_cards` returns when the caller does not say.
pub const DEFAULT_LIMIT: usize = 50;
/// The most cards one `list_cards` call may return: bounds both the reply and the memory it takes.
pub const MAX_LIMIT: usize = 200;

/// `"text"` with `\` and `"` escaped; line breaks and other control characters become spaces so a title stays on its line.
fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A name that may contain spaces, quoted only when it does.
fn name(text: &str) -> String {
    if text.chars().any(|c| c.is_whitespace() || c == '"' || c == '\\') { quote(text) } else { text.to_string() }
}

fn due_suffix(card: &Card, config: &BoardConfig, now: &Now) -> &'static str {
    match due_state(card, config, now) {
        Some(DueState::Overdue) => "(overdue)",
        Some(DueState::Soon) => "(soon)",
        _ => "",
    }
}

fn as_card<C: Borrow<Card>>(card: &C) -> &Card {
    card.borrow()
}

fn present(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|t| !t.is_empty())
}

/// One card on one line (see the module documentation for the layout).
pub fn card_line(card: &Card, config: &BoardConfig, now: &Now) -> String {
    let mut line = String::with_capacity(128);
    let _ = write!(
        line,
        "{} [{}] {} {} {}",
        card.key,
        card.status,
        card.priority.as_str(),
        card.card_type.as_str(),
        quote(&card.title)
    );
    if let Some(assignee) = present(&card.assignee) {
        let _ = write!(line, " @{}", name(assignee));
    }
    if let Some(due) = present(&card.due) {
        let _ = write!(line, " due:{due}{}", due_suffix(card, config, now));
    }
    if let Some(estimate) = card.estimate {
        let _ = write!(line, " est:{}", number_to_js_string(estimate));
    }
    if !card.labels.is_empty() {
        let _ = write!(line, " labels:{}", card.labels.join(","));
    }
    if let Some(parent) = present(&card.parent) {
        let _ = write!(line, " parent:{parent}");
    }
    if card.checklist.total > 0 {
        let _ = write!(line, " tasks:{}/{}", card.checklist.done, card.checklist.total);
    }
    if !card.comments.is_empty() {
        let _ = write!(line, " comments:{}", card.comments.len());
    }
    line
}

/// The answer of `list_cards`: a header and one line per card. `cards` are the ones shown, `total` how many matched.
pub fn card_list<C: Borrow<Card>>(cards: &[C], total: usize, config: &BoardConfig, now: &Now) -> String {
    if total == 0 {
        return "No cards match.".to_string();
    }
    let mut out = String::with_capacity(cards.len() * 128 + 96);
    let _ = write!(out, "{} of {} card{}", cards.len(), total, if total == 1 { "" } else { "s" });
    if cards.len() < total {
        let _ = write!(
            out,
            " ({} more not shown: narrow the filters, or raise limit up to {MAX_LIMIT})",
            total - cards.len()
        );
    }
    for card in cards {
        out.push('\n');
        out.push_str(&card_line(card.borrow(), config, now));
    }
    out
}

/// One card in full, for `get_card`: the same facts as the line, plus timestamps, the description and the comments.
pub fn card_block(card: &Card, config: &BoardConfig, now: &Now) -> String {
    let mut out = String::with_capacity(256 + card.body.len());
    let _ = writeln!(out, "{} [{}] {}", card.key, card.status, quote(&card.title));

    let mut meta = vec![format!("type: {}", card.card_type.as_str()), format!("priority: {}", card.priority.as_str())];
    if let Some(assignee) = present(&card.assignee) {
        meta.push(format!("assignee: {assignee}"));
    }
    if let Some(due) = present(&card.due) {
        let suffix = due_suffix(card, config, now);
        meta.push(if suffix.is_empty() { format!("due: {due}") } else { format!("due: {due} {suffix}") });
    }
    if let Some(estimate) = card.estimate {
        meta.push(format!("estimate: {}", number_to_js_string(estimate)));
    }
    if let Some(parent) = present(&card.parent) {
        meta.push(format!("parent: {parent}"));
    }
    let _ = writeln!(out, "{}", meta.join(" | "));
    if !card.labels.is_empty() {
        let _ = writeln!(out, "labels: {}", card.labels.join(", "));
    }
    if card.checklist.total > 0 {
        let _ = writeln!(out, "tasks: {} of {} done", card.checklist.done, card.checklist.total);
    }
    let _ = write!(out, "created: {} | updated: {}", card.created, card.updated);
    if let Some(resolved) = present(&card.resolved) {
        let _ = write!(out, " | resolved: {resolved}");
    }

    let body = card.body.trim();
    out.push_str("\n\ndescription:\n");
    out.push_str(if body.is_empty() { "(none)" } else { body });

    if !card.comments.is_empty() {
        let _ = write!(out, "\n\ncomments ({}):", card.comments.len());
        for comment in &card.comments {
            let when = if comment.at.is_empty() { String::new() } else { format!(", {}", comment.at) };
            let _ = write!(out, "\n- {} ({}{}): ", comment.id, comment.author, when);
            out.push_str(&comment.text.trim().replace('\n', "\n  "));
        }
    }
    out
}

/// The answer of `board_summary`. `visible` are the cards on the board (old done cards already hidden), `hidden_done`
/// how many old done cards are not among them.
pub fn board_summary<C: Borrow<Card> + Clone>(
    config: &BoardConfig,
    visible: &[C],
    hidden_done: usize,
    now: &Now,
) -> String {
    let overdue = visible.iter().map(as_card).filter(|c| due_state(c, config, now) == Some(DueState::Overdue)).count();
    let unassigned = visible.iter().map(as_card).filter(|c| present(&c.assignee).is_none()).count();

    let mut out = String::new();
    let _ = write!(
        out,
        "Board {} (folder {}): {} card{}, {} overdue, {} unassigned",
        config.prefix,
        config.folder,
        visible.len(),
        if visible.len() == 1 { "" } else { "s" },
        overdue,
        unassigned
    );
    if !config.me.is_empty() {
        let _ = write!(out, ". Me: {}", config.me);
    }
    for group in group_by_column(visible, config) {
        let count = group.cards.len();
        let _ = write!(out, "\n{} {}: {}", group.column.id, quote(&group.column.name), count);
        if group.column.done {
            out.push_str(" (done column)");
        }
        if let Some(limit) = group.column.wip.filter(|w| *w > 0) {
            let _ = write!(out, ", WIP limit {limit}{}", if count > limit as usize { " (over)" } else { "" });
        }
    }
    if hidden_done > 0 {
        let _ = write!(
            out,
            "\nHidden: {hidden_done} done card{} resolved more than {} days ago (list_cards with include_archived shows them).",
            if hidden_done == 1 { "" } else { "s" },
            config.hide_done_after_days
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::CivilDate;
    use crate::types::{CardType, Checklist, Column, Comment, Priority};

    fn now() -> Now {
        Now::from_utc_offset(1_792_000_000_000, 0) // 2026-10-14 in UTC
    }

    fn config() -> BoardConfig {
        let mut c = BoardConfig { me: "Ana".into(), ..BoardConfig::default() };
        c.columns[1].wip = Some(1);
        c
    }

    fn card(key: &str, status: &str) -> Card {
        Card {
            key: key.into(),
            path: format!("Cards/{key}.md"),
            title: "Fix redirect after login".into(),
            status: status.into(),
            card_type: CardType::Bug,
            priority: Priority::High,
            assignee: None,
            labels: vec![],
            due: None,
            estimate: None,
            parent: None,
            rank: "A".into(),
            created: "2026-10-01T10:00:00.000Z".into(),
            updated: "2026-10-02T10:00:00.000Z".into(),
            resolved: None,
            body: String::new(),
            checklist: Checklist::default(),
            comments: vec![],
        }
    }

    fn full() -> Card {
        let mut c = card("OP-12", "doing");
        c.assignee = Some("Ana".into());
        c.due = Some("2026-10-20".into());
        c.estimate = Some(3.0);
        c.labels = vec!["auth".into(), "backend".into()];
        c.parent = Some("OP-1".into());
        c.checklist = Checklist { done: 1, total: 3 };
        c.comments = vec![
            Comment {
                id: "c1a".into(),
                author: "Ana".into(),
                at: "2026-10-02T10:00:00.000Z".into(),
                text: "One.".into(),
            },
            Comment { id: "c1b".into(), author: "Bruno".into(), at: String::new(), text: "Two\nlines\n".into() },
        ];
        c.body = "The user lands on the home page.\n\n- [x] Reproduce\n".into();
        c
    }

    #[test]
    fn the_test_clock_is_what_the_cases_below_assume() {
        assert_eq!(now().local_date, CivilDate::new(2026, 10, 14));
    }

    #[test]
    fn a_bare_card_is_five_fields() {
        assert_eq!(
            card_line(&card("OP-1", "todo"), &config(), &now()),
            r#"OP-1 [todo] high bug "Fix redirect after login""#
        );
    }

    #[test]
    fn a_full_card_line_has_every_optional_field_in_a_fixed_order() {
        assert_eq!(
            card_line(&full(), &config(), &now()),
            r#"OP-12 [doing] high bug "Fix redirect after login" @Ana due:2026-10-20 est:3 labels:auth,backend parent:OP-1 tasks:1/3 comments:2"#
        );
    }

    #[test]
    fn due_dates_say_when_they_are_overdue_or_soon() {
        let mut c = card("OP-1", "todo");
        c.due = Some("2026-10-13".into());
        assert!(card_line(&c, &config(), &now()).ends_with("due:2026-10-13(overdue)"));
        c.due = Some("2026-10-14".into());
        assert!(card_line(&c, &config(), &now()).ends_with("due:2026-10-14(soon)"));
        c.due = Some("2026-10-16".into());
        assert!(card_line(&c, &config(), &now()).ends_with("due:2026-10-16(soon)"));
        c.due = Some("2026-10-17".into());
        assert!(card_line(&c, &config(), &now()).ends_with("due:2026-10-17"));
        c.status = "done".into();
        c.due = Some("2026-10-01".into());
        assert!(card_line(&c, &config(), &now()).ends_with("due:2026-10-01"), "a done card is never overdue");
    }

    #[test]
    fn titles_stay_on_one_line_and_quotes_are_escaped() {
        let mut c = card("OP-1", "todo");
        c.title = "Say \"hi\" \\ then\nbreak\tand tab".into();
        assert_eq!(card_line(&c, &config(), &now()), r#"OP-1 [todo] high bug "Say \"hi\" \\ then break and tab""#);
    }

    #[test]
    fn assignees_with_spaces_are_quoted() {
        let mut c = card("OP-1", "todo");
        c.assignee = Some("Ana Maria".into());
        assert!(card_line(&c, &config(), &now()).ends_with(r#"@"Ana Maria""#));
        c.assignee = Some(String::new());
        assert!(!card_line(&c, &config(), &now()).contains('@'));
    }

    #[test]
    fn fractional_estimates_print_like_numbers() {
        let mut c = card("OP-1", "todo");
        c.estimate = Some(2.5);
        assert!(card_line(&c, &config(), &now()).ends_with("est:2.5"));
        c.estimate = Some(0.0);
        assert!(card_line(&c, &config(), &now()).ends_with("est:0"));
    }

    #[test]
    fn a_list_has_a_header_and_one_line_per_card() {
        let cards = vec![card("OP-1", "todo"), card("OP-2", "doing")];
        assert_eq!(
            card_list(&cards, 2, &config(), &now()),
            "2 of 2 cards\nOP-1 [todo] high bug \"Fix redirect after login\"\nOP-2 [doing] high bug \"Fix redirect after login\""
        );
        assert!(card_list(&cards[..1], 1, &config(), &now()).starts_with("1 of 1 card\n"));
    }

    #[test]
    fn a_truncated_list_says_how_much_is_missing_and_what_to_do() {
        let cards = vec![card("OP-1", "todo")];
        let text = card_list(&cards, 120, &config(), &now());
        assert!(
            text.starts_with("1 of 120 cards (119 more not shown: narrow the filters, or raise limit up to 200)\n")
        );
    }

    #[test]
    fn no_match_is_one_short_sentence() {
        let none: Vec<Card> = vec![];
        assert_eq!(card_list(&none, 0, &config(), &now()), "No cards match.");
    }

    #[test]
    fn one_card_in_full_is_readable_and_complete() {
        let expected = "\
OP-12 [doing] \"Fix redirect after login\"
type: bug | priority: high | assignee: Ana | due: 2026-10-20 | estimate: 3 | parent: OP-1
labels: auth, backend
tasks: 1 of 3 done
created: 2026-10-01T10:00:00.000Z | updated: 2026-10-02T10:00:00.000Z

description:
The user lands on the home page.

- [x] Reproduce

comments (2):
- c1a (Ana, 2026-10-02T10:00:00.000Z): One.
- c1b (Bruno): Two
  lines";
        assert_eq!(card_block(&full(), &config(), &now()), expected);
    }

    #[test]
    fn a_minimal_card_in_full_omits_what_it_does_not_have() {
        let expected = "\
OP-1 [todo] \"Fix redirect after login\"
type: bug | priority: high
created: 2026-10-01T10:00:00.000Z | updated: 2026-10-02T10:00:00.000Z

description:
(none)";
        assert_eq!(card_block(&card("OP-1", "todo"), &config(), &now()), expected);
    }

    #[test]
    fn a_resolved_card_shows_when() {
        let mut c = card("OP-1", "done");
        c.resolved = Some("2026-10-10T08:00:00.000Z".into());
        assert!(
            card_block(&c, &config(), &now())
                .contains("updated: 2026-10-02T10:00:00.000Z | resolved: 2026-10-10T08:00:00.000Z\n")
        );
    }

    #[test]
    fn the_board_summary_counts_columns_overdue_and_unassigned() {
        let mut late = card("OP-1", "todo");
        late.due = Some("2026-10-01".into());
        late.assignee = Some("Ana".into());
        let cards = vec![late, card("OP-2", "doing"), card("OP-3", "doing"), card("OP-4", "done")];
        let expected = "\
Board OP (folder Cards): 4 cards, 1 overdue, 3 unassigned. Me: Ana
todo \"To Do\": 1
doing \"In Progress\": 2, WIP limit 1 (over)
review \"Review\": 0
done \"Done\": 1 (done column)";
        assert_eq!(board_summary(&config(), &cards, 0, &now()), expected);
    }

    #[test]
    fn the_summary_mentions_hidden_old_done_cards_and_a_wip_limit_that_holds() {
        let mut config = config();
        config.me = String::new();
        config.columns.push(Column { id: "extra".into(), name: "Extra".into(), done: false, wip: Some(3) });
        let text = board_summary(&config, &[card("OP-1", "todo")], 2, &now());
        assert!(text.starts_with("Board OP (folder Cards): 1 card, 0 overdue, 1 unassigned\n"), "{text}");
        assert!(
            text.contains("extra \"Extra\": 0, WIP limit 3\n") || text.contains("extra \"Extra\": 0, WIP limit 3 "),
            "{text}"
        );
        assert!(text.ends_with(
            "Hidden: 2 done cards resolved more than 14 days ago (list_cards with include_archived shows them)."
        ));
        let one = board_summary(&config, &[card("OP-1", "todo")], 1, &now());
        assert!(one.contains("Hidden: 1 done card resolved"));
    }
}
