//! How the command line draws cards: colors, the aligned table, the kanban board and one card in full. A port of
//! `packages/cli/src/format.ts`; the conformance corpus holds the output of the TypeScript version, byte for byte.
//!
//! Widths count characters (Unicode scalar values), not what a terminal shows: a wide character such as `日` counts as one,
//! like the TypeScript's `[...text].length`.
use crate::config::display_column;
use crate::jscompat::{is_js_whitespace, js_trim, js_trim_end, number_to_js_string, wall_clock};
use crate::query::{DueState, Now, due_state, group_by_column, parse_timestamp_ms};
use crate::types::{BoardConfig, Card, CardType, Priority};
use std::borrow::Borrow;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Style {
    Bold,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    Gray,
}

impl Style {
    fn code(self) -> u8 {
        match self {
            Self::Bold => 1,
            Self::Red => 31,
            Self::Green => 32,
            Self::Yellow => 33,
            Self::Blue => 34,
            Self::Magenta => 35,
            Self::Cyan => 36,
            Self::Gray => 90,
        }
    }
}

/// Wraps text in ANSI escape codes, or leaves it alone when colors are off.
#[derive(Debug, Clone, Copy)]
pub struct Painter {
    pub enabled: bool,
}

impl Painter {
    pub fn paint(self, style: Style, text: &str) -> String {
        self.paint_all(&[style], text)
    }

    pub fn paint_all(self, styles: &[Style], text: &str) -> String {
        if !self.enabled {
            return text.to_string();
        }
        let codes: Vec<String> = styles.iter().map(|s| s.code().to_string()).collect();
        format!("\x1b[{}m{text}\x1b[0m", codes.join(";"))
    }
}

fn priority_glyph(priority: Priority, paint: Painter) -> String {
    let (glyph, style) = match priority {
        Priority::Highest => ("↑↑", Style::Red),
        Priority::High => ("↑ ", Style::Red),
        Priority::Medium => ("= ", Style::Yellow),
        Priority::Low => ("↓ ", Style::Blue),
        Priority::Lowest => ("↓↓", Style::Blue),
    };
    paint.paint(style, glyph)
}

fn type_glyph(card_type: CardType, paint: Painter) -> String {
    let (glyph, style) = match card_type {
        CardType::Bug => ("B", Style::Red),
        CardType::Story => ("S", Style::Green),
        CardType::Task => ("T", Style::Blue),
        CardType::Epic => ("E", Style::Magenta),
    };
    paint.paint(style, glyph)
}

fn len(text: &str) -> i64 {
    text.chars().count() as i64
}

fn spaces(count: i64) -> String {
    " ".repeat(usize::try_from(count).unwrap_or(0))
}

/// Cuts `text` to `width` characters, ending in `…` when something was left out.
pub fn truncate(text: &str, width: i64) -> String {
    if width <= 0 {
        return String::new();
    }
    if len(text) <= width {
        return text.to_string();
    }
    let kept: String = text.chars().take(usize::try_from(width - 1).unwrap_or(0)).collect();
    kept + "…"
}

pub fn pad(text: &str, width: i64) -> String {
    format!("{text}{}", spaces(width - len(text)))
}

/// Word-wrap to `width`, at most `max_lines` lines (the last one gets an ellipsis).
pub fn wrap(text: &str, width: i64, max_lines: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in text.split(is_js_whitespace).filter(|w| !w.is_empty()) {
        let word = if len(word) > width { truncate(word, width) } else { word.to_string() };
        if line.is_empty() {
            line = word;
        } else if len(&line) + 1 + len(&word) <= width {
            line.push(' ');
            line.push_str(&word);
        } else {
            lines.push(std::mem::replace(&mut line, word));
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    if lines.len() > max_lines {
        let mut kept: Vec<String> = lines[..max_lines].to_vec();
        kept[max_lines - 1] = truncate(&format!("{} {}", kept[max_lines - 1], lines[max_lines]), width);
        return kept;
    }
    if lines.is_empty() { vec![String::new()] } else { lines }
}

/// `2026-10-20` becomes `10-20` in the year of `now`, to save room.
pub fn short_date(date: &str, now: &Now) -> String {
    if date.starts_with(&now.local_date.year.to_string()) { date.chars().skip(5).collect() } else { date.to_string() }
}

fn due_text(card: &Card, config: &BoardConfig, now: &Now, paint: Painter) -> String {
    let Some(due) = card.due.as_deref().filter(|d| !d.is_empty()) else { return String::new() };
    let label = short_date(due, now);
    match due_state(card, config, now) {
        Some(DueState::Overdue) => paint.paint(Style::Red, &label),
        Some(DueState::Soon) => paint.paint(Style::Yellow, &label),
        _ => paint.paint(Style::Gray, &label),
    }
}

pub fn status_name<'a>(card: &Card, config: &'a BoardConfig) -> &'a str {
    &display_column(config, &card.status).name
}

/// An aligned table, one line per card.
pub fn render_table<C: Borrow<Card>>(
    cards: &[C],
    config: &BoardConfig,
    paint: Painter,
    width: i64,
    now: &Now,
) -> String {
    if cards.is_empty() {
        return paint.paint(Style::Gray, "No cards.");
    }
    let cards: Vec<&Card> = cards.iter().map(Borrow::borrow).collect();
    let key_w = cards.iter().map(|c| len(&c.key)).max().unwrap_or(0);
    let status_w = cards.iter().map(|c| len(status_name(c, config))).max().unwrap_or(0);
    let asg_w = cards.iter().map(|c| len(c.assignee.as_deref().unwrap_or(""))).max().unwrap_or(0).min(14);
    let due_w = if cards.iter().any(|c| c.due.as_deref().is_some_and(|d| !d.is_empty())) { 5 } else { 0 };
    let fixed = 1
        + 1
        + 2
        + 1
        + key_w
        + 1
        + status_w
        + 1
        + if asg_w > 0 { asg_w + 1 } else { 0 }
        + if due_w > 0 { due_w + 1 } else { 0 };
    let title_w = (width - fixed).max(16);

    let lines: Vec<String> = cards
        .iter()
        .map(|c| {
            let mut parts = vec![
                type_glyph(c.card_type, paint),
                priority_glyph(c.priority, paint),
                paint.paint(Style::Bold, &pad(&c.key, key_w)),
                paint.paint(Style::Cyan, &pad(status_name(c, config), status_w)),
            ];
            if asg_w > 0 {
                parts.push(pad(&truncate(c.assignee.as_deref().unwrap_or(""), asg_w), asg_w));
            }
            if due_w > 0 {
                parts.push(match c.due.as_deref().filter(|d| !d.is_empty()) {
                    Some(due) => {
                        format!("{}{}", due_text(c, config, now, paint), spaces(due_w - len(&short_date(due, now))))
                    }
                    None => spaces(due_w),
                });
            }
            let progress = if c.checklist.total > 0 {
                format!(" {}/{}", c.checklist.done, c.checklist.total)
            } else {
                String::new()
            };
            let checklist = if progress.is_empty() { String::new() } else { paint.paint(Style::Gray, &progress) };
            let labels = if c.labels.is_empty() {
                String::new()
            } else {
                paint.paint(Style::Gray, &format!(" #{}", c.labels.join(" #")))
            };
            let title = truncate(&c.title, title_w - len(&progress));
            format!("{} {title}{checklist}{labels}", parts.join(" "))
        })
        .collect();
    lines.join("\n")
}

struct Cell {
    text: String,
    len: i64,
}

fn plain(text: &str) -> Cell {
    Cell { text: text.to_string(), len: len(text) }
}

/// A kanban board in the terminal: columns side by side, or stacked when the terminal is narrow.
pub fn render_board<C: Borrow<Card> + Clone>(
    cards: &[C],
    config: &BoardConfig,
    paint: Painter,
    width: i64,
    now: &Now,
) -> String {
    let groups = group_by_column(cards, config);
    let gap = 2_i64;
    let count = groups.len() as i64;
    let col_w = (width - gap * (count - 1)).div_euclid(count);
    let side_by_side = col_w >= 20;
    let w = if side_by_side { col_w } else { width.max(30) };

    let columns: Vec<Vec<Cell>> = groups
        .iter()
        .map(|group| {
            let column = &group.column;
            let wip = column.wip.filter(|n| *n > 0);
            let over = wip.is_some_and(|n| group.cards.len() as u64 > u64::from(n));
            let counter = match wip {
                Some(n) => format!("{}/{n}", group.cards.len()),
                None => group.cards.len().to_string(),
            };
            let title = truncate(&column.name.to_uppercase(), w - len(&counter) - 3);
            let head = format!(
                "{} {}",
                paint.paint_all(&[Style::Bold, if column.done { Style::Green } else { Style::Cyan }], &title),
                paint.paint(if over { Style::Red } else { Style::Gray }, &counter)
            );
            let mut out = vec![
                Cell { text: head, len: len(&title) + 1 + len(&counter) },
                Cell { text: paint.paint(Style::Gray, &"─".repeat(usize::try_from(w).unwrap_or(0))), len: w },
            ];
            for item in &group.cards {
                let c: &Card = item.borrow();
                let id_line = format!(
                    "{} {} {}",
                    type_glyph(c.card_type, paint),
                    paint.paint(Style::Bold, &c.key),
                    priority_glyph(c.priority, paint)
                );
                let id_len = 1 + 1 + len(&c.key) + 1 + 2;
                let mut meta: Vec<String> = Vec::new();
                let mut meta_len = 0_i64;
                let mut push = |text: String, text_len: i64| {
                    let extra = if meta.is_empty() { 0 } else { 1 };
                    if meta_len + text_len + extra > w {
                        return;
                    }
                    meta_len += text_len + extra;
                    meta.push(text);
                };
                if let Some(assignee) = c.assignee.as_deref().filter(|a| !a.is_empty()) {
                    push(
                        paint.paint(Style::Magenta, &format!("@{}", truncate(assignee, 12))),
                        1 + len(assignee).min(12),
                    );
                }
                if let Some(due) = c.due.as_deref().filter(|d| !d.is_empty()) {
                    push(due_text(c, config, now, paint), len(&short_date(due, now)));
                }
                if c.checklist.total > 0 {
                    let progress = format!("{}/{}", c.checklist.done, c.checklist.total);
                    let progress_len = len(&progress);
                    push(paint.paint(Style::Gray, &progress), progress_len);
                }
                out.push(Cell { text: id_line, len: id_len });
                for line in wrap(&c.title, w, 2) {
                    out.push(plain(&line));
                }
                if !meta.is_empty() {
                    out.push(Cell { text: meta.join(" "), len: meta_len });
                }
                out.push(plain(""));
            }
            if group.cards.is_empty() {
                out.push(Cell { text: paint.paint(Style::Gray, "(empty)"), len: 7 });
            }
            out
        })
        .collect();

    if !side_by_side {
        let stacked: Vec<String> =
            columns.iter().map(|col| col.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join("\n")).collect();
        return stacked.join("\n\n");
    }
    let rows = columns.iter().map(Vec::len).max().unwrap_or(0);
    let separator = spaces(gap);
    let lines: Vec<String> = (0..rows)
        .map(|r| {
            let cells: Vec<String> = columns
                .iter()
                .map(|col| match col.get(r) {
                    Some(cell) => format!("{}{}", cell.text, spaces(w - cell.len)),
                    None => spaces(w),
                })
                .collect();
            js_trim_end(&cells.join(&separator)).to_string()
        })
        .collect();
    lines.join("\n")
}

/// `2026-10-14T17:02:00Z` becomes `2026-10-14 14:02` (local time); empty when it is not a date.
fn comment_time(iso: &str, offset_minutes: i32) -> String {
    let Some(ms) = parse_timestamp_ms(iso) else { return String::new() };
    let (year, month, day, hour, minute) = wall_clock(ms, offset_minutes);
    format!("{year}-{month:02}-{day:02} {hour:02}:{minute:02}")
}

/// One card in full: its fields, the description and the comments.
pub fn render_card(card: &Card, config: &BoardConfig, paint: Painter, now: &Now, offset_minutes: i32) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!(
        "{} {}  {}",
        type_glyph(card.card_type, paint),
        paint.paint(Style::Bold, &card.key),
        paint.paint(Style::Bold, &card.title)
    ));
    let mut field = |label: &str, value: Option<String>| {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            lines.push(format!("{}{value}", paint.paint(Style::Gray, &pad(label, 10))));
        }
    };
    field("Status", Some(paint.paint(Style::Cyan, status_name(card, config))));
    field("Priority", Some(format!("{} {}", priority_glyph(card.priority, paint), card.priority.as_str())));
    field("Type", Some(card.card_type.as_str().to_string()));
    field("Assignee", card.assignee.clone());
    field(
        "Labels",
        (!card.labels.is_empty()).then(|| card.labels.iter().map(|l| format!("#{l}")).collect::<Vec<_>>().join(" ")),
    );
    field("Due", card.due.as_deref().filter(|d| !d.is_empty()).map(|_| due_text(card, config, now, paint)));
    field("Estimate", card.estimate.map(number_to_js_string));
    field("Parent", card.parent.clone());
    field("Checklist", (card.checklist.total > 0).then(|| format!("{}/{}", card.checklist.done, card.checklist.total)));
    field("Created", Some(card.created.clone()));
    field("Updated", Some(card.updated.clone()));
    field("Resolved", card.resolved.clone());
    field("Note", Some(card.path.clone()));
    let body = js_trim(&card.body);
    if !body.is_empty() {
        lines.push(String::new());
        lines.push(body.to_string());
    }
    if !card.comments.is_empty() {
        lines.push(String::new());
        lines.push(paint.paint(Style::Bold, &format!("Comments ({})", card.comments.len())));
        for c in &card.comments {
            lines.push(String::new());
            lines.push(format!(
                "{} {}  {}",
                paint.paint(Style::Magenta, &c.author),
                paint.paint(Style::Gray, &comment_time(&c.at, offset_minutes)),
                paint.paint(Style::Gray, &format!("#{}", c.id))
            ));
            lines.extend(c.text.split('\n').map(|l| if l.is_empty() { String::new() } else { format!("  {l}") }));
        }
    }
    lines.join("\n")
}
