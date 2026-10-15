//! A note's YAML frontmatter: reading it and, above all, changing it without disturbing anything else. A port of
//! `packages/core/src/frontmatter.ts`.
//!
//! # Reading
//!
//! [`parse_frontmatter`] reads YAML 1.2 with the *core schema*, like the `yaml` package the TypeScript uses: `yes` and
//! `no` are strings, `0x1f` and `0o17` are numbers, `1e3` is a float, `~` and `null` are null, and an unquoted date such
//! as `2026-10-14` stays a string. The parsing itself is done by `saphyr-parser` (small, and a complete YAML 1.2 parser);
//! this module turns its events into values and keeps the position of every top-level key. Where the parser and `yaml`
//! disagree the notes people actually write win:
//!
//! - `key:<tab>value` is valid YAML that the parser refuses; each such tab is read as a space;
//! - a tab in the indentation of a top-level key, an alias to nothing, a duplicate key and more than one document are
//!   errors, as in `yaml`, and an error reads as no frontmatter;
//! - a null key is named `""`, and explicit `!!binary`, `!!set`, `!!omap`, `!!pairs` and `!!timestamp` values (which `yaml`
//!   turns into a Buffer, a Set, a Map, a Date) read as empty objects: none is ever a string, number or boolean.
//!
//! # Writing
//!
//! No Rust library round-trips YAML comments, so [`patch_frontmatter`] edits the *text*: each top-level `key:` owns the
//! lines from the comments right above it to the line before the next key (minus the blank and comment lines that
//! trail it, which belong to nobody). A patched key has its lines replaced, a removed key its lines (and its comments)
//! dropped, a new key is appended after the last one, and **every other byte is left alone**: user comments, keys the
//! plugin does not know, key order, odd spacing, block scalars, indentation. The fences are rewritten (`---` plus the
//! note's line break) and a BOM is dropped, as in the TypeScript.
//!
//! Values are written the way the `yaml` package writes them, for the values cards actually hold: a string stays plain
//! unless YAML needs quoting (then double quotes, or single quotes when the text has `"` and no `'`), numbers and
//! booleans are plain, a list is written in flow style (`labels: [ a, b ]`). A value that replaces a quoted one keeps its
//! quote style, and a comment at the end of the replaced line (or on the header of a block scalar or list) survives.
//! Where the TypeScript does something that cannot be reproduced cheaply the text differs but the meaning does not:
//!
//! - strings that contain a line break are written double-quoted with `\n` escapes (the TypeScript uses a `|` block);
//! - text over 80 columns is not folded over several lines, and maps are written in flow style;
//! - strings with exotic whitespace or control characters are quoted and escaped, never written raw;
//! - a replaced value does not keep its tag (`!!str`) or anchor (`&x`);
//! - removing the key that follows an untouched block scalar (`|`, `>`) also removes the blank and comment lines after
//!   it, which the scalar would otherwise take as its own text;
//! - a note that uses CRLF keeps it, fences included (the TypeScript rewrites the whole block with LF).
//!
//! Two safety nets sit under the line editor. The result is read back and compared with what was asked for (the old
//! values with the patch applied): if it differs, as when a replaced anchor would leave an alias dangling, the document
//! is rewritten from its *values* instead, which loses its comments and layout but nothing else, and failing that
//! nothing is written. A mapping in flow style (`{a: 1}`) or a document with bare CR line breaks skips straight to the
//! rewrite.
use crate::error::{Error, Result};
use crate::jscompat::number_to_js_string;
use saphyr_parser::{Event, Parser, ScalarStyle, Span, Tag};
use serde_json::{Map, Number, Value};

/// The result of [`split_frontmatter`]: the raw YAML between the `---` fences and everything after the closing one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Split<'a> {
    /// `None` when the note has no frontmatter.
    pub yaml: Option<&'a str>,
    pub body: &'a str,
}

/// `---`, spaces and tabs, then a line break: the byte length of an opening/closing fence line, or `None`.
fn fence_line_len(text: &str) -> Option<usize> {
    let rest = text.strip_prefix("---")?;
    let blanks = rest.len() - rest.trim_start_matches([' ', '\t']).len();
    let after = &rest[blanks..];
    let newline = if after.starts_with("\r\n") {
        2
    } else if after.starts_with('\n') {
        1
    } else {
        return None;
    };
    Some(3 + blanks + newline)
}

/// Like [`fence_line_len`] but the closing fence may also end the text.
fn closing_fence_len(text: &str) -> Option<usize> {
    if let Some(n) = fence_line_len(text) {
        return Some(n);
    }
    let rest = text.strip_prefix("---")?;
    rest.trim_start_matches([' ', '\t']).is_empty().then_some(text.len())
}

/// Splits a note into its frontmatter and body: `/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/`, then the
/// empty block `---` / `---`. A leading BOM is skipped. The closing fence is the first one: a later `---` in the body
/// is a horizontal rule.
pub fn split_frontmatter(content: &str) -> Split<'_> {
    let text = content.strip_prefix('\u{feff}').unwrap_or(content);
    if let Some(opening) = fence_line_len(text) {
        let bytes = text.as_bytes();
        // The first line break at or after `opening` that is followed by a closing fence ends the YAML.
        let mut at = opening;
        while let Some(found) = text[at..].find('\n') {
            let newline = at + found;
            let start = if newline > opening && bytes[newline - 1] == b'\r' { newline - 1 } else { newline };
            if let Some(len) = closing_fence_len(&text[newline + 1..]) {
                return Split { yaml: Some(&text[opening..start]), body: &text[newline + 1 + len..] };
            }
            at = newline + 1;
        }
        // `---` immediately followed by the closing `---`: an empty block.
        if let Some(len) = closing_fence_len(&text[opening..]) {
            return Split { yaml: Some(""), body: &text[opening + len..] };
        }
    }
    Split { yaml: None, body: text }
}

// --- reading ------------------------------------------------------------------------------------------------------

/// A YAML value after the core schema has decided what each scalar is.
#[derive(Debug, Clone, PartialEq)]
enum Node {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Seq(Vec<Node>),
    Map(Vec<(Node, Node)>),
}

/// How a top-level value was written, which decides what survives when it is replaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Style {
    Plain,
    Single,
    Double,
    Literal,
    Folded,
    /// A flow collection (`[a, b]`, `{a: 1}`).
    Flow,
    /// A block collection (a list or map on the following lines).
    Block,
    Alias,
}

/// One top-level `key: value` of a block mapping, with where it sits in the text (byte offsets).
#[derive(Debug, Clone)]
struct Pair {
    /// The key's text, for a key that is a string (`None` for numbers, booleans, null and collections).
    key: Option<String>,
    key_start: usize,
    key_end: usize,
    style: Style,
    value_end: usize,
}

struct Doc {
    /// `None` for an empty document (nothing but whitespace and comments).
    root: Option<Node>,
    /// The top-level pairs when the root is a *block* mapping.
    pairs: Vec<Pair>,
    /// The root is a mapping written in flow style (`{a: 1}`).
    root_is_flow_map: bool,
}

/// Char index (what the parser reports) to byte offset.
struct Offsets<'a> {
    text: &'a str,
    table: Option<Vec<usize>>,
}

impl<'a> Offsets<'a> {
    fn new(text: &'a str) -> Self {
        let table = (!text.is_ascii()).then(|| text.char_indices().map(|(b, _)| b).chain([text.len()]).collect());
        Self { text, table }
    }

    fn byte(&self, char_index: usize) -> usize {
        match &self.table {
            None => char_index.min(self.text.len()),
            Some(t) => t.get(char_index).copied().unwrap_or(self.text.len()),
        }
    }
}

fn is_core_tag(tag: &Tag, suffix: &str) -> bool {
    tag.handle == "tag:yaml.org,2002:" && tag.suffix == suffix || tag.handle == "!!" && tag.suffix == suffix
}

/// What a scalar is under the core schema: `null`, booleans, decimal/octal/hex integers, floats, `.inf`/`.nan`, else text.
fn resolve_plain(text: &str) -> Node {
    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Node::Null,
        "true" | "True" | "TRUE" => return Node::Bool(true),
        "false" | "False" | "FALSE" => return Node::Bool(false),
        ".nan" | ".NaN" | ".NAN" => return Node::Num(f64::NAN),
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => return Node::Num(f64::INFINITY),
        "-.inf" | "-.Inf" | "-.INF" => return Node::Num(f64::NEG_INFINITY),
        _ => {}
    }
    let digits = |s: &str, radix: u32| !s.is_empty() && s.chars().all(|c| c.is_digit(radix));
    let from_radix = |s: &str, radix: u32| {
        s.chars().fold(0.0f64, |acc, c| acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0)))
    };
    if let Some(rest) = text.strip_prefix("0o").filter(|r| digits(r, 8)) {
        return Node::Num(from_radix(rest, 8));
    }
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    if digits(unsigned, 10) {
        return Node::Num(text.parse::<f64>().unwrap_or(f64::NAN));
    }
    if let Some(rest) = text.strip_prefix("0x").filter(|r| digits(r, 16)) {
        return Node::Num(from_radix(rest, 16));
    }
    // floats: `[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`, where without an exponent the dot is required
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(i) => (&unsigned[..i], Some(&unsigned[i + 1..])),
        None => (unsigned, None),
    };
    let (whole, frac) = match mantissa.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (mantissa, None),
    };
    let mantissa_ok = match frac {
        Some(f) => (digits(whole, 10) && f.chars().all(|c| c.is_ascii_digit())) || (whole.is_empty() && digits(f, 10)),
        None => exponent.is_some() && digits(whole, 10),
    };
    let exponent_ok = exponent.is_none_or(|e| {
        let d = e.strip_prefix(['-', '+']).unwrap_or(e);
        digits(d, 10)
    });
    if mantissa_ok
        && exponent_ok
        && let Ok(x) = text.parse::<f64>()
    {
        return Node::Num(x);
    }
    Node::Str(text.to_string())
}

/// The tags `yaml` resolves when they are written explicitly although the core schema does not define them: `!!binary`
/// (a Buffer), `!!set` and `!!omap` (a Set and a Map), `!!pairs`, `!!timestamp` (a Date). None is a string, number or
/// boolean in JavaScript, so none can be a card field; they read as an empty object here.
fn is_exotic_tag(tag: Option<&Tag>) -> bool {
    tag.is_some_and(|t| ["binary", "omap", "pairs", "set", "timestamp"].iter().any(|s| is_core_tag(t, s)))
}

fn resolve_scalar(text: &str, style: ScalarStyle, tag: Option<&Tag>) -> Node {
    if is_exotic_tag(tag) {
        return Node::Map(Vec::new());
    }
    if let Some(tag) = tag {
        // Only the core tags change what a scalar is; any other tag leaves it a string, like the `yaml` package.
        if is_core_tag(tag, "str") {
            return Node::Str(text.to_string());
        }
        for suffix in ["null", "bool", "int", "float"] {
            if is_core_tag(tag, suffix) {
                return match resolve_plain(text) {
                    node @ (Node::Null | Node::Bool(_) | Node::Num(_)) => node,
                    _ => Node::Str(text.to_string()),
                };
            }
        }
        return Node::Str(text.to_string());
    }
    match style {
        ScalarStyle::Plain => resolve_plain(text),
        _ => Node::Str(text.to_string()),
    }
}

/// The key JavaScript's `Object` would get for a mapping key node (`String(key)`).
fn js_key(node: &Node) -> String {
    match node {
        // `yaml` names a null key "" (its `stringifyKey` special-cases null), unlike `String(null)`.
        Node::Null => String::new(),
        Node::Bool(b) => b.to_string(),
        Node::Num(n) => number_to_js_string(*n),
        Node::Str(s) => s.clone(),
        Node::Seq(items) => {
            items.iter().map(|n| if *n == Node::Null { String::new() } else { js_key(n) }).collect::<Vec<_>>().join(",")
        }
        Node::Map(_) => "[object Object]".into(),
    }
}

/// Whether two mapping keys count as the same key (`yaml`'s uniqueness rule: same scalar type and value).
fn same_key(a: &Node, b: &Node) -> bool {
    match (a, b) {
        (Node::Null, Node::Null) => true,
        (Node::Bool(x), Node::Bool(y)) => x == y,
        (Node::Num(x), Node::Num(y)) => x == y,
        (Node::Str(x), Node::Str(y)) => x == y,
        _ => false,
    }
}

enum Frame {
    Seq {
        anchor: usize,
        items: Vec<Node>,
        start: Span,
        exotic: bool,
    },
    Map {
        anchor: usize,
        entries: Vec<(Node, Node)>,
        key: Option<Node>,
        root: bool,
        flow: bool,
        start: Span,
        pending: Option<(usize, usize, Option<String>)>,
        exotic: bool,
    },
}

const MAX_ALIASES: usize = 100;

/// More than this many `key:<tab>value` lines in one note and the note is read as having no frontmatter.
const MAX_TAB_FIXES: usize = 256;

/// Why [`load_once`] failed.
struct LoadError {
    message: String,
    /// Set when the parser refused a tab right after a `:` (valid YAML, which the parser is stricter about): the char
    /// index just past the tabs.
    tab_after_colon: Option<usize>,
}

impl From<String> for LoadError {
    fn from(message: String) -> Self {
        Self { message, tab_after_colon: None }
    }
}

impl From<&str> for LoadError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

/// `text` with the tabs that end just before the char index `end` turned into spaces; `None` when there are none. The
/// text keeps its length, so every offset stays valid.
fn blank_tabs_before(text: &str, end: usize) -> Option<String> {
    let end = Offsets::new(text).byte(end);
    let start = text[..end].trim_end_matches('\t').len();
    (start < end).then(|| format!("{}{}{}", &text[..start], " ".repeat(end - start), &text[end..]))
}

/// The byte offset just past the closing quote of the quoted scalar that opens at `start`. The parser's own end mark
/// runs on over the blanks and the comment that follow the scalar.
fn quoted_end(text: &str, start: usize, double: bool) -> Option<usize> {
    let quote = if double { '"' } else { '\'' };
    let mut chars = text.get(start..)?.char_indices();
    let (_, first) = chars.next()?;
    if first != quote {
        return None;
    }
    let mut next = chars.next();
    while let Some((at, c)) = next {
        if double && c == '\\' {
            chars.next(); // the escaped character
        } else if c == quote {
            if !double && let Some((_, '\'')) = chars.clone().next() {
                chars.next(); // '' is an apostrophe
            } else {
                return Some(start + at + c.len_utf8());
            }
        }
        next = chars.next();
    }
    None
}

/// Loads YAML text. Anything the `yaml` package reports as an error is an error here: a syntax error, duplicate keys in
/// a mapping, an alias to nothing, more than one document, a tab in the indentation of a top-level key.
///
/// The parser refuses `key:<tab>value` (a tab as the only separator after a colon), which YAML allows and `yaml`
/// reads. Each time it does, that run of tabs becomes spaces (same length, so no offset moves) and the text is read again.
fn load(text: &str) -> std::result::Result<Doc, String> {
    let mut fixed: Option<String> = None;
    for _ in 0..=MAX_TAB_FIXES {
        let current = fixed.as_deref().unwrap_or(text);
        match load_once(current) {
            Ok(doc) => return Ok(doc),
            Err(LoadError { tab_after_colon: Some(end), message }) => match blank_tabs_before(current, end) {
                Some(next) => fixed = Some(next),
                None => return Err(message),
            },
            Err(e) => return Err(e.message),
        }
    }
    Err("too many tabs after colons".into())
}

fn load_once(text: &str) -> std::result::Result<Doc, LoadError> {
    let offsets = Offsets::new(text);
    let mut parser = Parser::new_from_str(text);
    let mut stack: Vec<Frame> = Vec::new();
    let mut anchors: std::collections::HashMap<usize, Node> = std::collections::HashMap::new();
    let mut aliases = 0usize;
    let mut documents = 0usize;
    let mut doc = Doc { root: None, pairs: Vec::new(), root_is_flow_map: false };

    // Hands a finished node to its parent (or makes it the document root).
    let complete = |stack: &mut Vec<Frame>,
                    doc: &mut Doc,
                    node: Node,
                    (start, end): (usize, usize),
                    style: Style|
     -> std::result::Result<(), LoadError> {
        let (start, end) = (offsets.byte(start), offsets.byte(end));
        let end = match style {
            Style::Single | Style::Double => quoted_end(text, start, style == Style::Double).unwrap_or(end),
            _ => end,
        };
        match stack.last_mut() {
            None => {
                doc.root = Some(node);
                Ok(())
            }
            Some(Frame::Seq { items, .. }) => {
                items.push(node);
                Ok(())
            }
            Some(Frame::Map { entries, key, root, pending, .. }) => match key.take() {
                None => {
                    let name = if let Node::Str(text) = &node { Some(text.clone()) } else { None };
                    *pending = Some((start, end, name));
                    *key = Some(node);
                    Ok(())
                }
                Some(k) => {
                    if entries.iter().any(|(existing, _)| same_key(existing, &k)) {
                        return Err("Map keys must be unique".into());
                    }
                    if *root {
                        let (key_start, key_end, name) = pending.take().unwrap_or((start, start, None));
                        doc.pairs.push(Pair { key: name, key_start, key_end, style, value_end: end });
                    }
                    entries.push((k, node));
                    Ok(())
                }
            },
        }
    };

    while let Some(next) = parser.next_event() {
        let (event, span) = next.map_err(|e| LoadError {
            message: e.to_string(),
            tab_after_colon: e
                .info()
                .starts_with("':' must be followed by a valid YAML whitespace")
                .then(|| e.marker().index()),
        })?;
        match event {
            Event::Nothing | Event::StreamStart | Event::DocumentEnd => {}
            Event::StreamEnd => break,
            Event::DocumentStart(_) => {
                documents += 1;
                if documents > 1 {
                    return Err("Source contains multiple documents".into());
                }
            }
            Event::Alias(id) => {
                aliases += 1;
                if aliases > MAX_ALIASES {
                    return Err("Excessive alias count indicates a resource exhaustion attack".into());
                }
                let node =
                    anchors.get(&id).cloned().ok_or("Unresolved alias (the anchor must be set before the alias)")?;
                complete(&mut stack, &mut doc, node, (span.start.index(), span.end.index()), Style::Alias)?;
            }
            Event::Scalar(value, style, anchor, tag) => {
                let node = resolve_scalar(&value, style, tag.as_deref());
                if anchor != 0 {
                    anchors.insert(anchor, node.clone());
                }
                let how = match style {
                    ScalarStyle::Plain => Style::Plain,
                    ScalarStyle::SingleQuoted => Style::Single,
                    ScalarStyle::DoubleQuoted => Style::Double,
                    ScalarStyle::Literal => Style::Literal,
                    ScalarStyle::Folded => Style::Folded,
                };
                complete(&mut stack, &mut doc, node, (span.start.index(), span.end.index()), how)?;
            }
            Event::SequenceStart(anchor, tag) => {
                let exotic = is_exotic_tag(tag.as_deref());
                stack.push(Frame::Seq { anchor, items: Vec::new(), start: span, exotic });
            }
            Event::MappingStart(anchor, tag) => {
                let root = stack.is_empty();
                let flow = span.start.index() != span.end.index();
                if root {
                    doc.root_is_flow_map = flow;
                }
                stack.push(Frame::Map {
                    anchor,
                    entries: Vec::new(),
                    key: None,
                    root: root && !flow,
                    flow,
                    start: span,
                    pending: None,
                    exotic: is_exotic_tag(tag.as_deref()),
                });
            }
            Event::SequenceEnd => {
                let Some(Frame::Seq { anchor, items, start, exotic }) = stack.pop() else {
                    return Err("unbalanced sequence".into());
                };
                let node = if exotic { Node::Map(Vec::new()) } else { Node::Seq(items) };
                if anchor != 0 {
                    anchors.insert(anchor, node.clone());
                }
                let flow = start.start.index() != start.end.index();
                // a flow collection ends at its bracket (the parser's end mark runs on over blanks and a comment)
                let end = if flow { span.start.index() + 1 } else { span.end.index() };
                complete(
                    &mut stack,
                    &mut doc,
                    node,
                    (start.start.index(), end),
                    if flow { Style::Flow } else { Style::Block },
                )?;
            }
            Event::MappingEnd => {
                let Some(Frame::Map { anchor, entries, start, flow, exotic, .. }) = stack.pop() else {
                    return Err("unbalanced mapping".into());
                };
                let node = Node::Map(if exotic { Vec::new() } else { entries });
                if anchor != 0 {
                    anchors.insert(anchor, node.clone());
                }
                let end = if flow { span.start.index() + 1 } else { span.end.index() };
                complete(
                    &mut stack,
                    &mut doc,
                    node,
                    (start.start.index(), end),
                    if flow { Style::Flow } else { Style::Block },
                )?;
            }
        }
    }
    // `yaml` refuses a tab in the indentation of a block mapping; the parser takes it as whitespace.
    for pair in &doc.pairs {
        let line_start = text[..pair.key_start].rfind('\n').map_or(0, |i| i + 1);
        if text[line_start..pair.key_start].contains('\t') {
            return Err("Tabs are not allowed as indentation".into());
        }
    }
    Ok(doc)
}

/// A node as a JSON value, the way `Document#toJS()` shapes it: mapping keys become strings. A number JSON cannot hold
/// (`.inf`, `.nan`) is null, which is what `JSON.stringify` makes of it, or with `js_text` the text JavaScript's
/// `String()` gives it (`"NaN"`, `"Infinity"`), for a reader that treats numbers and strings alike.
fn to_json(node: &Node, js_text: bool) -> Value {
    match node {
        Node::Null => Value::Null,
        Node::Bool(b) => Value::Bool(*b),
        Node::Num(n) => number_value(*n, js_text),
        Node::Str(s) => Value::String(s.clone()),
        Node::Seq(items) => Value::Array(items.iter().map(|n| to_json(n, js_text)).collect()),
        Node::Map(entries) => {
            let mut map = Map::new();
            for (k, v) in entries {
                map.insert(js_key(k), to_json(v, js_text));
            }
            Value::Object(map)
        }
    }
}

fn number_value(n: f64, js_text: bool) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        Value::Number(Number::from(n as i64))
    } else if let Some(number) = Number::from_f64(n) {
        Value::Number(number)
    } else if js_text {
        Value::String(number_to_js_string(n))
    } else {
        Value::Null
    }
}

fn read_object(content: &str, js_text: bool) -> Map<String, Value> {
    let Some(yaml) = split_frontmatter(content).yaml.filter(|y| !y.is_empty()) else { return Map::new() };
    match load(yaml) {
        Ok(Doc { root: Some(node @ Node::Map(_)), .. }) => match to_json(&node, js_text) {
            Value::Object(map) => map,
            _ => Map::new(),
        },
        _ => Map::new(),
    }
}

/// The frontmatter as an object; empty for no frontmatter, for invalid YAML, and for YAML that is not a mapping.
/// Numbers JSON cannot hold (`.inf`, `.nan`) are null, as in the core's JSON.
pub fn parse_frontmatter(content: &str) -> Map<String, Value> {
    read_object(content, false)
}

/// Like [`parse_frontmatter`] for code that reads fields the way the core's `asString` does: `.nan` and `.inf` are the
/// strings `"NaN"` and `"Infinity"` that `String(value)` gives in JavaScript, so a title of `.nan` reads as `NaN`.
pub fn parse_frontmatter_js(content: &str) -> Map<String, Value> {
    read_object(content, true)
}

// --- writing ------------------------------------------------------------------------------------------------------

/// A document that is empty or holds only blank lines and comments.
fn is_blank_or_comments(yaml: &str) -> bool {
    yaml.lines()
        .all(|l| l.trim_matches([' ', '\t', '\r']).is_empty() || l.trim_start_matches([' ', '\t']).starts_with('#'))
}

/// JavaScript's `Object.entries` order does not matter here, but a patch may name a key twice: the last value wins,
/// at the first position.
fn unique_patch<K: AsRef<str>>(patch: &[(K, Value)]) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = Vec::with_capacity(patch.len());
    for (key, value) in patch {
        match out.iter_mut().find(|(k, _)| k == key.as_ref()) {
            Some(slot) => slot.1 = value.clone(),
            None => out.push((key.as_ref().to_string(), value.clone())),
        }
    }
    out
}

fn node_of(value: &Value) -> Node {
    match value {
        Value::Null => Node::Null,
        Value::Bool(b) => Node::Bool(*b),
        Value::Number(n) => Node::Num(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => Node::Str(s.clone()),
        Value::Array(items) => Node::Seq(items.iter().map(node_of).collect()),
        Value::Object(map) => Node::Map(map.iter().map(|(k, v)| (Node::Str(k.clone()), node_of(v))).collect()),
    }
}

/// `Node` equality where `.nan` equals itself (an unchanged field must compare equal to its own copy).
fn same_node(a: &Node, b: &Node) -> bool {
    match (a, b) {
        (Node::Num(x), Node::Num(y)) => x == y || (x.is_nan() && y.is_nan()),
        (Node::Seq(x), Node::Seq(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_node(p, q)),
        (Node::Map(x), Node::Map(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|((k, v), (l, w))| same_node(k, l) && same_node(v, w))
        }
        _ => a == b,
    }
}

fn root_entries(doc: &Doc) -> &[(Node, Node)] {
    match &doc.root {
        Some(Node::Map(entries)) => entries,
        _ => &[],
    }
}

// Emitting values. The rules follow the `yaml` package's `stringifyString`, so that a note the TypeScript wrote and a
// note this crate wrote look the same.

/// A character that makes a string unsafe to write plain: controls, line separators, and any whitespace but a space.
fn is_exotic(c: char) -> bool {
    c.is_control() || c == '\u{feff}' || (c != ' ' && c.is_whitespace())
}

/// Whether `s` can be written as a plain (unquoted) scalar and read back as the same string.
fn plain_allowed(s: &str, flow: bool) -> bool {
    let Some(first) = s.chars().next() else { return false };
    if s.chars().any(is_exotic)
        || matches!(
            first,
            ' ' | ',' | '[' | ']' | '{' | '}' | '#' | '&' | '*' | '!' | '|' | '>' | '\'' | '"' | '%' | '@' | '`'
        )
        || s == "?"
        || s == "-"
        || s.starts_with("? ")
        || s.starts_with("- ")
        || s.contains(": ")
        || s.contains(" #")
        || s.ends_with([' ', ':'])
        || s.starts_with("---")
        || s.starts_with("...")
        || (flow && (s.contains(['[', ']', '{', '}', ',']) || s.ends_with('-')))
    {
        return false;
    }
    // `true`, `12`, `0x1f`, `~`, `.inf`: plain text that would read back as something else
    matches!(resolve_plain(s), Node::Str(_))
}

/// `"..."` with the escapes YAML defines. Everything that is not printable ASCII-safe text is escaped.
fn double_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\0' => out.push_str("\\0"),
            '\u{7}' => out.push_str("\\a"),
            '\u{b}' => out.push_str("\\v"),
            '\u{1b}' => out.push_str("\\e"),
            '\u{85}' => out.push_str("\\N"),
            '\u{a0}' => out.push_str("\\_"),
            '\u{2028}' => out.push_str("\\L"),
            '\u{2029}' => out.push_str("\\P"),
            c if c.is_control() => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if is_exotic(c) => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn single_quotable(s: &str) -> bool {
    !s.chars().any(is_exotic)
}

fn single_quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The quoted form `yaml` picks: single quotes when the text has a `"` and no `'`, double quotes otherwise.
fn quoted(s: &str) -> String {
    if single_quotable(s) && s.contains('"') && !s.contains('\'') { single_quoted(s) } else { double_quoted(s) }
}

fn emit_string(s: &str, flow: bool) -> String {
    if plain_allowed(s, flow) { s.to_string() } else { quoted(s) }
}

/// A key that replaces a scalar written in a quote style: keeps the style when it can hold the text.
fn emit_string_like(s: &str, old: Style) -> String {
    match old {
        Style::Double => double_quoted(s),
        Style::Single if single_quotable(s) => single_quoted(s),
        Style::Single => double_quoted(s),
        _ => emit_string(s, false),
    }
}

fn emit_number(n: f64) -> String {
    if n.is_nan() {
        ".nan".into()
    } else if n.is_infinite() {
        if n < 0.0 { "-.inf" } else { ".inf" }.into()
    } else {
        number_to_js_string(n)
    }
}

/// YAML refuses implicit keys longer than this.
const MAX_KEY_LEN: usize = 1024;

fn emit_key(key: &str) -> Result<String> {
    if key.chars().count() > MAX_KEY_LEN || key.contains(['\n', '\r']) {
        return Err(Error::validation(format!(
            "Cannot use {:?} as a frontmatter key: keys must be one line of at most {MAX_KEY_LEN} characters",
            key.chars().take(40).collect::<String>()
        )));
    }
    Ok(emit_string(key, false))
}

/// A value in flow style (single line): `[ a, b ]`, `{ k: v }`, scalars as `emit_string` writes them.
fn emit_value(value: &Value, flow: bool) -> Result<String> {
    Ok(match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => emit_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => emit_string(s, flow),
        Value::Array(items) if items.is_empty() => "[]".into(),
        Value::Array(items) => {
            let parts = items.iter().map(|v| emit_value(v, true)).collect::<Result<Vec<_>>>()?;
            format!("[ {} ]", parts.join(", "))
        }
        Value::Object(map) if map.is_empty() => "{}".into(),
        Value::Object(map) => {
            let parts = map
                .iter()
                .map(|(k, v)| Ok(format!("{}: {}", emit_key(k)?, emit_value(v, true)?)))
                .collect::<Result<Vec<_>>>()?;
            format!("{{ {} }}", parts.join(", "))
        }
    })
}

/// Like `emit_value` for a value read from a note (used when a whole document is rewritten).
fn emit_node(node: &Node, flow: bool) -> Result<String> {
    Ok(match node {
        Node::Null => "null".into(),
        Node::Bool(b) => b.to_string(),
        Node::Num(n) => emit_number(*n),
        Node::Str(s) => emit_string(s, flow),
        Node::Seq(items) if items.is_empty() => "[]".into(),
        Node::Seq(items) => {
            let parts = items.iter().map(|n| emit_node(n, true)).collect::<Result<Vec<_>>>()?;
            format!("[ {} ]", parts.join(", "))
        }
        Node::Map(entries) if entries.is_empty() => "{}".into(),
        Node::Map(entries) => {
            let parts = entries
                .iter()
                .map(|(k, v)| Ok(format!("{}: {}", emit_node_key(k)?, emit_node(v, true)?)))
                .collect::<Result<Vec<_>>>()?;
            format!("{{ {} }}", parts.join(", "))
        }
    })
}

fn emit_node_key(key: &Node) -> Result<String> {
    match key {
        Node::Str(s) => emit_key(s),
        Node::Seq(_) | Node::Map(_) => Err(Error::Format(
            "Invalid frontmatter: a key that is a list or a map cannot be rewritten; edit the note by hand".into(),
        )),
        scalar => emit_node(scalar, false),
    }
}

// Locating what to replace. Each top-level `key:` owns a block of whole lines.

/// A note's YAML as lines, every one ending in a line break.
struct Lines<'a> {
    text: &'a str,
    starts: Vec<usize>,
}

impl<'a> Lines<'a> {
    fn new(text: &'a str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        if starts.last() == Some(&text.len()) {
            starts.pop();
        }
        Self { text, starts }
    }

    fn line_of(&self, offset: usize) -> usize {
        self.starts.partition_point(|&s| s <= offset).saturating_sub(1)
    }

    fn line_start(&self, offset: usize) -> usize {
        self.starts.get(self.line_of(offset)).copied().unwrap_or(0)
    }

    fn next_line_start(&self, line: usize) -> usize {
        self.starts.get(line + 1).copied().unwrap_or(self.text.len())
    }

    /// The line without its line break.
    fn content(&self, line: usize) -> &'a str {
        let from = self.starts[line];
        self.text[from..self.next_line_start(line)].trim_end_matches(['\n', '\r'])
    }

    /// The first line start at or after `offset`.
    fn round_up(&self, offset: usize) -> usize {
        match self.starts.binary_search(&offset) {
            Ok(_) => offset,
            Err(_) => self.next_line_start(self.line_of(offset)),
        }
    }
}

fn is_comment(line: &str) -> bool {
    line.trim_start_matches([' ', '\t']).starts_with('#')
}

/// Lines that follow a value without being part of it: blank lines, comments, a document end marker.
fn is_filler(line: &str) -> bool {
    line.trim_matches([' ', '\t']).is_empty()
        || is_comment(line)
        || line == "..."
        || line.starts_with("... ")
        || line.starts_with("...\t")
}

/// Where one top-level pair lives in the text (byte offsets of line starts).
#[derive(Debug, Clone, Copy)]
struct Block {
    /// The first line of the comments directly above the key (or the key's own line).
    start: usize,
    key_line: usize,
    /// One past the last line of the pair (trailing blank lines and comments excluded).
    end: usize,
}

fn value_floor(lines: &Lines, p: &Pair) -> usize {
    let key_line = lines.line_of(p.key_start);
    let after_key = lines.next_line_start(key_line);
    match p.style {
        Style::Literal | Style::Folded => lines.round_up(p.value_end.min(lines.text.len())).max(after_key),
        Style::Block => after_key,
        _ => lines.next_line_start(lines.line_of(p.value_end.saturating_sub(1).max(p.key_start))),
    }
}

fn blocks(lines: &Lines, pairs: &[Pair]) -> Vec<Block> {
    let key_lines: Vec<usize> = pairs.iter().map(|p| lines.line_start(p.key_start)).collect();
    let floors: Vec<usize> = pairs.iter().map(|p| value_floor(lines, p)).collect();
    let mut starts = Vec::with_capacity(pairs.len());
    for i in 0..pairs.len() {
        let limit = if i == 0 { 0 } else { floors[i - 1] };
        let mut start = key_lines[i];
        while start > limit {
            let above = lines.starts[lines.line_of(start) - 1];
            if above < limit || !is_comment(lines.content(lines.line_of(above))) {
                break;
            }
            start = above;
        }
        starts.push(start);
    }
    (0..pairs.len())
        .map(|i| {
            let mut end = starts.get(i + 1).copied().unwrap_or(lines.text.len());
            while end > floors[i] {
                let line_start = lines.starts[lines.line_of(end - 1)];
                if line_start < floors[i] || !is_filler(lines.content(lines.line_of(line_start))) {
                    break;
                }
                end = line_start;
            }
            Block { start: starts[i], key_line: key_lines[i], end }
        })
        .collect()
}

/// The offset of the `:` that follows a key on its own line.
fn colon_after(text: &str, key_end: usize) -> Option<usize> {
    let rest = &text[key_end..];
    let blanks = rest.len() - rest.trim_start_matches([' ', '\t']).len();
    rest[blanks..].starts_with(':').then_some(key_end + blanks)
}

/// ` # note` at the end of the line that holds the start of a value (the header of a block scalar or list) or its end,
/// including the blanks before the `#`; empty when there is none.
fn inline_comment<'a>(lines: &Lines<'a>, p: &Pair, colon: usize) -> &'a str {
    let (from, line) = match p.style {
        Style::Literal | Style::Folded | Style::Block => (colon + 1, lines.line_of(colon)),
        _ if p.value_end <= p.key_end => (colon + 1, lines.line_of(colon)),
        _ => (p.value_end, lines.line_of(p.value_end.saturating_sub(1))),
    };
    let to = lines.next_line_start(line);
    let mut rest = lines.text.get(from..to).unwrap_or("").trim_end_matches(['\n', '\r']);
    if matches!(p.style, Style::Literal | Style::Folded) {
        // skip the `|-`, `>2+` header to reach what follows it
        rest = rest.trim_start_matches([' ', '\t']);
        rest = rest.strip_prefix(['|', '>']).unwrap_or(rest);
        rest = rest.trim_start_matches(|c: char| c.is_ascii_digit() || c == '+' || c == '-');
    }
    let blanks = rest.len() - rest.trim_start_matches([' ', '\t']).len();
    if blanks > 0 && rest[blanks..].starts_with('#') { rest.trim_end_matches([' ', '\t']) } else { "" }
}

/// The text before the colon of a pair whose key sits at the start of its line (`  title`), or `None` for the forms
/// that are rewritten from the key's value instead (`? key`, a key after other text).
fn key_head<'a>(lines: &Lines<'a>, p: &Pair, block: &Block) -> Option<(&'a str, usize)> {
    let prefix = &lines.text[block.key_line..p.key_start];
    if !prefix.chars().all(|c| c == ' ') {
        return None;
    }
    let colon = colon_after(lines.text, p.key_end)?;
    if lines.line_of(colon) != lines.line_of(p.key_start) {
        return None;
    }
    Some((&lines.text[block.key_line..colon], colon))
}

/// `Doc` and the text it was read from, with the line breaks to use for new lines.
struct Edit {
    start: usize,
    end: usize,
    text: String,
}

fn splice(text: &str, mut edits: Vec<Edit>) -> String {
    edits.sort_by_key(|e| (e.start, e.end));
    let mut out = String::with_capacity(text.len() + 64);
    let mut at = 0;
    for e in edits {
        // a removal that swallowed lines the next edit starts in (comments above the next key) leaves it less to do
        let start = e.start.max(at);
        out.push_str(&text[at..start]);
        out.push_str(&e.text);
        at = e.end.max(start);
    }
    out.push_str(&text[at..]);
    out
}

/// Rewrites the YAML text with the patch applied, line by line, leaving every other line as it was.
fn edit_lines(yaml: &str, eol: &str, doc: &Doc, patch: &[(String, Value)]) -> Result<String> {
    let work = if yaml.is_empty() { String::new() } else { format!("{yaml}{eol}") };
    let lines = Lines::new(&work);
    let geometry = blocks(&lines, &doc.pairs);

    let mut edits = Vec::new();
    let mut appended = String::new();
    let mut found = vec![false; patch.len()];
    for (i, pair) in doc.pairs.iter().enumerate() {
        let Some(name) = &pair.key else { continue };
        let Some(at) = patch.iter().position(|(k, _)| k == name) else { continue };
        found[at] = true;
        let block = &geometry[i];
        let value = &patch[at].1;
        if value.is_null() {
            // the comments directly above the key go with it; a blank line left on both sides collapses
            let mut end = block.end;
            let before_blank = block.start == 0 || lines.content(lines.line_of(block.start) - 1).trim().is_empty();
            if before_blank {
                while end < lines.text.len() && lines.content(lines.line_of(end)).trim().is_empty() {
                    end = lines.next_line_start(lines.line_of(end));
                }
            }
            // A block scalar takes every line that is indented enough for it, spaces-only lines and `#` lines
            // included: whatever followed the removed pair must not end up directly under an untouched one.
            let under_block_scalar = {
                let removed = |j: usize| {
                    doc.pairs[j].key.as_ref().is_some_and(|k| patch.iter().any(|(p, v)| p == k && v.is_null()))
                };
                let touched = |j: usize| doc.pairs[j].key.as_ref().is_some_and(|k| patch.iter().any(|(p, _)| p == k));
                // the nearest pair above that stays
                (0..i)
                    .rev()
                    .find(|&j| !removed(j))
                    .is_some_and(|j| matches!(doc.pairs[j].style, Style::Literal | Style::Folded) && !touched(j))
            };
            if under_block_scalar {
                end = geometry.get(i + 1).map_or(lines.text.len(), |next| next.start);
                // the comments that come with the next key, as far as they are indented
                if let Some(next) = geometry.get(i + 1) {
                    while end < next.key_line && lines.content(lines.line_of(end)).starts_with([' ', '\t']) {
                        end = lines.next_line_start(lines.line_of(end));
                    }
                }
            }
            edits.push(Edit { start: block.start, end, text: String::new() });
            continue;
        }
        let rendered = match value {
            Value::String(s) if matches!(pair.style, Style::Single | Style::Double) => emit_string_like(s, pair.style),
            other => emit_value(other, false)?,
        };
        let (head, comment) = match key_head(&lines, pair, block) {
            Some((head, colon)) => (head.to_string(), inline_comment(&lines, pair, colon)),
            None => {
                let indent = &lines.text[block.key_line..].chars().take_while(|c| *c == ' ').collect::<String>();
                (format!("{indent}{}", emit_key(name)?), "")
            }
        };
        edits.push(Edit { start: block.key_line, end: block.end, text: format!("{head}: {rendered}{comment}{eol}") });
    }
    // new keys line up with the existing ones (a note may indent its whole mapping)
    let indent: String = geometry
        .first()
        .map(|b| lines.text[b.key_line..].chars().take_while(|c| *c == ' ').collect())
        .unwrap_or_default();
    for (i, (key, value)) in patch.iter().enumerate() {
        if !found[i] && !value.is_null() {
            appended.push_str(&format!("{indent}{}: {}{eol}", emit_key(key)?, emit_value(value, false)?));
        }
    }
    if !appended.is_empty() {
        let mut at = geometry.last().map_or(lines.text.len(), |b| b.end);
        // when the last pair is removed together with the blank lines after it, the new keys go after those too
        for e in &edits {
            if e.start <= at && at < e.end {
                at = e.end;
            }
        }
        edits.push(Edit { start: at, end: at, text: appended });
    }
    Ok(splice(&work, edits))
}

/// Rewrites the document from its values (comments and formatting are lost). Used for the shapes the line editor does
/// not handle: a mapping written in flow style (`{a: 1}`), bare CR line breaks, and stray document markers.
fn rebuild(entries: &[(Node, Node)], patch: &[(String, Value)], eol: &str) -> Result<String> {
    let mut out = String::new();
    let mut used = vec![false; patch.len()];
    for (key, value) in entries {
        let mut text = None;
        if let Node::Str(name) = key
            && let Some(at) = patch.iter().position(|(k, _)| k == name)
        {
            used[at] = true;
            if patch[at].1.is_null() {
                continue;
            }
            text = Some(emit_value(&patch[at].1, false)?);
        }
        let value = match text {
            Some(t) => t,
            None => emit_node(value, false)?,
        };
        out.push_str(&format!("{}: {value}{eol}", emit_node_key(key)?));
    }
    for (i, (key, value)) in patch.iter().enumerate() {
        if !used[i] && !value.is_null() {
            out.push_str(&format!("{}: {}{eol}", emit_key(key)?, emit_value(value, false)?));
        }
    }
    Ok(out)
}

/// What the root mapping must contain after the patch: the old entries with the patched keys replaced or dropped, and
/// the new keys at the end.
fn expected_entries(before: &[(Node, Node)], patch: &[(String, Value)]) -> Vec<(Node, Node)> {
    let mut out = Vec::new();
    let mut used = vec![false; patch.len()];
    for (key, value) in before {
        if let Node::Str(name) = key
            && let Some(at) = patch.iter().position(|(k, _)| k == name)
        {
            used[at] = true;
            if !patch[at].1.is_null() {
                out.push((key.clone(), node_of(&patch[at].1)));
            }
            continue;
        }
        out.push((key.clone(), value.clone()));
    }
    for (i, (key, value)) in patch.iter().enumerate() {
        if !used[i] && !value.is_null() {
            out.push((Node::Str(key.clone()), node_of(value)));
        }
    }
    out
}

/// Applies `patch` to a note's frontmatter and returns the new note text. A `null` value removes the key; every key
/// that is not in the patch, and the body, are left as they were. `body` replaces the body when given.
///
/// Fails, without producing text, when the existing frontmatter is not valid YAML or is not a mapping (rewriting it
/// would destroy it), and when the result would not read back as exactly what was asked for.
pub fn patch_frontmatter<K: AsRef<str>>(content: &str, patch: &[(K, Value)], body: Option<&str>) -> Result<String> {
    let patch = unique_patch(patch);
    let split = split_frontmatter(content);
    let yaml = split.yaml.unwrap_or("");
    let doc = load(yaml).map_err(|message| Error::Format(format!("Invalid frontmatter: {message}")))?;
    if matches!(&doc.root, Some(root) if !matches!(root, Node::Map(_))) {
        return Err(Error::Format("Invalid frontmatter: expected `key: value` pairs".into()));
    }
    let before = root_entries(&doc);

    let bare_cr = yaml.replace("\r\n", "").contains('\r');
    let stray_markers = doc.root.is_none() && !is_blank_or_comments(yaml);
    let eol = if yaml.contains("\r\n") || opens_with_crlf(content) { "\r\n" } else { "\n" };
    let want = expected_entries(before, &patch);

    // The result is read back: the note is only rewritten if it says exactly what was asked.
    let verified = |mut text: String| -> Option<String> {
        // every line ends with a line break; the closing fence supplies the last one
        if let Some(trimmed) = text.strip_suffix("\r\n").or_else(|| text.strip_suffix('\n')) {
            text.truncate(trimmed.len());
        }
        if text.lines().all(|l| l.trim().is_empty()) {
            text.clear();
        }
        let check = load(&text).ok()?;
        let after = root_entries(&check);
        let same = want.len() == after.len()
            && want.iter().zip(after).all(|((k, v), (l, w))| same_node(k, l) && same_node(v, w));
        same.then_some(text)
    };

    let mut edited = None;
    if !(doc.root_is_flow_map || bare_cr || stray_markers) {
        match edit_lines(yaml, eol, &doc, &patch) {
            Ok(text) => edited = verified(text),
            Err(e @ Error::Validation(_)) => return Err(e),
            Err(_) => {}
        }
    }
    // The shapes the line editor does not handle (and the notes where it would not be safe, such as a replaced value
    // that carries an anchor) are rewritten from their values: comments and layout are lost, nothing else is.
    let next = match edited {
        Some(text) => text,
        None => verified(rebuild(before, &patch, if bare_cr { "\n" } else { eol })?).ok_or_else(unsafe_change)?,
    };

    let tail = body.unwrap_or(split.body);
    Ok(if next.is_empty() { format!("---{eol}---{eol}{tail}") } else { format!("---{eol}{next}{eol}---{eol}{tail}") })
}

/// Whether the note's opening fence ends in CRLF: the only sign of the note's line breaks when the YAML is one line.
fn opens_with_crlf(content: &str) -> bool {
    let text = content.strip_prefix('\u{feff}').unwrap_or(content);
    fence_line_len(text).is_some_and(|len| text[..len].ends_with("\r\n"))
}

fn unsafe_change() -> Error {
    Error::Format(
        "Invalid frontmatter: the change cannot be written without altering other fields; edit the note by hand".into(),
    )
}

#[cfg(test)]
mod reading_tests {
    use super::*;
    use serde_json::json;

    fn parse(yaml: &str) -> Value {
        Value::Object(parse_frontmatter(&format!("---\n{yaml}\n---\n")))
    }

    #[test]
    fn splits_yaml_from_body() {
        assert_eq!(split_frontmatter("---\na: 1\n---\nhello\n"), Split { yaml: Some("a: 1"), body: "hello\n" });
        assert_eq!(split_frontmatter("# Title\ntext"), Split { yaml: None, body: "# Title\ntext" });
        assert_eq!(split_frontmatter("\u{feff}---\r\na: 1\r\n---\r\nbody"), Split { yaml: Some("a: 1"), body: "body" });
        assert_eq!(split_frontmatter("---\n---\nbody"), Split { yaml: Some(""), body: "body" });
        assert_eq!(split_frontmatter("---\r\n---\r\nbody"), Split { yaml: Some(""), body: "body" });
        assert_eq!(split_frontmatter("---\n---"), Split { yaml: Some(""), body: "" });
        assert_eq!(split_frontmatter("intro\n\n---\n\nmore").yaml, None);
        assert_eq!(split_frontmatter("---\na: 1\nno closing fence").yaml, None);
        assert_eq!(split_frontmatter("text\n---\na: 1\n---\n").yaml, None);
    }

    #[test]
    fn the_first_closing_fence_ends_the_frontmatter() {
        let s = split_frontmatter("---\na: 1\n---\nbody\n---\nrule\n");
        assert_eq!((s.yaml, s.body), (Some("a: 1"), "body\n---\nrule\n"));
        // quirk kept: `---` right after the opening is YAML content when another fence follows
        let s = split_frontmatter("---\n---\n---\nx");
        assert_eq!((s.yaml, s.body), (Some("---"), "x"));
    }

    #[test]
    fn fences_tolerate_trailing_blanks() {
        let s = split_frontmatter("---  \ta: 1\n");
        assert_eq!(s.yaml, None);
        let s = split_frontmatter("---  \t\na: 1\n---   \nbody");
        assert_eq!((s.yaml, s.body), (Some("a: 1"), "body"));
    }

    #[test]
    fn core_schema_scalars() {
        let v = parse(
            "a: yes\nb: no\nc: 0x1F\nd: 0o17\ne: 1e3\nf: ~\ng: null\nh: 2026-10-20\ni: '123'\nj: 007\nk: +5\nl: 1.\nm: .5\nn: true\no: False\np: 1_000\nq: 0b11\nr: -0.0\ns: ''",
        );
        assert_eq!(v["a"], "yes");
        assert_eq!(v["b"], "no");
        assert_eq!(v["c"], 31);
        assert_eq!(v["d"], 15);
        assert_eq!(v["e"], 1000);
        assert_eq!(v["f"], Value::Null);
        assert_eq!(v["g"], Value::Null);
        assert_eq!(v["h"], "2026-10-20");
        assert_eq!(v["i"], "123");
        assert_eq!(v["j"], 7);
        assert_eq!(v["k"], 5);
        assert_eq!(v["l"], 1);
        assert_eq!(v["m"], 0.5);
        assert_eq!(v["n"], true);
        assert_eq!(v["o"], false);
        assert_eq!(v["p"], "1_000");
        assert_eq!(v["q"], "0b11");
        assert_eq!(v["s"], "");
    }

    #[test]
    fn collections_and_non_string_keys() {
        let v = parse("labels: [a, b]\nlist:\n  - 1\n  - two\nmap: {x: 1}\n1: one\ntrue: yes\n");
        assert_eq!(v["labels"], json!(["a", "b"]));
        assert_eq!(v["list"], json!([1, "two"]));
        assert_eq!(v["map"], json!({"x": 1}));
        assert_eq!(v["1"], "one");
        assert_eq!(v["true"], "yes");
    }

    #[test]
    fn broken_or_non_map_yaml_is_an_empty_object() {
        for yaml in
            ["a: [unclosed", "just a string", "- a\n- b", "a: 1\na: 2", "a: *missing", "\"unterminated", "a: b: c"]
        {
            assert_eq!(parse(yaml), json!({}), "for {yaml:?}");
        }
        assert_eq!(parse_frontmatter(""), Map::new());
        assert_eq!(parse_frontmatter("---\n---\n"), Map::new());
    }

    #[test]
    fn anchors_and_aliases_resolve() {
        let v = parse("a: &x [1, 2]\nb: *x");
        assert_eq!(v["b"], json!([1, 2]));
    }

    #[test]
    fn a_tab_is_a_valid_separator_after_a_colon() {
        assert_eq!(parse("a:\tb\nc:\t12\nd: \t'x'\ne:\t[1]"), json!({"a": "b", "c": 12, "d": "x", "e": [1]}));
        assert_eq!(parse("a:\t-x"), json!({"a": "-x"}));
        // inside a quoted scalar a tab after a colon is text, and stays one
        assert_eq!(parse("a: \"k:\tv\"\nb:\tc"), json!({"a": "k:\tv", "b": "c"}));
        // the offsets of the pairs still point into the original text
        let text = "a:\tb\nzoë:\t日本\nc: 1\n";
        let doc = load(text).unwrap();
        assert_eq!(&text[doc.pairs[2].key_start..doc.pairs[2].key_end], "c");
        let many = (0..50).map(|i| format!("k{i}:\tv{i}\n")).collect::<String>();
        assert_eq!(load(&many).unwrap().pairs.len(), 50);
    }

    #[test]
    fn too_many_tabs_after_colons_read_as_no_frontmatter() {
        let many = (0..=MAX_TAB_FIXES).map(|i| format!("k{i}:\tv\n")).collect::<String>();
        assert!(load(&many).is_err());
    }

    #[test]
    fn a_tab_in_the_indentation_of_a_key_is_an_error() {
        assert_eq!(parse("\ta: 1"), json!({}));
        assert_eq!(parse("a: 1\n \tb: 2"), json!({}));
        assert_eq!(parse("a: |\n  text\n  \twith tab\nb: 2"), json!({"a": "text\n\twith tab\n", "b": 2}));
    }

    #[test]
    fn null_keys_are_empty_strings() {
        assert_eq!(parse("Null: 1"), json!({"": 1}));
        assert_eq!(parse(": x"), json!({"": "x"}));
        assert_eq!(parse("~: x\nnull: y"), json!({}), "two null keys are duplicates");
    }

    #[test]
    fn explicit_tags_of_exotic_types_read_as_objects() {
        assert_eq!(
            parse("a: !!binary aGVsbG8=\nb: !!set {x, y}\nc: !!omap [a: 1]\nd: ok"),
            json!({"a": {}, "b": {}, "c": {}, "d": "ok"})
        );
    }

    #[test]
    fn non_ascii_text_is_positioned_correctly() {
        let doc = load("t: Zoë 日本\nn: 2\n").unwrap();
        assert_eq!(doc.pairs.len(), 2);
        assert_eq!(&"t: Zoë 日本\nn: 2\n"[doc.pairs[1].key_start..doc.pairs[1].key_end], "n");
    }
}

#[cfg(test)]
mod writing_tests {
    use super::*;
    use serde_json::json;

    fn patch(content: &str, changes: &[(&str, Value)]) -> String {
        patch_frontmatter(content, changes, None).unwrap_or_else(|e| panic!("{e} for {content:?}"))
    }

    #[test]
    fn creates_the_block_when_the_note_has_none() {
        assert_eq!(patch("Just text\n", &[("title", json!("Hi"))]), "---\ntitle: Hi\n---\nJust text\n");
        assert_eq!(patch("", &[("a", json!(1)), ("b", json!(true))]), "---\na: 1\nb: true\n---\n");
        assert_eq!(patch("", &[]), "---\n---\n");
        assert_eq!(patch("\u{feff}text", &[("a", json!(1))]), "---\na: 1\n---\ntext");
    }

    #[test]
    fn replaces_in_place_and_appends_new_keys_last() {
        let note = "---\ntitle: Old\nstatus: todo\n---\nBody\n";
        assert_eq!(
            patch(note, &[("status", json!("doing")), ("rank", json!("m")), ("title", json!("New"))]),
            "---\ntitle: New\nstatus: doing\nrank: m\n---\nBody\n"
        );
    }

    #[test]
    fn leaves_everything_else_alone() {
        let note = "---\n# my note\ntitle:   Old  # keep\ncustom: [ a,b ]\n\n# section\nother:\n  - x\n---\nbody";
        let out = patch(note, &[("title", json!("New"))]);
        assert_eq!(out, "---\n# my note\ntitle: New  # keep\ncustom: [ a,b ]\n\n# section\nother:\n  - x\n---\nbody");
    }

    #[test]
    fn removes_a_key_with_the_comments_directly_above_it() {
        let note = "---\na: 1\n# about b\nb: 2\n\n# free comment\nc: 3\n---\n";
        assert_eq!(patch(note, &[("b", Value::Null)]), "---\na: 1\n\n# free comment\nc: 3\n---\n");
        assert_eq!(patch(note, &[("a", Value::Null), ("c", Value::Null)]), "---\n# about b\nb: 2\n\n---\n");
        assert_eq!(patch(note, &[("zzz", Value::Null)]), note, "removing a key that is not there changes nothing");
    }

    #[test]
    fn removing_the_last_key_leaves_an_empty_block() {
        assert_eq!(patch("---\na: 1\n---\nx", &[("a", Value::Null)]), "---\n---\nx");
        assert_eq!(patch("---\na: 1\n\n\n---\nx", &[("a", Value::Null)]), "---\n---\nx");
        assert_eq!(patch("---\n# only a comment\n---\nx", &[("a", Value::Null)]), "---\n# only a comment\n---\nx");
    }

    #[test]
    fn a_blank_line_does_not_double_up_when_a_key_between_blanks_goes() {
        assert_eq!(patch("---\na: 1\n\nb: 2\n\nc: 3\n---\n", &[("b", Value::Null)]), "---\na: 1\n\nc: 3\n---\n");
    }

    #[test]
    fn keeps_the_quote_style_of_the_old_value() {
        let note = "---\na: \"x\"\nb: 'y'\nc: plain\n---\n";
        let out = patch(note, &[("a", json!("it's")), ("b", json!("it's")), ("c", json!("it's"))]);
        assert_eq!(out, "---\na: \"it's\"\nb: 'it''s'\nc: it's\n---\n");
        assert_eq!(patch(note, &[("b", json!("a\nb"))]), "---\na: \"x\"\nb: \"a\\nb\"\nc: plain\n---\n");
        // a number is never quoted
        assert_eq!(patch(note, &[("a", json!(5))]), "---\na: 5\nb: 'y'\nc: plain\n---\n");
    }

    #[test]
    fn replacing_a_block_scalar_or_list_keeps_a_header_comment() {
        let note = "---\ntitle: |- # why\n  first\n  second\nlist: # items\n  - a\n  - b\nnext: 1\n---\n";
        let out = patch(note, &[("title", json!("One line")), ("list", json!(["a", "b"]))]);
        assert_eq!(out, "---\ntitle: One line # why\nlist: [ a, b ] # items\nnext: 1\n---\n");
    }

    #[test]
    fn a_comment_after_the_value_survives_a_replacement() {
        assert_eq!(
            patch("---\na: 'x'   # why\nb: [1,\n  2] # list\n---\n", &[("a", json!("y")), ("b", json!([3]))]),
            "---\na: 'y'   # why\nb: [ 3 ] # list\n---\n"
        );
    }

    #[test]
    fn the_empty_value_and_its_comment() {
        assert_eq!(
            patch("---\na:   # nothing yet\nb: 1\n---\n", &[("a", json!("v"))]),
            "---\na: v   # nothing yet\nb: 1\n---\n"
        );
        assert_eq!(patch("---\na:\nb: 1\n---\n", &[("a", json!(2))]), "---\na: 2\nb: 1\n---\n");
    }

    #[test]
    fn indented_documents_keep_their_indentation() {
        assert_eq!(
            patch("---\n  a: 1\n  b: 2\n---\n", &[("a", json!(9)), ("c", json!("new"))]),
            "---\n  a: 9\n  b: 2\n  c: new\n---\n"
        );
    }

    #[test]
    fn crlf_notes_stay_crlf_and_so_do_their_fences() {
        let note = "---\r\na: 1\r\nb: 2\r\n---\r\nbody\r\n";
        assert_eq!(
            patch(note, &[("b", json!(3)), ("c", json!("x"))]),
            "---\r\na: 1\r\nb: 3\r\nc: x\r\n---\r\nbody\r\n"
        );
        // one line of YAML: the fences say what the note uses
        assert_eq!(patch("---\r\na: 1\r\n---\r\n", &[("b", json!(2))]), "---\r\na: 1\r\nb: 2\r\n---\r\n");
    }

    #[test]
    fn a_bom_is_dropped_and_the_body_is_kept() {
        assert_eq!(
            patch("\u{feff}---\ntitle: A\n---\nBody\r\n", &[("title", json!("B"))]),
            "---\ntitle: B\n---\nBody\r\n"
        );
    }

    #[test]
    fn replaces_the_body_when_asked() {
        assert_eq!(
            patch_frontmatter("---\na: 1\n---\nold", &[("a", json!(2))], Some("new\n")).unwrap(),
            "---\na: 2\n---\nnew\n"
        );
        assert_eq!(patch_frontmatter("---\na: 1\n---\nold", &[("a", json!(1))], Some("")).unwrap(), "---\na: 1\n---\n");
    }

    #[test]
    fn a_patch_that_names_a_key_twice_uses_the_last_value() {
        assert_eq!(patch("", &[("a", json!(1)), ("b", json!(2)), ("a", json!(3))]), "---\na: 3\nb: 2\n---\n");
        assert_eq!(patch("---\na: 1\n---\n", &[("a", json!(5)), ("a", Value::Null)]), "---\n---\n");
    }

    #[test]
    fn an_explicit_key_and_a_document_end_marker() {
        assert_eq!(patch("---\n? a\n: 1\nb: 2\n---\n", &[("a", json!(9))]), "---\na: 9\nb: 2\n---\n");
        assert_eq!(patch("---\nk: v\n...\n---\n", &[("n", json!(1))]), "---\nk: v\nn: 1\n...\n---\n");
    }

    #[test]
    fn complex_keys_are_kept_when_untouched() {
        assert_eq!(patch("---\n? [x, y]\n: v\nb: 1\n---\n", &[("b", json!(2))]), "---\n? [x, y]\n: v\nb: 2\n---\n");
    }

    #[test]
    fn a_flow_mapping_or_bare_cr_document_is_rewritten_from_its_values() {
        assert_eq!(
            patch("---\n{a: 1, b: [x, y]}\n---\n", &[("c", json!(true))]),
            "---\na: 1\nb: [ x, y ]\nc: true\n---\n"
        );
        // bare CR line breaks inside the block (an old Mac file): rewritten with LF
        assert_eq!(patch("---\na: 1\rb: 2\n---\nbody", &[("b", json!(3))]), "---\na: 1\nb: 3\n---\nbody");
    }

    #[test]
    fn a_replaced_anchor_does_not_leave_an_alias_dangling() {
        let out = patch("---\na: &x value\nb: *x\n---\n", &[("a", json!("other"))]);
        assert_eq!(Value::Object(parse_frontmatter(&out)), json!({"a": "other", "b": "value"}));
    }

    #[test]
    fn removing_under_a_block_scalar_does_not_change_the_scalar() {
        // the spaces-only line and the indented comment would become part of the literal if they ended up under it
        let note = "---\nb: |-\n  text\na: 1\n   \n  # note\nc: 2\n---\n";
        let out = patch(note, &[("a", Value::Null)]);
        assert_eq!(Value::Object(parse_frontmatter(&out)), json!({"b": "text", "c": 2}));
        assert!(out.starts_with("---\nb: |-\n  text\n"), "the scalar's lines are untouched: {out:?}");
    }

    #[test]
    fn refuses_a_note_it_cannot_rewrite() {
        let err = |note: &str| patch_frontmatter(note, &[("a", json!(1))], None).unwrap_err().to_string();
        assert!(err("---\na: [unclosed\n---\n").starts_with("Invalid frontmatter: "));
        assert!(err("---\na: 1\na: 2\n---\n").starts_with("Invalid frontmatter: "));
        for note in
            ["---\n- a\n- b\n---\n", "---\njust text\n---\n", "---\n~\n---\n", "---\nnull\n---\n", "---\n\"s\"\n---\n"]
        {
            assert_eq!(err(note), "Invalid frontmatter: expected `key: value` pairs", "for {note:?}");
        }
    }

    #[test]
    fn refuses_keys_that_cannot_be_written() {
        let err = patch_frontmatter("", &[("two\nlines", json!(1))], None).unwrap_err();
        assert!(matches!(err, Error::Validation(_)), "{err}");
        assert!(err.to_string().contains("one line"));
        let long = "k".repeat(1025);
        assert!(patch_frontmatter("", &[(long.as_str(), json!(1))], None).is_err());
        assert!(patch_frontmatter("", &[("k".repeat(1024).as_str(), json!(1))], None).is_ok());
    }

    #[test]
    fn writes_values_the_way_the_yaml_package_does() {
        let cases: &[(Value, &str)] = &[
            (json!("plain text"), "plain text"),
            (json!(""), "\"\""),
            (json!(" lead"), "\" lead\""),
            (json!("trail "), "\"trail \""),
            (json!("a: b"), "\"a: b\""),
            (json!("a:b"), "a:b"),
            (json!("a #b"), "\"a #b\""),
            (json!("a#b"), "a#b"),
            (json!("- x"), "\"- x\""),
            (json!("-x"), "-x"),
            (json!("-"), "\"-\""),
            (json!("?"), "\"?\""),
            (json!("@at"), "\"@at\""),
            (json!("%p"), "\"%p\""),
            (json!("*"), "\"*\""),
            (json!("[x]"), "\"[x]\""),
            (json!("a, b"), "a, b"),
            (json!("true"), "\"true\""),
            (json!("null"), "\"null\""),
            (json!("~"), "\"~\""),
            (json!("12"), "\"12\""),
            (json!("1e3"), "\"1e3\""),
            (json!("0x1F"), "\"0x1F\""),
            (json!(".inf"), "\".inf\""),
            (json!("yes"), "yes"),
            (json!("2026-10-20"), "2026-10-20"),
            (json!("say \"hi\""), "say \"hi\""),
            (json!("\"hi\" there"), "'\"hi\" there'"),
            (json!("'hi' there"), "\"'hi' there\""),
            (json!("it's"), "it's"),
            (json!("both ' and \""), "both ' and \""),
            (json!("\"both\" ' and"), "\"\\\"both\\\" ' and\""),
            (json!("--- x"), "\"--- x\""),
            (json!("multi\nline"), "\"multi\\nline\""),
            (json!("tab\there"), "\"tab\\there\""),
            (json!("nbsp\u{a0}"), "\"nbsp\\_\""),
            (json!("\u{3000}"), "\"\\u3000\""),
            (json!("bell\u{7}"), "\"bell\\a\""),
            (json!("del\u{7f}"), "\"del\\x7f\""),
            (json!("line\u{2028}sep"), "\"line\\Lsep\""),
            (json!("bom\u{feff}"), "\"bom\\ufeff\""),
            (json!("日本語 🙂"), "日本語 🙂"),
            (json!(0.5), "0.5"),
            (json!(-2), "-2"),
            (json!(1e21), "1e+21"),
            (json!(true), "true"),
            (json!([]), "[]"),
            (json!(["a", 1, true, null, "x y"]), "[ a, 1, true, null, x y ]"),
            (json!(["a, b", "[c]", "d-"]), "[ \"a, b\", \"[c]\", \"d-\" ]"),
            (json!([["x"], {"k": "v"}]), "[ [ x ], { k: v } ]"),
            (json!({}), "{}"),
            (json!({"a": 1, "b c": [2]}), "{ a: 1, b c: [ 2 ] }"),
        ];
        for (value, expected) in cases {
            let out = patch("", &[("k", value.clone())]);
            assert_eq!(out, format!("---\nk: {expected}\n---\n"), "for {value}");
        }
    }

    #[test]
    fn keys_are_quoted_when_they_need_to_be() {
        let out = patch(
            "",
            &[
                ("plain-key_1", json!(1)),
                ("with space", json!(2)),
                ("1", json!(3)),
                ("true", json!(4)),
                ("", json!(5)),
                ("a: b", json!(6)),
            ],
        );
        assert_eq!(out, "---\nplain-key_1: 1\nwith space: 2\n\"1\": 3\n\"true\": 4\n\"\": 5\n\"a: b\": 6\n---\n");
        assert_eq!(parse_frontmatter(&out).len(), 6);
    }

    #[test]
    fn a_numeric_key_and_the_same_text_as_a_string_key_are_different_keys() {
        // `1:` is the number 1, `"1"` the string: patching "1" must not touch the number's pair (as `yaml` does)
        let out = patch("---\n1: one\n---\n", &[("1", json!("two"))]);
        assert_eq!(out, "---\n1: one\n\"1\": two\n---\n");
    }
}
