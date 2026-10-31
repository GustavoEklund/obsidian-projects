//! What happened to a card between two reads, and how that is told to an agent.
//!
//! Everything here is pure: no files, no clock. [`changes`] compares two states of one card, [`describe`] turns the
//! result into the single line an agent reads (a Monitor event, a channel message), and [`took`] says whether a write
//! made an agent the one working on a card, which is what starts the following.
//!
//! Only what a person would call "someone changed the task" counts: comments, the column, the fields, the description.
//! The rank (a card dragged inside its column), `updated` and the checklist counter (derived from the description) never
//! produce a line, and neither does a comment signed by `own_author`: the agent does not need to hear what it wrote.
use crate::config::{display_column, is_done_status};
use crate::types::{BoardConfig, Card};

/// The most characters of a comment that go into a line. The rest is one `get_card` away, and what an agent reads costs
/// context.
const MAX_TEXT: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Comment {
        author: String,
        text: String,
    },
    CommentEdited {
        author: String,
        text: String,
    },
    /// Moved between two columns that are not both done; the names are the columns' display names.
    Moved {
        from: String,
        to: String,
    },
    Field {
        name: &'static str,
        from: String,
        to: String,
    },
    Description,
    /// Moved into a done column (the display name): the last thing that is told about a card.
    Done {
        column: String,
    },
}

fn is_own(author: &str, own: &str) -> bool {
    let own = own.trim();
    !own.is_empty() && author.trim().to_lowercase() == own.to_lowercase()
}

fn column_name(config: &BoardConfig, status: &str) -> String {
    display_column(config, status).name.clone()
}

fn or_none(value: Option<&str>) -> String {
    value.map_or_else(|| "none".to_string(), str::to_string)
}

/// What differs between `before` and `after`, comments first and the finish last. Comments signed by `own_author` are
/// left out (case-insensitive).
pub fn changes(before: &Card, after: &Card, config: &BoardConfig, own_author: &str) -> Vec<Change> {
    let mut found = Vec::new();

    for comment in after.comments.iter().filter(|c| !is_own(&c.author, own_author)) {
        match before.comments.iter().find(|old| old.id == comment.id) {
            None => found.push(Change::Comment { author: comment.author.clone(), text: comment.text.clone() }),
            Some(old) if old.text != comment.text => {
                found.push(Change::CommentEdited { author: comment.author.clone(), text: comment.text.clone() });
            }
            Some(_) => {}
        }
    }

    let finished = before.status != after.status
        && is_done_status(config, &after.status)
        && !is_done_status(config, &before.status);
    if before.status != after.status && !finished {
        found.push(Change::Moved { from: column_name(config, &before.status), to: column_name(config, &after.status) });
    }

    let mut field = |name: &'static str, from: String, to: String| {
        if from != to {
            found.push(Change::Field { name, from, to });
        }
    };
    field("title", format!("\"{}\"", before.title), format!("\"{}\"", after.title));
    field("type", before.card_type.as_str().into(), after.card_type.as_str().into());
    field("priority", before.priority.as_str().into(), after.priority.as_str().into());
    field("assignee", or_none(before.assignee.as_deref()), or_none(after.assignee.as_deref()));
    field("labels", labels(&before.labels), labels(&after.labels));
    field("due", or_none(before.due.as_deref()), or_none(after.due.as_deref()));
    field(
        "estimate",
        before.estimate.map_or_else(|| "none".into(), |e| e.to_string()),
        after.estimate.map_or_else(|| "none".into(), |e| e.to_string()),
    );
    field("parent", or_none(before.parent.as_deref()), or_none(after.parent.as_deref()));

    if before.body != after.body {
        found.push(Change::Description);
    }
    if finished {
        found.push(Change::Done { column: column_name(config, &after.status) });
    }
    found
}

fn labels(labels: &[String]) -> String {
    if labels.is_empty() { "none".into() } else { labels.join(", ") }
}

/// A comment's text on one line, cut at [`MAX_TEXT`] characters. The flag says whether it was cut.
fn quoted(text: &str) -> (String, bool) {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_TEXT {
        return (flat, false);
    }
    let mut cut: String = flat.chars().take(MAX_TEXT).collect();
    cut.push('…');
    (cut, true)
}

fn who(author: &str) -> &str {
    if author.trim().is_empty() { "someone" } else { author.trim() }
}

/// The one line that tells an agent about `changes` to `card`. Empty `changes` give an empty string.
pub fn describe(card: &Card, changes: &[Change]) -> String {
    let mut parts = Vec::new();
    let mut cut = false;
    let mut finished = None;
    for change in changes {
        match change {
            Change::Comment { author, text } => {
                let (text, was_cut) = quoted(text);
                cut |= was_cut;
                parts.push(format!("{} commented: \"{text}\"", who(author)));
            }
            Change::CommentEdited { author, text } => {
                let (text, was_cut) = quoted(text);
                cut |= was_cut;
                parts.push(format!("{} edited a comment: \"{text}\"", who(author)));
            }
            Change::Moved { from, to } => parts.push(format!("moved from {from} to {to}")),
            Change::Field { name, from, to } => parts.push(format!("{name} {from} → {to}")),
            Change::Description => parts.push("description edited".into()),
            Change::Done { column } => {
                parts.push(format!("moved to {column}"));
                finished = Some(column.as_str());
            }
        }
    }
    if parts.is_empty() {
        return String::new();
    }
    let title = card.title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut line = format!("{} \"{title}\": {}.", card.key, parts.join("; "));
    if cut {
        line.push_str(&format!(" Read all of it with get_card {}.", card.key));
    }
    if finished.is_some() {
        line.push_str(" The card is done: no more updates will follow for it, stop watching it.");
    }
    line
}

/// The line for a card whose note is gone.
pub fn removed_line(key: &str) -> String {
    format!("{key} was deleted: no more updates will follow for it, stop watching it.")
}

/// The line for a card that was already done when the agent asked to follow it.
pub fn already_done_line(card: &Card, config: &BoardConfig) -> String {
    format!(
        "{} \"{}\" is already done ({}): nothing to follow.",
        card.key,
        card.title.split_whitespace().collect::<Vec<_>>().join(" "),
        column_name(config, &card.status)
    )
}

/// Whether the write that turned `before` into `after` made `author` the one working on the card: it left the first
/// column (or came back from done) for a column that is not done, or it was assigned to `author`. A card in a done
/// column is never taken: there is nothing left to follow.
pub fn took(before: &Card, after: &Card, config: &BoardConfig, author: &str) -> bool {
    if is_done_status(config, &after.status) {
        return false;
    }
    let first = display_column(config, &after.status).id == config.columns[0].id;
    let came_from_rest = {
        let was = display_column(config, &before.status);
        was.id == config.columns[0].id || was.done
    };
    let moved_out = before.status != after.status && came_from_rest && !first;
    let assigned = after.assignee.as_deref().is_some_and(|a| is_own(a, author))
        && !before.assignee.as_deref().is_some_and(|a| is_own(a, author));
    moved_out || assigned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CardType, Checklist, Comment, Priority};

    fn config() -> BoardConfig {
        BoardConfig::default()
    }

    fn card() -> Card {
        Card {
            key: "OP-12".into(),
            path: "Cards/OP-12.md".into(),
            title: "Fix login".into(),
            status: "doing".into(),
            card_type: CardType::Task,
            priority: Priority::Medium,
            assignee: None,
            labels: vec![],
            due: None,
            estimate: None,
            parent: None,
            rank: "M".into(),
            created: "2026-10-01T10:00:00.000Z".into(),
            updated: "2026-10-01T10:00:00.000Z".into(),
            resolved: None,
            body: "Text".into(),
            checklist: Checklist::default(),
            comments: vec![],
        }
    }

    fn comment(id: &str, author: &str, text: &str) -> Comment {
        Comment { id: id.into(), author: author.into(), at: "2026-10-02T10:00:00.000Z".into(), text: text.into() }
    }

    #[test]
    fn a_card_that_did_not_change_has_no_changes() {
        assert!(changes(&card(), &card(), &config(), "Agent").is_empty());
    }

    #[test]
    fn rank_updated_and_the_checklist_are_not_changes() {
        let mut after = card();
        after.rank = "Z".into();
        after.updated = "2026-10-09T10:00:00.000Z".into();
        after.checklist = Checklist { done: 1, total: 2 };
        assert!(changes(&card(), &after, &config(), "Agent").is_empty());
    }

    #[test]
    fn a_new_comment_from_someone_else_is_a_change() {
        let mut after = card();
        after.comments.push(comment("a1", "Gustavo", "Please also check Safari"));
        assert_eq!(
            changes(&card(), &after, &config(), "Agent"),
            vec![Change::Comment { author: "Gustavo".into(), text: "Please also check Safari".into() }]
        );
    }

    #[test]
    fn the_agents_own_comments_are_not_changes_whatever_the_case() {
        let mut after = card();
        after.comments.push(comment("a1", "claude code", "Done with the fix"));
        assert!(changes(&card(), &after, &config(), "  Claude Code ").is_empty());
    }

    #[test]
    fn no_own_author_means_every_comment_counts() {
        let mut after = card();
        after.comments.push(comment("a1", "Agent", "hi"));
        assert_eq!(changes(&card(), &after, &config(), "").len(), 1);
    }

    #[test]
    fn an_edited_comment_is_a_change_and_an_untouched_one_is_not() {
        let mut before = card();
        before.comments = vec![comment("a1", "Gustavo", "old"), comment("b2", "Gustavo", "same")];
        let mut after = before.clone();
        after.comments[0].text = "new".into();
        assert_eq!(
            changes(&before, &after, &config(), "Agent"),
            vec![Change::CommentEdited { author: "Gustavo".into(), text: "new".into() }]
        );
    }

    #[test]
    fn a_move_names_the_columns_and_a_move_into_done_is_the_finish() {
        let mut after = card();
        after.status = "review".into();
        assert_eq!(
            changes(&card(), &after, &config(), "Agent"),
            vec![Change::Moved { from: "In Progress".into(), to: "Review".into() }]
        );
        after.status = "done".into();
        assert_eq!(changes(&card(), &after, &config(), "Agent"), vec![Change::Done { column: "Done".into() }]);
    }

    #[test]
    fn moving_out_of_done_is_a_move_not_a_finish() {
        let mut before = card();
        before.status = "done".into();
        let after = card();
        assert_eq!(
            changes(&before, &after, &config(), "Agent"),
            vec![Change::Moved { from: "Done".into(), to: "In Progress".into() }]
        );
    }

    #[test]
    fn every_field_is_compared_and_cleared_ones_read_none() {
        let mut before = card();
        before.assignee = Some("Ana".into());
        before.due = Some("2026-10-20".into());
        let mut after = card();
        after.title = "Fix the login".into();
        after.priority = Priority::High;
        after.card_type = CardType::Bug;
        after.labels = vec!["auth".into(), "backend".into()];
        after.estimate = Some(3.0);
        after.parent = Some("OP-1".into());
        let found = changes(&before, &after, &config(), "Agent");
        let field = |name: &str| {
            found.iter().find_map(|c| match c {
                Change::Field { name: n, from, to } if *n == name => Some((from.clone(), to.clone())),
                _ => None,
            })
        };
        assert_eq!(field("title"), Some(("\"Fix login\"".into(), "\"Fix the login\"".into())));
        assert_eq!(field("priority"), Some(("medium".into(), "high".into())));
        assert_eq!(field("type"), Some(("task".into(), "bug".into())));
        assert_eq!(field("assignee"), Some(("Ana".into(), "none".into())));
        assert_eq!(field("labels"), Some(("none".into(), "auth, backend".into())));
        assert_eq!(field("due"), Some(("2026-10-20".into(), "none".into())));
        assert_eq!(field("estimate"), Some(("none".into(), "3".into())));
        assert_eq!(field("parent"), Some(("none".into(), "OP-1".into())));
    }

    #[test]
    fn a_description_edit_is_a_change() {
        let mut after = card();
        after.body = "More text".into();
        assert_eq!(changes(&card(), &after, &config(), "Agent"), vec![Change::Description]);
    }

    #[test]
    fn the_finish_comes_after_everything_else_and_comments_come_first() {
        let mut after = card();
        after.status = "done".into();
        after.body = "Final".into();
        after.comments.push(comment("a1", "Gustavo", "Great"));
        let found = changes(&card(), &after, &config(), "Agent");
        assert!(matches!(found.first(), Some(Change::Comment { .. })));
        assert!(matches!(found.last(), Some(Change::Done { .. })));
        assert_eq!(found.len(), 3);
    }

    #[test]
    fn a_line_says_the_card_who_and_what() {
        let mut after = card();
        after.comments.push(comment("a1", "Gustavo", "Only reproduces\nin Safari."));
        after.priority = Priority::High;
        let line = describe(&after, &changes(&card(), &after, &config(), "Agent"));
        assert_eq!(
            line,
            "OP-12 \"Fix login\": Gustavo commented: \"Only reproduces in Safari.\"; priority medium → high."
        );
    }

    #[test]
    fn a_long_comment_is_cut_and_the_line_says_where_to_read_the_rest() {
        let mut after = card();
        after.comments.push(comment("a1", "Gustavo", &"word ".repeat(200)));
        let line = describe(&after, &changes(&card(), &after, &config(), "Agent"));
        assert!(line.contains('…'), "{line}");
        assert!(line.ends_with("Read all of it with get_card OP-12."), "{line}");
        assert!(line.chars().count() < 450, "{}", line.chars().count());
    }

    #[test]
    fn the_finish_line_tells_the_agent_to_stop() {
        let mut after = card();
        after.status = "done".into();
        let line = describe(&after, &changes(&card(), &after, &config(), "Agent"));
        assert_eq!(
            line,
            "OP-12 \"Fix login\": moved to Done. The card is done: no more updates will follow for it, stop watching it."
        );
    }

    #[test]
    fn no_changes_make_no_line() {
        assert_eq!(describe(&card(), &[]), "");
    }

    #[test]
    fn a_comment_without_an_author_is_from_someone() {
        let mut after = card();
        after.comments.push(comment("a1", " ", "hi"));
        assert!(describe(&after, &changes(&card(), &after, &config(), "Agent")).contains("someone commented"));
    }

    #[test]
    fn leaving_the_first_column_takes_the_card_and_moving_within_the_work_does_not() {
        let mut todo = card();
        todo.status = "todo".into();
        let doing = card();
        assert!(took(&todo, &doing, &config(), "Agent"));
        let mut review = card();
        review.status = "review".into();
        assert!(!took(&doing, &review, &config(), "Agent"), "doing to review is the same work");
        assert!(!took(&doing, &todo, &config(), "Agent"), "back to the first column gives it up");
    }

    #[test]
    fn a_card_in_a_done_column_is_never_taken() {
        let mut todo = card();
        todo.status = "todo".into();
        let mut done = card();
        done.status = "done".into();
        assert!(!took(&todo, &done, &config(), "Agent"));
    }

    #[test]
    fn reopening_a_done_card_takes_it() {
        let mut done = card();
        done.status = "done".into();
        assert!(took(&done, &card(), &config(), "Agent"));
    }

    #[test]
    fn being_assigned_to_the_agent_takes_the_card_once() {
        let mut todo = card();
        todo.status = "todo".into();
        let mut mine = todo.clone();
        mine.assignee = Some("agent".into());
        assert!(took(&todo, &mine, &config(), "Agent"));
        assert!(!took(&mine, &mine, &config(), "Agent"), "already the assignee");
        let mut other = todo.clone();
        other.assignee = Some("Ana".into());
        assert!(!took(&todo, &other, &config(), "Agent"));
    }
}
