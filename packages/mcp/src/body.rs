//! A note's body: the card's description followed, optionally, by a comments section. A port of
//! `packages/core/src/body.ts`, to the byte.
//!
//! ```text
//! Description text…
//!
//! ## Comments
//!
//! > [!comment|k3f9a,2026-10-14T17:02:00.000Z] Ana · 2026-10-14 14:02
//! > First line of the comment
//! > - markdown works
//! ```
//!
//! Each comment is an Obsidian callout, so it renders as a box in the note itself. The part after `|` carries the
//! machine data (id, ISO timestamp); the title is what people read. Everything is parsed leniently, because notes get
//! edited by hand: a hand-written callout without metadata still counts (its id is derived from its text), and
//! anything else inside the section is left untouched.
//!
//! The TypeScript uses regular expressions; here each one is a small function with the same meaning, JavaScript's
//! quirks included (`.` does not match `\r`, U+2028 or U+2029, so a header line containing one is not a header).
//!
//! Two things differ from the TypeScript on purpose, both about time. The title shows the comment's time in *local*
//! time, which Rust's standard library cannot know, so the formatting functions take the UTC offset to show, in
//! minutes (pass `0` for UTC). And a timestamp is only understood in ISO-8601 form (see [`crate::jscompat`]).
use crate::jscompat::{is_js_whitespace, iso_string, js_trim, js_trim_end, parse_iso_millis, wall_clock};
use crate::types::Comment;

pub const COMMENTS_HEADING: &str = "## Comments";
const TITLE_SEPARATOR: &str = " · ";

fn strip_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// `/^##[ \t]+comments\s*$/i`
fn is_comments_heading(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("##") else { return false };
    let after_blanks = rest.trim_start_matches([' ', '\t']);
    if after_blanks.len() == rest.len() {
        return false; // at least one space or tab is required
    }
    let Some(word) = after_blanks.get(..8) else { return false };
    word.eq_ignore_ascii_case("comments") && after_blanks[8..].chars().all(is_js_whitespace)
}

/// `/^\s*(`{3,}|~{3,})/`: the character of a code fence line, or `None`.
fn fence_mark(line: &str) -> Option<char> {
    let trimmed = line.trim_start_matches(is_js_whitespace);
    let mut chars = trimmed.chars();
    let first = chars.next().filter(|c| *c == '`' || *c == '~')?;
    (chars.next() == Some(first) && chars.next() == Some(first)).then_some(first)
}

/// Index of the comments heading, ignoring code fences.
fn heading_index(lines: &[&str]) -> Option<usize> {
    let mut fence: Option<char> = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some(mark) = fence_mark(line) {
            match fence {
                None => fence = Some(mark),
                Some(open) if open == mark => fence = None,
                Some(_) => {}
            }
            continue;
        }
        if fence.is_none() && is_comments_heading(line) {
            return Some(i);
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitBody {
    /// Everything before the comments heading.
    pub description: String,
    /// From the heading line to the end of the note, or `None` when there is no comments section.
    pub section: Option<String>,
}

pub fn split_body(body: &str) -> SplitBody {
    let lines: Vec<&str> = body.split('\n').collect();
    match heading_index(&lines) {
        None => SplitBody { description: body.to_string(), section: None },
        Some(i) => SplitBody { description: lines[..i].join("\n"), section: Some(lines[i..].join("\n")) },
    }
}

/// The inverse of [`split_body`]: exactly one blank line between the description and the comments section.
/// An absent or empty section gives the description back untouched.
pub fn join_body(description: &str, section: Option<&str>) -> String {
    match section {
        None | Some("") => description.to_string(),
        Some(section) => {
            let head = js_trim_end(description);
            if head.is_empty() { format!("\n{section}") } else { format!("{head}\n\n{section}") }
        }
    }
}

/// The FNV-1a hash of the UTF-16 code units, in base 36: the id of a comment that has none.
fn fnv(text: &str) -> String {
    let mut hash: u32 = 2_166_136_261;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    to_base36(hash)
}

fn to_base36(mut n: u32) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(char::from_digit(n % 36, 36).expect("a digit below 36"));
        n /= 36;
    }
    digits.iter().rev().collect()
}

/// `/^>[ \t]*\[!comment(?:\|([^\]]*))?\][ \t]*(.*)$/i` on a line without its `\r`: `(metadata, title)`.
fn parse_callout_head(line: &str) -> Option<(Option<&str>, &str)> {
    let rest = line.strip_prefix('>')?.trim_start_matches([' ', '\t']);
    let word = rest.get(..9)?;
    if !word.eq_ignore_ascii_case("[!comment") {
        return None;
    }
    let mut rest = &rest[9..];
    let mut meta = None;
    if let Some(after_bar) = rest.strip_prefix('|') {
        let close = after_bar.find(']')?;
        meta = Some(&after_bar[..close]);
        rest = &after_bar[close..];
    }
    let title = rest.strip_prefix(']')?.trim_start_matches([' ', '\t']);
    // `.*$` cannot cross a line terminator, so one in the title means this is not a header at all.
    (!title.contains(['\r', '\n', '\u{2028}', '\u{2029}'])).then_some((meta, title))
}

fn is_callout_head(line: &str) -> bool {
    parse_callout_head(strip_cr(line)).is_some()
}

/// One comment as found in the note: where its lines are, and what it says.
struct Block {
    /// The first line (`> [!comment…]`) and one past the last line, as indexes into the body's lines.
    start: usize,
    end: usize,
    comment: Comment,
}

fn find_blocks(lines: &[&str], from: usize) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut i = from;
    while i < lines.len() {
        let Some((meta, title)) = parse_callout_head(strip_cr(lines[i])) else {
            i += 1;
            continue;
        };
        let mut end = i + 1;
        // A callout continues while lines keep starting with ">"; a new `[!comment]` line starts the next one.
        while end < lines.len() && lines[end].starts_with('>') && !is_callout_head(lines[end]) {
            end += 1;
        }
        let text = js_trim_end(
            &lines[i + 1..end]
                .iter()
                .map(|l| {
                    let line = strip_cr(l);
                    let line = line.strip_prefix('>').map_or(line, |r| r.strip_prefix(' ').unwrap_or(r));
                    unescape_marker(line)
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .to_string();
        let mut fields = meta.unwrap_or("").split(',').map(js_trim);
        let (id_part, at_part) = (fields.next().unwrap_or(""), fields.next().unwrap_or(""));
        let title = js_trim(title);
        let author = js_trim(title.split(TITLE_SEPARATOR).next().unwrap_or(""));
        blocks.push(Block {
            start: i,
            end,
            comment: Comment {
                id: if id_part.is_empty() {
                    format!("h{}", fnv(&lines[i..end].join("\n")))
                } else {
                    id_part.to_string()
                },
                author: if author.is_empty() { "Unknown".to_string() } else { author.to_string() },
                at: parse_iso_millis(at_part).and_then(iso_string).unwrap_or_default(),
                text,
            },
        });
        i = end;
    }
    blocks
}

/// The comments in the note's body, oldest first (document order).
pub fn parse_comments(body: &str) -> Vec<Comment> {
    let lines: Vec<&str> = body.split('\n').collect();
    heading_index(&lines).map_or_else(Vec::new, |h| find_blocks(&lines, h + 1).into_iter().map(|b| b.comment).collect())
}

/// `YYYY-MM-DD HH:mm` of `at` shifted by `offset_minutes` (what appears in the callout title), or empty when `at` is
/// not a timestamp. The year is not padded, like `Date#getFullYear`.
fn stamp(at: &str, offset_minutes: i32) -> String {
    match parse_iso_millis(at) {
        Some(ms) => {
            let (y, mo, d, h, mi) = wall_clock(ms, offset_minutes);
            format!("{y}-{mo:02}-{d:02} {h:02}:{mi:02}")
        }
        None => String::new(),
    }
}

/// Line breaks, brackets and the title separator would break the callout header, so they go from an author's name.
pub fn clean_author(author: &str) -> String {
    // 1. runs of line breaks become one space
    let mut s = String::with_capacity(author.len());
    let mut in_breaks = false;
    for c in author.chars() {
        if c == '\r' || c == '\n' {
            if !in_breaks {
                s.push(' ');
            }
            in_breaks = true;
        } else {
            in_breaks = false;
            s.push(c);
        }
    }
    // 2. brackets go
    s.retain(|c| c != '[' && c != ']');
    // 3. `\s*·\s*` becomes one space
    let chars: Vec<char> = s.chars().collect();
    let mut separated = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let mut j = i;
        while j < chars.len() && is_js_whitespace(chars[j]) {
            j += 1;
        }
        if chars.get(j) == Some(&'·') {
            j += 1;
            while j < chars.len() && is_js_whitespace(chars[j]) {
                j += 1;
            }
            separated.push(' ');
            i = j;
        } else {
            separated.push(chars[i]);
            i += 1;
        }
    }
    // 4. runs of whitespace become one space, 5. trim
    let mut collapsed = String::with_capacity(separated.len());
    let mut in_space = false;
    for c in separated.chars() {
        if is_js_whitespace(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            in_space = false;
            collapsed.push(c);
        }
    }
    js_trim(&collapsed).to_string()
}

// A text line that itself starts with `[!comment…]` would be taken for the header of another comment (and invent
// one). It is written with one extra backslash before the `[`, which Markdown renders identically, and read back
// without it. Counting the backslashes keeps the round trip exact for text that already had some.

/// The position just past `^[ \t]*\\*` when the rest starts with `[!comment` (case-insensitive).
fn marker_after_backslashes(line: &str) -> Option<(usize, usize)> {
    let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
    let backslashes = line[indent..].len() - line[indent..].trim_start_matches('\\').len();
    let marker = &line[indent + backslashes..];
    marker.get(..9).filter(|m| m.eq_ignore_ascii_case("[!comment")).map(|_| (indent, backslashes))
}

fn escape_marker(line: &str) -> String {
    match marker_after_backslashes(line) {
        Some((indent, backslashes)) => {
            let at = indent + backslashes;
            format!("{}\\{}", &line[..at], &line[at..])
        }
        None => line.to_string(),
    }
}

fn unescape_marker(line: &str) -> String {
    match marker_after_backslashes(line) {
        Some((indent, backslashes)) if backslashes > 0 => {
            // remove one backslash, the first one
            format!("{}{}", &line[..indent], &line[indent + 1..])
        }
        _ => line.to_string(),
    }
}

/// The text lines of a comment as callout continuation lines (`> text`; a blank line is just `>`).
fn quote(text: &str) -> Vec<String> {
    let text = text.replace("\r\n", "\n");
    js_trim_end(&text)
        .split('\n')
        .map(|line| if js_trim(line).is_empty() { ">".to_string() } else { format!("> {}", escape_marker(line)) })
        .collect()
}

/// The callout block for one comment (no trailing newline). `utc_offset_minutes` is the offset shown in the title.
pub fn format_comment(c: &Comment, utc_offset_minutes: i32) -> String {
    let when = stamp(&c.at, utc_offset_minutes);
    let author = clean_author(&c.author);
    let author = if author.is_empty() { "Unknown" } else { &author };
    let title = if when.is_empty() { author.to_string() } else { format!("{author}{TITLE_SEPARATOR}{when}") };
    let mut lines = vec![format!("> [!comment|{},{}] {title}", c.id, c.at)];
    lines.extend(quote(&c.text));
    lines.join("\n")
}

/// The whole section (heading and blocks) for some comments, with a trailing newline.
pub fn format_section(comments: &[Comment], utc_offset_minutes: i32) -> String {
    let blocks: Vec<String> = comments.iter().map(|c| format_comment(c, utc_offset_minutes)).collect();
    format!("{COMMENTS_HEADING}\n\n{}\n", blocks.join("\n\n"))
}

/// Appends a comment, creating the section when needed. Anything already in the section is kept.
pub fn add_comment_to_body(body: &str, comment: &Comment, utc_offset_minutes: i32) -> String {
    let SplitBody { description, section } = split_body(body);
    let block = format_comment(comment, utc_offset_minutes);
    match section {
        None => join_body(&description, Some(&format!("{COMMENTS_HEADING}\n\n{block}\n"))),
        Some(section) => join_body(&description, Some(&format!("{}\n\n{block}\n", js_trim_end(&section)))),
    }
}

fn block_by_id(lines: &[&str], id: &str) -> Option<(usize, Block)> {
    let h = heading_index(lines)?;
    find_blocks(lines, h + 1).into_iter().find(|b| b.comment.id == id).map(|b| (h, b))
}

/// Replaces a comment's text, keeping its header (author, id, time). `None` when `id` is unknown.
pub fn edit_comment_in_body(body: &str, id: &str, text: &str) -> Option<String> {
    let lines: Vec<&str> = body.split('\n').collect();
    let (_, block) = block_by_id(&lines, id)?;
    let mut out: Vec<String> = lines[..=block.start].iter().map(ToString::to_string).collect();
    out.extend(quote(text));
    out.extend(lines[block.end..].iter().map(ToString::to_string));
    Some(out.join("\n"))
}

/// Removes a comment, and the whole section when nothing but the heading would remain. `None` when `id` is unknown.
pub fn remove_comment_from_body(body: &str, id: &str) -> Option<String> {
    let lines: Vec<&str> = body.split('\n').collect();
    let (h, block) = block_by_id(&lines, id)?;
    let mut start = block.start;
    // Also take the blank line that separated it from the previous block.
    if start > 0
        && js_trim(lines[start - 1]).is_empty()
        && (block.end >= lines.len() || js_trim(lines[block.end]).is_empty())
    {
        start -= 1;
    }
    let mut kept: Vec<&str> = lines[..start].to_vec();
    kept.extend_from_slice(&lines[block.end..]);
    if kept[h + 1..].iter().all(|l| js_trim(l).is_empty()) {
        let description = kept[..h].join("\n");
        return Some(if js_trim(&description).is_empty() {
            String::new()
        } else {
            format!("{}\n", js_trim_end(&description))
        });
    }
    Some(kept.join("\n"))
}

/// Where `/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)(\](?:\s|$))/` finds its status character: the byte range of
/// the `(.)` in `line`. A task line is `- [ ] x`, also inside a quote or callout and with `*`, `+`, `1.` or `1)`.
fn task_status_range(line: &str) -> Option<std::ops::Range<usize>> {
    let mut rest = line.trim_start_matches(is_js_whitespace);
    while let Some(after) = rest.strip_prefix('>') {
        rest = after.trim_start_matches(is_js_whitespace);
    }
    // the list marker
    let mut chars = rest.chars();
    let marker_len = match chars.next()? {
        '-' | '*' | '+' => 1,
        c if c.is_ascii_digit() => {
            let digits = rest.len() - rest.trim_start_matches(|d: char| d.is_ascii_digit()).len();
            matches!(rest[digits..].chars().next(), Some('.' | ')')).then_some(digits + 1)?
        }
        _ => return None,
    };
    let after_marker = &rest[marker_len..];
    let after_blanks = after_marker.trim_start_matches(is_js_whitespace);
    if after_blanks.len() == after_marker.len() {
        return None; // `\s+` needs at least one whitespace character
    }
    let after_bracket = after_blanks.strip_prefix('[')?;
    // `.` is one UTF-16 code unit that is not a line terminator, so an astral character cannot be the status.
    let status = after_bracket
        .chars()
        .next()
        .filter(|c| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') && c.len_utf16() == 1)?;
    let after_status = &after_bracket[status.len_utf8()..];
    let closing = after_status.strip_prefix(']')?;
    if !(closing.is_empty() || closing.chars().next().is_some_and(is_js_whitespace)) {
        return None;
    }
    let start = line.len() - after_bracket.len();
    Some(start..start + status.len_utf8())
}

/// Flips the `index`-th task (`- [ ]` and `- [x]`) of some Markdown, counting the checkboxes a renderer draws (document
/// order, none inside code fences). `None` when there is no such task. Clicking a rendered checkbox uses it to write
/// the change back to the text.
pub fn toggle_task(markdown: &str, index: usize) -> Option<String> {
    let mut lines: Vec<String> = markdown.split('\n').map(ToString::to_string).collect();
    let mut fence: Option<char> = None;
    let mut seen = 0;
    for line in &mut lines {
        if let Some(mark) = fence_mark(line) {
            match fence {
                None => fence = Some(mark),
                Some(open) if open == mark => fence = None,
                Some(_) => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let Some(range) = task_status_range(line) else { continue };
        if seen != index {
            seen += 1;
            continue;
        }
        let flipped = if &line[range.clone()] == " " { "x" } else { " " };
        line.replace_range(range, flipped);
        return Some(lines.join("\n"));
    }
    None
}
