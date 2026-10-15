//! Properties of reading and, above all, patching frontmatter, independent of the TypeScript corpus: a patch touches
//! only the keys it names, what it writes reads back as what was asked, and no input makes anything panic.
mod common;

use oprojects_mcp::frontmatter::{parse_frontmatter, patch_frontmatter, split_frontmatter};
use proptest::prelude::*;
use serde_json::{Map, Number, Value, json};

const KEYS: &[&str] = &[
    "title", "status", "type", "priority", "assignee", "labels", "due", "estimate", "parent", "rank", "created",
    "updated", "resolved", "custom", "related", "note", "x", "my_field", "key-1",
];

const PLAIN: &[&str] = &[
    "todo",
    "high",
    "2026-10-20",
    "12",
    "0.5",
    "Zoë café",
    "node.js",
    "100%",
    "a#b",
    "yes",
    "~",
    "null",
    "true",
    "path/to/file",
    "it's",
    "日本語",
    "a, b",
    "-1",
    "0x1F",
];

/// One top-level pair of a hand-written note: the lines it is made of, and the comment/blank lines above it.
#[derive(Debug, Clone)]
struct Entry {
    key: &'static str,
    above: Vec<&'static str>,
    lines: Vec<String>,
}

fn entry(key: &'static str) -> impl Strategy<Value = Entry> {
    let sep = prop::sample::select(vec![": ", ":  ", ":   ", ":\t", ": \t"]);
    let comment = prop::sample::select(vec!["", "", "", " # why", "  #x"]);
    let above =
        prop::collection::vec(prop::sample::select(vec!["", "# a comment", "#", "  # indented comment", "   "]), 0..3);
    let plain = prop::sample::select(PLAIN.to_vec());
    // the lines of a value (`{sep}` stands for the separator after the key) and whether a comment may end its first line
    let shape = prop_oneof![
        plain.clone().prop_map(|v| (vec![format!("{{sep}}{v}")], true)),
        plain.clone().prop_map(|v| (vec![format!("{{sep}}\"{v}\"")], true)),
        plain.clone().prop_map(|v| (vec![format!("{{sep}}'{}'", v.replace('\'', "''"))], true)),
        plain.clone().prop_map(|v| (vec![format!("{{sep}}[{v}, b, \"x y\"]")], true)),
        Just((vec!["{sep}[]".to_string()], true)),
        plain.clone().prop_map(|v| (vec![format!("{{sep}}{{k: {v}}}")], true)),
        plain.clone().prop_map(|v| (vec!["{sep}".to_string(), format!("  - {v}"), "  - second".to_string()], true)),
        plain.clone().prop_map(|v| (vec!["{sep}|-".to_string(), format!("  {v}"), "  second".to_string()], true)),
        plain
            .clone()
            .prop_map(|v| (vec!["{sep}>".to_string(), format!("  {v}"), "".to_string(), "  second".to_string()], true)),
        plain.clone().prop_map(|v| (vec![format!("{{sep}}{v}"), "  continued".to_string()], false)),
        Just((vec!["{sep}".to_string()], true)),
    ];
    (above, sep, shape, comment).prop_map(move |(above, sep, (shape, comment_ok), comment)| {
        let mut lines: Vec<String> = shape.into_iter().map(|l| l.replace("{sep}", sep)).collect();
        if comment_ok {
            lines[0].push_str(comment);
        }
        let first = format!("{key}{}", lines[0]);
        lines[0] = first;
        Entry { key, above, lines }
    })
}

#[derive(Debug, Clone)]
struct Note {
    entries: Vec<Entry>,
    footer: Vec<&'static str>,
    eol: &'static str,
}

impl Note {
    fn yaml(&self) -> String {
        let mut lines: Vec<&str> = Vec::new();
        for e in &self.entries {
            lines.extend(e.above.iter().copied());
            lines.extend(e.lines.iter().map(String::as_str));
        }
        lines.extend(self.footer.iter().copied());
        lines.join(self.eol)
    }

    fn content(&self, body: &str) -> String {
        format!("---{eol}{}{eol}---{eol}{body}", self.yaml(), eol = self.eol)
    }
}

fn note() -> impl Strategy<Value = Note> {
    prop::sample::subsequence(KEYS.to_vec(), 0..=7)
        .prop_shuffle()
        .prop_flat_map(|keys| {
            let entries: Vec<_> = keys.into_iter().map(entry).collect();
            (
                entries,
                prop::collection::vec(prop::sample::select(vec!["# footer comment", "", "  # "]), 0..2),
                prop::sample::select(vec!["\n", "\n", "\r\n"]),
            )
        })
        .prop_map(|(entries, footer, eol)| Note { entries, footer, eol })
}

fn json_value() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        any::<bool>().prop_map(Value::Bool),
        (-100_000i64..100_000).prop_map(|n| Value::Number(n.into())),
        (-1.0e9f64..1.0e9).prop_map(|f| Value::Number(Number::from_f64(f).unwrap())),
        prop::sample::select(PLAIN.to_vec()).prop_map(|s| Value::String(s.to_string())),
        any::<String>().prop_map(Value::String),
        "[ -~]{0,12}".prop_map(Value::String),
        // text made of the characters YAML gives a meaning to, to try every edge of the plain/quoted decision
        "[-?:#,\\[\\]{}\"'&*!|>%@` a1.~\\\\]{0,8}".prop_map(Value::String),
    ];
    leaf.prop_recursive(2, 10, 4, |inner| {
        prop_oneof![
            prop::collection::vec(prop_oneof![3 => inner.clone(), 1 => Just(Value::Null)], 0..4).prop_map(Value::Array),
            prop::collection::btree_map("[a-z]{1,4}", inner, 0..3).prop_map(|m| Value::Object(m.into_iter().collect())),
        ]
    })
}

/// A patch over keys the note has and keys it does not; `null` removes.
fn patch_for(note: &Note) -> impl Strategy<Value = Vec<(String, Value)>> + use<> {
    let present: Vec<&'static str> = note.entries.iter().map(|e| e.key).collect();
    let key = prop_oneof![
        2 => if present.is_empty() { prop::sample::select(KEYS.to_vec()).boxed() } else { prop::sample::select(present).boxed() },
        1 => prop::sample::select(KEYS.to_vec()),
    ];
    let value = prop_oneof![3 => json_value(), 1 => Just(Value::Null)];
    prop::collection::vec((key.prop_map(str::to_string), value), 0..5)
}

fn note_and_patch() -> impl Strategy<Value = (Note, Vec<(String, Value)>)> {
    note().prop_flat_map(|n| {
        let patch = patch_for(&n);
        (Just(n), patch)
    })
}

/// What `patch_frontmatter` must leave behind: the old values with the patch applied.
fn applied(original: &str, patch: &[(String, Value)]) -> Value {
    let mut want = parse_frontmatter(original);
    for (key, value) in patch {
        if value.is_null() {
            want.remove(key);
        } else {
            want.insert(key.clone(), value.clone());
        }
    }
    Value::Object(want)
}

fn assert_same(actual: &Value, expected: &Value) {
    assert!(common::json_eq(actual, expected), "reads as {actual}\nwanted   {expected}");
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, failure_persistence: None, ..ProptestConfig::default() })]

    /// The generated notes are what the properties assume: valid, with the keys and values they were built from.
    #[test]
    fn generated_notes_are_valid(note in note()) {
        let content = note.content("body\n");
        let parsed = parse_frontmatter(&content);
        let keys: Vec<&str> = parsed.keys().map(String::as_str).collect();
        let mut want: Vec<&str> = note.entries.iter().map(|e| e.key).collect();
        want.sort_unstable();
        let mut got = keys.clone();
        got.sort_unstable();
        prop_assert_eq!(got, want, "for {:?}", content);
    }

    /// A patch changes the keys it names and nothing else: every other pair's lines survive byte for byte, in order,
    /// and so does the body.
    #[test]
    fn a_patch_touches_only_the_keys_it_names((note, patch) in note_and_patch()) {
        let content = note.content("Body text\n- [ ] task\n");
        let out = patch_frontmatter(&content, &patch, None).unwrap_or_else(|e| panic!("{e} for {content:?} with {patch:?}"));
        prop_assert_eq!(split_frontmatter(&out).body, "Body text\n- [ ] task\n");

        let named: Vec<&str> = patch.iter().map(|(k, _)| k.as_str()).collect();
        let yaml = split_frontmatter(&out).yaml.unwrap_or("").to_string();
        let mut at = 0;
        for e in note.entries.iter().filter(|e| !named.contains(&e.key)) {
            let raw = e.lines.join(note.eol);
            let found = yaml[at..].find(&raw);
            prop_assert!(found.is_some(), "the lines of `{}` ({raw:?}) are gone or out of order in {yaml:?}\nfrom {content:?}\npatch {patch:?}", e.key);
            at += found.unwrap() + raw.len();
        }
    }

    /// What is written reads back as the old values with the patch applied.
    #[test]
    fn a_patch_reads_back_as_asked((note, patch) in note_and_patch()) {
        let content = note.content("body\n");
        let out = patch_frontmatter(&content, &patch, None).unwrap();
        assert_same(&Value::Object(parse_frontmatter(&out)), &applied(&content, &patch));
    }

    /// Applying the same patch again changes nothing.
    #[test]
    fn a_patch_is_idempotent((note, patch) in note_and_patch()) {
        let once = patch_frontmatter(&note.content("body\n"), &patch, None).unwrap();
        let twice = patch_frontmatter(&once, &patch, None).unwrap();
        prop_assert_eq!(once, twice);
    }

    /// A note that uses CRLF keeps it: no bare line feed appears in the frontmatter or its fences.
    #[test]
    fn crlf_notes_stay_crlf((note, patch) in note_and_patch().prop_map(|(n, p)| (Note { eol: "\r\n", ..n }, p))) {
        let out = patch_frontmatter(&note.content("body\r\n"), &patch, None).unwrap();
        // everything up to the body, fences included
        let head = &out[..out.len() - split_frontmatter(&out).body.len()];
        prop_assert!(!head.replace("\r\n", "").contains('\n'), "bare LF in {head:?}");
    }

    /// Any text, as a value or inside a list, comes back exactly: whitespace, quotes, control characters, `---`.
    #[test]
    fn any_value_round_trips(value in json_value(), key in prop::sample::select(KEYS.to_vec())) {
        prop_assume!(!value.is_null());
        let out = patch_frontmatter("", &[(key, value.clone())], None).unwrap();
        let parsed = Value::Object(parse_frontmatter(&out));
        assert_same(&parsed, &json!({ key: value }));
    }

    /// The characters YAML gives a meaning to, many to a string, inside lists and maps, where the rules are stricter.
    #[test]
    fn tricky_text_in_flow_collections_round_trips(
        items in prop::collection::vec("[-?:#,\\[\\]{}\"'&*!|>%@` a1.~\\\\]{0,6}", 0..5),
    ) {
        let list: Vec<Value> = items.iter().cloned().map(Value::String).collect();
        let map: Map<String, Value> = items.iter().enumerate().map(|(i, s)| (format!("k{i}"), json!(s))).collect();
        for value in [Value::Array(list), Value::Object(map)] {
            let out = patch_frontmatter("", &[("v", value.clone())], None).unwrap_or_else(|e| panic!("{e} for {value}"));
            assert_same(&Value::Object(parse_frontmatter(&out)), &json!({ "v": value }));
        }
    }

    /// Any one-line key can be written and read back.
    #[test]
    fn any_key_round_trips(key in "[^\r\n]{0,40}") {
        let out = patch_frontmatter("---\nother: 1\n---\n", &[(key.clone(), json!("v"))], None).unwrap();
        let parsed = parse_frontmatter(&out);
        prop_assert_eq!(parsed.get(&key), Some(&json!("v")), "key {:?} in {:?}", key, out);
        prop_assert_eq!(parsed.get("other"), Some(&json!(1)));
    }

    /// Whatever the bytes, reading never panics, and patching either refuses or says what was asked.
    #[test]
    fn arbitrary_text_never_panics(content in any::<String>()) {
        let _ = parse_frontmatter(&content);
        if let Ok(out) = patch_frontmatter(&content, &[("a", json!(1))], None) {
            let reread = parse_frontmatter(&out);
            prop_assert_eq!(reread.get("a"), Some(&json!(1)));
        }
    }

    /// Text that looks like YAML but is broken in small ways: no panic, and a refusal leaves nothing to write.
    #[test]
    fn yamlish_text_never_panics(parts in prop::collection::vec(prop::sample::select(vec![
        "a: 1", "b: [x", "c: {y: 2}", "- item", "? k", ": v", "&a x", "*a", "!!str t", "|", ">-", "  indented: 1", "\ttab: 1",
        "# comment", "", "---", "...", "'open", "\"open", "key:", "d: |\n  text", "e: >\n  folded\n", "%YAML 1.2", "<<: *a",
        "a: 1", "[1, 2]", "{}", "? [x]\n: y", "k:\tv",
    ]), 0..8), eol in prop::sample::select(vec!["\n", "\r\n", "\r"])) {
        let content = format!("---{eol}{}{eol}---{eol}body", parts.join(eol));
        let parsed = parse_frontmatter(&content);
        let outcome = patch_frontmatter(&content, &[("zz", json!("new"))], None);
        if let Ok(out) = outcome {
            let reread = parse_frontmatter(&out);
            prop_assert_eq!(reread.get("zz"), Some(&json!("new")));
            let mut want: Map<String, Value> = parsed;
            want.insert("zz".into(), json!("new"));
            assert_same(&Value::Object(reread), &Value::Object(want));
        }
    }
}
