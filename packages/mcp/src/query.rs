//! Filtering, sorting and grouping of cards, due dates and archiving. A port of `packages/core/src/query.ts`, which is
//! the reference: every function here behaves like its TypeScript counterpart, quirks included, and the conformance
//! corpus (`tests/fixtures/query.json`) replays the TypeScript results against this code.
//!
//! The functions are generic over how the caller holds its cards (`Card`, `&Card`, `Arc<Card>`: anything that
//! `Borrow<Card>`), so an index that shares its cards never has to clone one just to sort or filter it.
//!
//! Differences from the TypeScript, all of them forced by the language and none visible with a normal board:
//! - Time is never read from the clock. The caller passes a [`Now`]: the instant, and the calendar date on the
//!   caller's wall clock (the TypeScript reads both from a local `Date`).
//! - A board with no columns at all (the TypeScript throws a `TypeError` as soon as it holds a card) sorts every card as
//!   column 0, has no groups, and matches no status filter. `normalize_config` never produces such a board.
//! - [`parse_timestamp_ms`] understands the ISO 8601 forms that `Date.parse` accepts without consulting the time zone.
//!   For the legacy forms V8 also accepts (`Oct 14 2026`, a date-time with no offset, ...) it returns `None`, which the
//!   archiving rule reads as "not archived", the same as for any text that is not a date.
use crate::error::{Error, Result};
use crate::types::{BoardConfig, Card, CardType, Column, PRIORITIES, Placement, Priority};
use serde::{Deserialize, Serialize};
use std::borrow::Borrow;
use std::cmp::Ordering;
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;

/// Value for [`CardFilter::assignee`] that matches cards with nobody assigned.
pub const UNASSIGNED: &str = "@none";

/// What to keep. An empty list or `None` means "do not filter on this".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CardFilter {
    /// Matches key, title, labels, assignee, description and comments (accent/case-insensitive, all words).
    pub text: Option<String>,
    pub status: Vec<String>,
    #[serde(rename = "type")]
    pub card_type: Vec<CardType>,
    pub priority: Vec<Priority>,
    pub assignee: Vec<String>,
    /// Matches cards having ANY of these labels.
    pub labels: Vec<String>,
    pub parent: Option<String>,
}

// --- JavaScript string semantics ----------------------------------------------------------------------------------

/// The characters JavaScript's `String.prototype.trim` and the regular expression `\s` treat as white space.
/// Not the same set as Rust's `char::is_whitespace`: JavaScript includes U+FEFF and leaves out U+0085.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `text.trim()` as JavaScript does it.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Compares two strings the way JavaScript's `<` does: by UTF-16 code units. That differs from Rust's byte order only
/// when a supplementary character (an emoji, say) meets one of U+E000..U+FFFF, which sort the other way round.
pub fn js_cmp(a: &str, b: &str) -> Ordering {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    match x.iter().zip(y).position(|(p, q)| p != q) {
        None => x.len().cmp(&y.len()),
        Some(i) => {
            let (p, q) = (x[i], y[i]);
            // UTF-8 lead bytes: 0xEE and 0xEF start U+E000..U+FFFF, 0xF0 and up start the supplementary planes. In
            // UTF-16 the latter begin with a surrogate (U+D800..U+DBFF), which is below U+E000.
            let high_bmp = |v: u8| v == 0xEE || v == 0xEF;
            if (high_bmp(p) && q >= 0xF0) || (p >= 0xF0 && high_bmp(q)) { q.cmp(&p) } else { p.cmp(&q) }
        }
    }
}

/// Lower-case, accent-free text for searching: NFD, combining marks U+0300..U+036F dropped, then lower-cased, in this
/// order, exactly like the TypeScript `normalizeText`.
pub fn normalize_text(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    let stripped: String = text.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect();
    stripped.to_lowercase()
}

// --- columns ------------------------------------------------------------------------------------------------------

/// The first column with this id.
pub(crate) fn column_by_id<'a>(config: &'a BoardConfig, id: &str) -> Option<&'a Column> {
    config.columns.iter().find(|c| c.id == id)
}

/// The column a card is displayed in; unknown statuses fall back to the first column.
pub(crate) fn display_column<'a>(config: &'a BoardConfig, status: &str) -> Option<&'a Column> {
    column_by_id(config, status).or_else(|| config.columns.first())
}

fn display_column_id<'a>(config: &'a BoardConfig, status: &str) -> &'a str {
    display_column(config, status).map_or("", |c| c.id.as_str())
}

pub(crate) fn is_done_status(config: &BoardConfig, status: &str) -> bool {
    column_by_id(config, status).is_some_and(|c| c.done)
}

// --- filtering ----------------------------------------------------------------------------------------------------

/// The searchable text of a card, normalized: key, title, assignee, labels, description and every comment.
pub fn haystack(card: &Card) -> String {
    let mut text = String::with_capacity(card.title.len() + card.body.len() + 64);
    for part in [card.key.as_str(), &card.title, card.assignee.as_deref().unwrap_or("")] {
        text.push_str(part);
        text.push('\n');
    }
    text.push_str(&card.labels.join(" "));
    text.push('\n');
    text.push_str(&card.body);
    for comment in &card.comments {
        text.push('\n');
        text.push_str(&comment.text);
    }
    normalize_text(&text)
}

/// A filter prepared once (its texts normalized once) to be applied to many cards.
pub struct PreparedFilter<'f> {
    filter: &'f CardFilter,
    assignee: Vec<Option<String>>,
    labels: Vec<String>,
    parent: Option<String>,
    words: Vec<String>,
}

impl<'f> PreparedFilter<'f> {
    pub fn new(filter: &'f CardFilter) -> Self {
        // `None` stands for the UNASSIGNED sentinel.
        let assignee =
            filter.assignee.iter().map(|a| if a == UNASSIGNED { None } else { Some(normalize_text(a)) }).collect();
        let labels = filter.labels.iter().map(|l| normalize_text(l)).collect();
        let parent = filter.parent.as_deref().filter(|p| !p.is_empty()).map(str::to_uppercase);
        let words = match filter.text.as_deref() {
            Some(text) if !js_trim(text).is_empty() => {
                normalize_text(text).split(is_js_whitespace).filter(|w| !w.is_empty()).map(str::to_owned).collect()
            }
            _ => Vec::new(),
        };
        Self { filter, assignee, labels, parent, words }
    }

    /// Whether the card passes every dimension of the filter. `haystack` is the card's normalized search text when the
    /// caller has it cached; otherwise it is computed here, and only if the filter has a text part.
    pub fn matches(&self, card: &Card, config: &BoardConfig, haystack_cache: Option<&str>) -> bool {
        let f = self.filter;
        if !f.status.is_empty() && !f.status.iter().any(|s| s == display_column_id(config, &card.status)) {
            return false;
        }
        if !f.card_type.is_empty() && !f.card_type.contains(&card.card_type) {
            return false;
        }
        if !f.priority.is_empty() && !f.priority.contains(&card.priority) {
            return false;
        }
        if !self.assignee.is_empty() {
            // An empty assignee counts as nobody; a name that normalizes to "@none" is taken for the sentinel too.
            let who = match card.assignee.as_deref() {
                Some(a) if !a.is_empty() => normalize_text(a),
                _ => UNASSIGNED.to_owned(),
            };
            let hit = self.assignee.iter().any(|a| match a {
                None => who == UNASSIGNED,
                Some(wanted) => *wanted == who,
            });
            if !hit {
                return false;
            }
        }
        if !self.labels.is_empty()
            && !self.labels.iter().any(|wanted| card.labels.iter().any(|label| normalize_text(label) == *wanted))
        {
            return false;
        }
        if let Some(parent) = &self.parent
            && card.parent.as_deref() != Some(parent.as_str())
        {
            return false;
        }
        if !self.words.is_empty() {
            let computed;
            let hay = match haystack_cache {
                Some(h) => h,
                None => {
                    computed = haystack(card);
                    &computed
                }
            };
            if !self.words.iter().all(|w| hay.contains(w.as_str())) {
                return false;
            }
        }
        true
    }
}

pub fn matches_filter(card: &Card, filter: &CardFilter, config: &BoardConfig) -> bool {
    PreparedFilter::new(filter).matches(card, config, None)
}

fn as_card<C: Borrow<Card>>(card: &C) -> &Card {
    card.borrow()
}

/// The cards that match, in their original order.
pub fn filter_cards<'a, C: Borrow<Card>>(cards: &'a [C], filter: &CardFilter, config: &BoardConfig) -> Vec<&'a C> {
    let prepared = PreparedFilter::new(filter);
    cards.iter().filter(|c| prepared.matches(as_card(*c), config, None)).collect()
}

// --- sorting and grouping -----------------------------------------------------------------------------------------

fn column_index(config: &BoardConfig) -> HashMap<&str, usize> {
    // Built like a JavaScript `Map` from `[id, index]` pairs: a repeated id keeps its LAST index.
    config.columns.iter().enumerate().map(|(i, c)| (c.id.as_str(), i)).collect()
}

fn column_of(config: &BoardConfig, index: &HashMap<&str, usize>, status: &str) -> usize {
    index.get(display_column_id(config, status)).copied().unwrap_or(0)
}

fn then_by_card(a: &Card, b: &Card) -> Ordering {
    js_cmp(&a.rank, &b.rank).then_with(|| js_cmp(&a.created, &b.created)).then_with(|| js_cmp(&a.key, &b.key))
}

/// Board order: column order, then rank, then creation time, then key.
pub fn compare_cards(config: &BoardConfig) -> impl Fn(&Card, &Card) -> Ordering + '_ {
    let index = column_index(config);
    move |a, b| {
        column_of(config, &index, &a.status).cmp(&column_of(config, &index, &b.status)).then_with(|| then_by_card(a, b))
    }
}

/// A sorted copy (stable, like the TypeScript): pass `&Card` or `Arc<Card>` to keep it cheap.
pub fn sort_cards<C: Borrow<Card> + Clone>(cards: &[C], config: &BoardConfig) -> Vec<C> {
    let index = column_index(config);
    let mut keyed: Vec<(usize, &C)> =
        cards.iter().map(|c| (column_of(config, &index, &as_card(c).status), c)).collect();
    keyed.sort_by(|x, y| x.0.cmp(&y.0).then_with(|| then_by_card(as_card(x.1), as_card(y.1))));
    keyed.into_iter().map(|(_, c)| c.clone()).collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ColumnGroup<C> {
    pub column: Column,
    pub cards: Vec<C>,
}

/// Cards grouped per column, each group already in board order.
pub fn group_by_column<C: Borrow<Card> + Clone>(cards: &[C], config: &BoardConfig) -> Vec<ColumnGroup<C>> {
    // Like the TypeScript, a repeated column id sends its cards to the LAST column that has it, and every column with
    // that id then reports that same group.
    let last: HashMap<&str, usize> = column_index(config);
    let mut groups: Vec<ColumnGroup<C>> =
        config.columns.iter().map(|c| ColumnGroup { column: c.clone(), cards: Vec::new() }).collect();
    for card in sort_cards(cards, config) {
        if let Some(&at) = last.get(display_column_id(config, &as_card(&card).status)) {
            groups[at].cards.push(card);
        }
    }
    config.columns.iter().map(|c| groups[last[c.id.as_str()]].clone()).collect()
}

pub fn priority_weight(priority: Priority) -> usize {
    PRIORITIES.iter().position(|p| *p == priority).unwrap_or(0)
}

// --- dates --------------------------------------------------------------------------------------------------------

/// A calendar date. The year is printed without padding, like JavaScript's `getFullYear()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CivilDate {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

/// Days from 1970-01-01 to the given proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of [`days_from_civil`].
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

impl CivilDate {
    pub fn new(year: i32, month: u32, day: u32) -> Self {
        Self { year, month, day }
    }

    pub fn to_epoch_days(self) -> i64 {
        days_from_civil(i64::from(self.year), i64::from(self.month), i64::from(self.day))
    }

    pub fn from_epoch_days(days: i64) -> Self {
        let (y, m, d) = civil_from_days(days);
        // The year of any instant JavaScript can represent fits an i32, and month and day are small.
        Self { year: y as i32, month: m as u32, day: d as u32 }
    }

    /// This date `days` calendar days later (earlier when negative).
    pub fn add_days(self, days: i64) -> Self {
        Self::from_epoch_days(self.to_epoch_days() + days)
    }
}

/// `YYYY-MM-DD`, as the TypeScript `localDate` writes it.
pub fn local_date(date: CivilDate) -> String {
    format!("{}-{:02}-{:02}", date.year, date.month, date.day)
}

/// The moment the rules are evaluated at: the instant itself, and the calendar date on the caller's wall clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Now {
    /// Milliseconds since the Unix epoch.
    pub epoch_ms: i64,
    /// Today's date where the user is (the TypeScript's `localDate(now)`).
    pub local_date: CivilDate,
}

impl Now {
    /// `epoch_ms` seen from a wall clock `offset_minutes` ahead of UTC (negative for the Americas).
    pub fn from_utc_offset(epoch_ms: i64, offset_minutes: i32) -> Self {
        let local_ms = epoch_ms + i64::from(offset_minutes) * 60_000;
        Self { epoch_ms, local_date: CivilDate::from_epoch_days(local_ms.div_euclid(86_400_000)) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DueState {
    Overdue,
    Soon,
    Later,
}

/// Done cards are never overdue. "soon" is due today or within 2 days. `None` when the card has no due date.
pub fn due_state(card: &Card, config: &BoardConfig, now: &Now) -> Option<DueState> {
    let due = card.due.as_deref().filter(|d| !d.is_empty())?;
    if is_done_status(config, &card.status) {
        return Some(DueState::Later);
    }
    if js_cmp(due, &local_date(now.local_date)) == Ordering::Less {
        return Some(DueState::Overdue);
    }
    let limit = local_date(now.local_date.add_days(2));
    Some(if js_cmp(due, &limit) != Ordering::Greater { DueState::Soon } else { DueState::Later })
}

const MS_PER_DAY: i64 = 86_400_000;
/// ECMAScript's TimeClip: a time value beyond this many milliseconds from the epoch is invalid.
const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

fn digits(bytes: &[u8], at: usize, len: usize) -> Option<(i64, usize)> {
    let chunk = bytes.get(at..at + len)?;
    if !chunk.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some((chunk.iter().fold(0, |n, d| n * 10 + i64::from(d - b'0')), at + len))
}

/// Milliseconds since the epoch for an ISO 8601 timestamp, like `Date.parse` for the forms that do not depend on the
/// local time zone: `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (UTC), and a date followed by `T` (or `t`) and `HH:mm[:ss[.fff]]`
/// with an offset (`Z`, `z`, `+HH:MM` or `+HHMM`); a year may be `+YYYYYY` or `-YYYYYY`. The day may be 29 to 31 in any
/// month and rolls over into the next one, exactly as V8 does. Anything else is `None`: a space instead of the `T`, for
/// instance, sends V8 to its legacy parser, which reads the year `0050` as 1950.
pub fn parse_timestamp_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let (year, mut at) = match b.first()? {
        sign @ (b'+' | b'-') => {
            let (n, next) = digits(b, 1, 6)?;
            if *sign == b'-' && n == 0 {
                return None;
            }
            (if *sign == b'-' { -n } else { n }, next)
        }
        _ => digits(b, 0, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    if b.get(at) == Some(&b'-') {
        let (m, next) = digits(b, at + 1, 2)?;
        if !(1..=12).contains(&m) {
            return None;
        }
        month = m;
        at = next;
        if b.get(at) == Some(&b'-') {
            let (d, next) = digits(b, at + 1, 2)?;
            if !(1..=31).contains(&d) {
                return None;
            }
            day = d;
            at = next;
        }
    }
    let date_ms = (days_from_civil(year, month, 1) + day - 1) * MS_PER_DAY;

    let time_ms = if at == b.len() {
        return time_clip(date_ms);
    } else {
        if !matches!(b[at], b'T' | b't') {
            return None;
        }
        let (hour, next) = digits(b, at + 1, 2)?;
        if b.get(next) != Some(&b':') {
            return None;
        }
        let (minute, next) = digits(b, next + 1, 2)?;
        at = next;
        let (mut second, mut millis) = (0, 0);
        if b.get(at) == Some(&b':') {
            let (s, next) = digits(b, at + 1, 2)?;
            second = s;
            at = next;
            if b.get(at) == Some(&b'.') {
                let start = at + 1;
                let end = b[start..].iter().position(|c| !c.is_ascii_digit()).map_or(b.len(), |n| start + n);
                if end == start {
                    return None;
                }
                // Only the first three digits count: the rest is below a millisecond.
                millis =
                    b[start..end].iter().take(3).enumerate().map(|(i, d)| i64::from(d - b'0') * [100, 10, 1][i]).sum();
                at = end;
            }
        }
        if minute > 59 || second > 59 || hour > 24 || (hour == 24 && (minute, second, millis) != (0, 0, 0)) {
            return None;
        }
        hour * 3_600_000 + minute * 60_000 + second * 1000 + millis
    };

    // A date-time must say which time zone it is in; without that, JavaScript uses the machine's own zone.
    let offset_ms = match b.get(at)? {
        b'Z' | b'z' if at + 1 == b.len() => 0,
        sign @ (b'+' | b'-') => {
            let (hh, next) = digits(b, at + 1, 2)?;
            let next = if b.get(next) == Some(&b':') { next + 1 } else { next };
            let (mm, end) = digits(b, next, 2)?;
            if end != b.len() || hh > 23 || mm > 59 {
                return None;
            }
            let magnitude = (hh * 60 + mm) * 60_000;
            if *sign == b'+' { magnitude } else { -magnitude }
        }
        _ => return None,
    };
    time_clip(date_ms + time_ms - offset_ms)
}

fn time_clip(ms: i64) -> Option<i64> {
    (ms.abs() <= MAX_TIME_MS).then_some(ms)
}

/// Done cards resolved more than `hide_done_after_days` ago are kept off the board. A card with no `resolved` time is
/// dated by its `updated` time; text that is not a date never hides a card.
pub fn is_archived_done(card: &Card, config: &BoardConfig, now: &Now) -> bool {
    let days = i64::from(config.hide_done_after_days);
    if days == 0 || !is_done_status(config, &card.status) {
        return false;
    }
    let stamp = card.resolved.as_deref().unwrap_or(&card.updated);
    parse_timestamp_ms(stamp).is_some_and(|at| now.epoch_ms - at > days * MS_PER_DAY)
}

// --- moving cards -------------------------------------------------------------------------------------------------

/// Rank for putting `moving` into column `status` at `placement`, given a way to pick a rank between two others
/// (`None` is the top or the bottom of the column). `cards` is any snapshot of the board; `moving` itself is ignored,
/// so the same call works for reordering inside a column.
///
/// Neighbours with equal or inverted ranks (hand-edited notes, sync merges) have no rank between them, so the card
/// settles for right after the upper neighbour.
pub fn rank_for_placement_with<C: Borrow<Card> + Clone>(
    cards: &[C],
    config: &BoardConfig,
    moving: &str,
    status: &str,
    placement: &Placement,
    rank_between: impl Fn(Option<&str>, Option<&str>) -> Result<String>,
) -> Result<String> {
    let column_id = display_column_id(config, status);
    let in_column: Vec<C> = cards
        .iter()
        .filter(|c| as_card(*c).key != moving && display_column_id(config, &as_card(*c).status) == column_id)
        .cloned()
        .collect();
    let column = sort_cards(&in_column, config);
    let find = |key: &str| -> Result<usize> {
        column
            .iter()
            .position(|c| as_card(c).key == key)
            .ok_or_else(|| Error::validation(format!("Card {key} is not in column \"{column_id}\"")))
    };
    let at = |i: Option<usize>| i.and_then(|i| column.get(i)).map(|c| as_card(c).rank.as_str());

    let (prev, next) = match (placement.before.as_deref(), placement.after.as_deref()) {
        (Some(before), _) if !before.is_empty() => {
            let i = find(before)?;
            (at(i.checked_sub(1)), at(Some(i)))
        }
        (_, Some(after)) if !after.is_empty() => {
            let i = find(after)?;
            (at(Some(i)), at(Some(i + 1)))
        }
        _ => (at(column.len().checked_sub(1)), None),
    };
    match (prev, next) {
        (Some(lo), Some(hi)) if js_cmp(lo, hi) != Ordering::Less => rank_between(Some(lo), None),
        (lo, hi) => rank_between(lo, hi),
    }
}

/// [`rank_for_placement_with`] using the crate's own [`rank_between`](crate::rank::rank_between).
pub fn rank_for_placement<C: Borrow<Card> + Clone>(
    cards: &[C],
    config: &BoardConfig,
    moving: &str,
    status: &str,
    placement: &Placement,
) -> Result<String> {
    rank_for_placement_with(cards, config, moving, status, placement, crate::rank::rank_between)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Checklist;

    fn card(key: &str) -> Card {
        Card {
            key: key.into(),
            path: format!("Cards/{key}.md"),
            title: key.into(),
            status: "todo".into(),
            card_type: CardType::Task,
            priority: Priority::Medium,
            assignee: None,
            labels: vec![],
            due: None,
            estimate: None,
            parent: None,
            rank: "V".into(),
            created: "2026-01-01T00:00:00.000Z".into(),
            updated: "2026-01-01T00:00:00.000Z".into(),
            resolved: None,
            body: String::new(),
            checklist: Checklist::default(),
            comments: vec![],
        }
    }

    #[test]
    fn normalize_text_follows_the_typescript_pipeline() {
        assert_eq!(normalize_text("Résumé"), normalize_text("RESUME"));
        assert_eq!(normalize_text("Zoë Müller"), "zoe muller");
        assert_eq!(normalize_text("Straße"), "straße"); // ß is a letter of its own
        assert_eq!(normalize_text("\u{212b}ngstr\u{f6}m"), "angstrom"); // the Angstrom sign decomposes to A + ring
        assert_eq!(normalize_text("ΑΣ"), "ας"); // final sigma, as in JavaScript
        assert_eq!(normalize_text("İ"), "i"); // NFD splits the dot off before the marks are stripped
        assert_eq!(normalize_text(""), "");
    }

    #[test]
    fn js_whitespace_is_javascripts_not_rusts() {
        assert!(is_js_whitespace('\u{feff}'));
        assert!(!is_js_whitespace('\u{85}'));
        assert!(is_js_whitespace('\u{2028}'));
        assert!(!is_js_whitespace('\u{200b}'));
        assert_eq!(js_trim("\u{feff} a b \u{3000}"), "a b");
        assert_eq!(js_trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
    }

    #[test]
    fn js_cmp_orders_by_utf16_code_units() {
        // U+10000 is a surrogate pair in UTF-16 (D800 DC00), which sorts BEFORE U+E000 there but after it in UTF-8.
        assert_eq!(js_cmp("\u{10000}", "\u{e000}"), Ordering::Less);
        assert_eq!(js_cmp("\u{e000}", "\u{10000}"), Ordering::Greater);
        assert_eq!(js_cmp("\u{10000}", "\u{ffff}"), Ordering::Less);
        assert_eq!(js_cmp("\u{1f600}", "\u{10000}"), Ordering::Greater);
        assert_eq!(js_cmp("a", "b"), Ordering::Less);
        assert_eq!(js_cmp("ab", "a"), Ordering::Greater);
        assert_eq!(js_cmp("", ""), Ordering::Equal);
    }

    #[test]
    fn civil_dates_round_trip_through_epoch_days() {
        for (y, m, d) in [(1970, 1, 1), (2026, 10, 14), (2024, 2, 29), (1900, 3, 1), (1, 1, 1), (-1, 12, 31)] {
            let date = CivilDate::new(y, m, d);
            assert_eq!(CivilDate::from_epoch_days(date.to_epoch_days()), date);
        }
        assert_eq!(CivilDate::new(1970, 1, 1).to_epoch_days(), 0);
        assert_eq!(CivilDate::new(2026, 12, 31).add_days(2), CivilDate::new(2027, 1, 2));
        assert_eq!(CivilDate::new(2024, 2, 28).add_days(2), CivilDate::new(2024, 3, 1));
        assert_eq!(CivilDate::new(2026, 3, 1).add_days(-1), CivilDate::new(2026, 2, 28));
    }

    #[test]
    fn local_date_pads_month_and_day_but_not_the_year() {
        assert_eq!(local_date(CivilDate::new(2026, 1, 5)), "2026-01-05");
        assert_eq!(local_date(CivilDate::new(5, 11, 30)), "5-11-30");
    }

    #[test]
    fn now_from_a_utc_offset_moves_the_calendar_date() {
        let late_utc = 1_791_979_200_000 + 11 * 3_600_000; // 2026-10-14T23:00:00Z
        assert_eq!(Now::from_utc_offset(late_utc, 0).local_date, CivilDate::new(2026, 10, 14));
        assert_eq!(Now::from_utc_offset(late_utc, 120).local_date, CivilDate::new(2026, 10, 15));
        assert_eq!(Now::from_utc_offset(late_utc, -180).local_date, CivilDate::new(2026, 10, 14));
        assert_eq!(Now::from_utc_offset(0, -1).local_date, CivilDate::new(1969, 12, 31));
    }

    #[test]
    fn timestamps_parse_like_date_parse() {
        assert_eq!(parse_timestamp_ms("2026-10-14T12:00:00.000Z"), Some(1_791_979_200_000));
        assert_eq!(parse_timestamp_ms("2026-10-14T12:00Z"), Some(1_791_979_200_000));
        assert_eq!(parse_timestamp_ms("2026-10-14T12:00:00.5Z"), Some(1_791_979_200_500));
        assert_eq!(parse_timestamp_ms("2026-10-14T12:00:00.123456Z"), Some(1_791_979_200_123));
        assert_eq!(parse_timestamp_ms("2026-10-14"), Some(1_791_936_000_000));
        assert_eq!(parse_timestamp_ms("2026-10"), Some(1_790_812_800_000));
        assert_eq!(parse_timestamp_ms("2026"), Some(1_767_225_600_000));
        assert_eq!(parse_timestamp_ms("2026-10-14T12:00:00+02:00"), Some(1_791_972_000_000));
        assert_eq!(parse_timestamp_ms("2026-10-14T12:00:00+0200"), Some(1_791_972_000_000));
        assert_eq!(parse_timestamp_ms("2026-10-14T12:00:00-03:30"), Some(1_791_991_800_000));
        assert_eq!(parse_timestamp_ms("2026-10-14T24:00:00Z"), Some(1_792_022_400_000));
        assert_eq!(parse_timestamp_ms("2026-02-30"), Some(1_772_409_600_000)); // rolls over to March 2, like V8
        assert_eq!(parse_timestamp_ms("2026-10-14t12:00:00z"), Some(1_791_979_200_000));
        assert_eq!(parse_timestamp_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_timestamp_ms("0001-01-01T00:00:00Z"), Some(-62_135_596_800_000));
        assert_eq!(parse_timestamp_ms("+275760-09-13T00:00:00.000Z"), Some(8_640_000_000_000_000));
        assert_eq!(parse_timestamp_ms("-271821-04-20T00:00:00.000Z"), Some(-8_640_000_000_000_000));
    }

    #[test]
    fn timestamps_that_date_parse_rejects_are_none() {
        for bad in [
            "",
            "garbage",
            "2026-13-01",
            "2026-00-10",
            "2026-10-00",
            "2026-10-32",
            "2026-10-14T25:00:00Z",
            "2026-10-14T24:00:01Z",
            "2026-10-14T12:60:00Z",
            "2026-10-14T12:00:60Z",
            "2026-10-14T12:00:00+24:00",
            "2026-10-14T12:00:00+02",
            "2026-10-14T12:00:00,5Z",
            "2026-10-14T12:00:00.Z",
            "2026-10-14T12",
            "2026-10-14T1:00:00Z",
            "2026-10-14T12:0:00Z",
            "-000000-01-01T00:00:00Z",
            "+275760-09-13T00:00:00.001Z",
            "-271821-04-19T23:59:59.999Z",
            "2026-10-14T12:00:00.000 Z",
            "T",
            "Z",
            "2026-10-14T12:00:00Zjunk",
        ] {
            assert_eq!(parse_timestamp_ms(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn timestamps_with_no_offset_depend_on_the_time_zone_and_are_refused() {
        for local in [
            "2026-10-14T12:00:00",
            "2026-10-14T12:00",
            "Oct 14 2026",
            "2026/10/14",
            "10/14/2026",
            "2026-10-14 12:00:00Z",
            "0050-03-04 00:00:00Z",
        ] {
            assert_eq!(parse_timestamp_ms(local), None, "{local:?}");
        }
    }

    #[test]
    fn rank_for_placement_hands_the_right_neighbours_to_the_rank_function() {
        let mut cards = vec![card("OP-1"), card("OP-2"), card("OP-3")];
        for (c, rank) in cards.iter_mut().zip(["A", "M", "Z"]) {
            c.rank = rank.into();
        }
        let config = BoardConfig::default();
        let bounds = |moving: &str, status: &str, placement: Placement| {
            rank_for_placement_with(&cards, &config, moving, status, &placement, |lo, hi| {
                Ok(format!("{}|{}", lo.unwrap_or("-"), hi.unwrap_or("-")))
            })
        };
        let before = |k: &str| Placement { before: Some(k.into()), after: None };
        let after = |k: &str| Placement { after: Some(k.into()), before: None };
        assert_eq!(bounds("OP-9", "todo", Placement::default()).unwrap(), "Z|-");
        assert_eq!(bounds("OP-9", "todo", before("OP-1")).unwrap(), "-|A");
        assert_eq!(bounds("OP-9", "todo", before("OP-3")).unwrap(), "M|Z");
        assert_eq!(bounds("OP-9", "todo", after("OP-1")).unwrap(), "A|M");
        assert_eq!(bounds("OP-9", "todo", after("OP-3")).unwrap(), "Z|-");
        assert_eq!(bounds("OP-9", "review", Placement::default()).unwrap(), "-|-");
        // the moving card is ignored: after OP-3 with OP-1 moving leaves M and Z
        assert_eq!(bounds("OP-1", "todo", Placement::default()).unwrap(), "Z|-");
        assert_eq!(bounds("OP-1", "todo", before("OP-2")).unwrap(), "-|M");
    }

    #[test]
    fn rank_for_placement_settles_for_after_the_upper_neighbour_when_ranks_collide() {
        let cards = vec![card("OP-1"), card("OP-2")]; // both rank "V"
        let config = BoardConfig::default();
        let placement = Placement { before: Some("OP-2".into()), after: None };
        let out = rank_for_placement_with(&cards, &config, "OP-9", "todo", &placement, |lo, hi| {
            Ok(format!("{}|{}", lo.unwrap_or("-"), hi.unwrap_or("-")))
        });
        assert_eq!(out.unwrap(), "V|-");
    }

    #[test]
    fn rank_for_placement_names_an_anchor_that_is_not_in_the_column() {
        let mut other = card("OP-2");
        other.status = "doing".into();
        let cards = vec![card("OP-1"), other];
        let config = BoardConfig::default();
        let go = |placement: Placement| {
            rank_for_placement_with(&cards, &config, "OP-3", "todo", &placement, |_, _| Ok(String::new()))
                .unwrap_err()
                .to_string()
        };
        assert_eq!(go(Placement { before: Some("OP-2".into()), after: None }), "Card OP-2 is not in column \"todo\"");
        assert_eq!(go(Placement { after: Some("OP-9".into()), before: None }), "Card OP-9 is not in column \"todo\"");
    }

    #[test]
    fn rank_for_placement_ignores_empty_anchors_like_javascript_falsy_strings() {
        let cards = vec![card("OP-1")];
        let config = BoardConfig::default();
        let placement = Placement { before: Some(String::new()), after: Some(String::new()) };
        let out = rank_for_placement_with(&cards, &config, "OP-9", "todo", &placement, |lo, hi| {
            Ok(format!("{}|{}", lo.unwrap_or("-"), hi.unwrap_or("-")))
        });
        assert_eq!(out.unwrap(), "V|-");
    }

    #[test]
    fn a_board_with_no_columns_does_not_panic() {
        let config = BoardConfig { columns: vec![], ..BoardConfig::default() };
        let cards = vec![card("OP-1"), card("OP-2")];
        assert_eq!(sort_cards(&cards, &config).len(), 2);
        assert!(group_by_column(&cards, &config).is_empty());
        let f = CardFilter { status: vec!["todo".into()], ..CardFilter::default() };
        assert!(filter_cards(&cards, &f, &config).is_empty());
    }
}
