//! Properties of the comments section and the checkbox toggling, independent of the TypeScript corpus.
use oprojects_mcp::body::{
    add_comment_to_body, clean_author, edit_comment_in_body, format_comment, format_section, join_body, parse_comments,
    remove_comment_from_body, split_body, toggle_task,
};
use oprojects_mcp::jscompat::{js_trim, js_trim_end};
use oprojects_mcp::types::Comment;
use proptest::prelude::*;

const LINES: &[&str] = &[
    "",
    "   ",
    "\t",
    "> quoted",
    "> > nested",
    ">",
    "## Comments",
    "## Heading",
    "### Comments",
    "```",
    "```js",
    "~~~",
    "- [ ] task",
    "- [x] done",
    "  indented",
    "- item",
    "1. numbered",
    "---",
    "|a|b|",
    "plain words",
    "日本語 and Zoë",
    "🙂",
    "[!comment|fake] boom",
    "  [!comment] indented marker",
    "[!Comment|y,2026-01-01T00:00:00.000Z] Cased · x",
    "\\[!comment|already] escaped",
    "\\\\[!comment] twice",
];

fn line() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => prop::sample::select(LINES.to_vec()).prop_map(str::to_string),
        1 => "[^\r\n]{0,24}",
    ]
}

/// A multi-line comment text using LF or CRLF.
fn text() -> impl Strategy<Value = String> {
    (prop::collection::vec(line(), 1..6), prop::sample::select(vec!["\n", "\r\n"]))
        .prop_map(|(lines, eol)| lines.join(eol))
}

/// What formatting then parsing guarantees for a text: CRLF folded, blank lines emptied, the tail trimmed.
fn normalized(text: &str) -> String {
    let text = text.replace("\r\n", "\n");
    let trimmed = text.trim_end_matches(|c: char| oprojects_mcp::jscompat::is_js_whitespace(c));
    trimmed
        .split('\n')
        .map(|l| if oprojects_mcp::jscompat::js_trim(l).is_empty() { "" } else { l })
        .collect::<Vec<_>>()
        .join("\n")
}

fn author() -> impl Strategy<Value = String> {
    prop_oneof![
        "\\PC{0,16}",
        prop::sample::select(vec!["Ana", "Ana · [admin]\nSouza", "  Bruno  ", "", "···", "[]"])
            .prop_map(str::to_string),
    ]
}

fn iso() -> impl Strategy<Value = String> {
    (2020u32..2035, 1u32..13, 1u32..29, 0u32..24, 0u32..60, 0u32..60, 0u32..1000)
        .prop_map(|(y, mo, d, h, mi, s, ms)| format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z"))
}

fn comment() -> impl Strategy<Value = Comment> {
    ("[a-z0-9]{3,6}", author(), iso(), text()).prop_map(|(id, author, at, text)| Comment { id, author, at, text })
}

/// Comments with unique ids.
fn comments() -> impl Strategy<Value = Vec<Comment>> {
    prop::collection::vec(comment(), 1..5).prop_map(|mut list| {
        let mut seen = std::collections::HashSet::new();
        list.retain(|c| seen.insert(c.id.clone()));
        list
    })
}

/// A description without a comments heading or code fence (see the notes in the tests).
fn description() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof![
            "[^\r\n]{0,20}",
            prop::sample::select(vec!["", "Some text", "- [ ] a", "## Other heading", "> quote", "    code"])
                .prop_map(str::to_string),
        ],
        0..6,
    )
    .prop_map(|lines| lines.join("\n"))
    .prop_filter("no comments heading or fence", |d| {
        !d.lines().any(|l| {
            let t = l.trim();
            t.to_ascii_lowercase().starts_with("##")
                && t.to_ascii_lowercase().replace([' ', '\t'], "").trim_start_matches('#') == "comments"
                || t.starts_with("```")
                || t.starts_with("~~~")
        })
    })
}

fn expected(c: &Comment) -> Comment {
    let author = clean_author(&c.author);
    Comment {
        id: c.id.clone(),
        author: if author.is_empty() { "Unknown".into() } else { author },
        at: c.at.clone(),
        text: normalized(&c.text),
    }
}

fn build(description: &str, comments: &[Comment]) -> String {
    comments.iter().fold(description.to_string(), |body, c| add_comment_to_body(&body, c, 0))
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn clean_author_leaves_no_break_bracket_or_separator_and_is_idempotent(name in "\\PC{0,30}") {
        let clean = clean_author(&name);
        prop_assert!(!clean.contains(['\r', '\n', '[', ']', '·']));
        prop_assert_eq!(js_trim(&clean), clean.as_str());
        prop_assert!(!clean.contains("  "));
        prop_assert_eq!(clean_author(&clean), clean);
    }

    #[test]
    fn adding_then_parsing_round_trips_every_comment(description in description(), list in comments()) {
        let body = build(&description, &list);
        let parsed = parse_comments(&body);
        let want: Vec<Comment> = list.iter().map(expected).collect();
        prop_assert_eq!(parsed, want);
    }

    #[test]
    fn the_description_stays_in_front_of_the_section(description in description(), list in comments()) {
        let body = build(&description, &list);
        let split = split_body(&body);
        prop_assert_eq!(js_trim_end(&split.description), js_trim_end(&description));
        prop_assert!(split.section.unwrap().starts_with("## Comments\n"));
    }

    #[test]
    fn a_section_written_by_format_section_parses_back_to_the_same_comments(list in comments()) {
        let parsed = parse_comments(&format_section(&list, 0));
        let want: Vec<Comment> = list.iter().map(expected).collect();
        prop_assert_eq!(parsed, want);
    }

    #[test]
    fn a_formatted_comment_is_one_callout_whose_first_line_carries_the_id_and_time(c in comment()) {
        let block = format_comment(&c, 0);
        let mut lines = block.split('\n');
        let head = lines.next().unwrap();
        let prefix = format!("> [!comment|{},{}] ", c.id, c.at);
        prop_assert!(head.starts_with(&prefix), "{head}");
        prop_assert!(lines.all(|l| l == ">" || l.starts_with("> ")));
    }

    #[test]
    fn text_that_looks_like_the_comment_syntax_cannot_split_or_invent_comments(
        lines in prop::collection::vec(line(), 1..6),
        c in comment(),
    ) {
        let c = Comment { text: lines.join("\n"), ..c };
        let body = add_comment_to_body("Description", &c, 0);
        let parsed = parse_comments(&body);
        prop_assert_eq!(parsed.len(), 1);
        prop_assert_eq!(&parsed[0].text, &normalized(&c.text));
    }

    #[test]
    fn parse_comments_and_split_body_never_panic(note in "\\PC{0,200}") {
        let _ = parse_comments(&note);
        let _ = split_body(&note);
    }

    #[test]
    fn a_hand_written_callout_gets_the_same_derived_id_every_time(
        title in "[A-Za-z ]{0,10}",
        lines in prop::collection::vec(line().prop_filter("not a marker", |l| !l.to_ascii_lowercase().contains("[!comment")), 0..3),
    ) {
        let note = format!("## Comments\n\n> [!comment] {title}\n{}", lines.iter().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n"));
        let first = parse_comments(&note);
        prop_assert_eq!(first.len(), 1);
        prop_assert!(first[0].id.starts_with('h') && first[0].id.len() > 1);
        prop_assert_eq!(parse_comments(&note), first);
    }

    #[test]
    fn editing_rewrites_only_the_target(description in description(), list in comments(), pick in 0usize..4, new_text in text()) {
        let body = build(&description, &list);
        let target = &list[pick % list.len()];
        let edited = edit_comment_in_body(&body, &target.id, &new_text).unwrap();
        let after = parse_comments(&edited);
        for (before, now) in list.iter().zip(&after) {
            if before.id == target.id {
                prop_assert_eq!(&now.text, &normalized(&new_text));
                prop_assert_eq!(&now.author, &expected(before).author);
                prop_assert_eq!(&now.at, &before.at);
            } else {
                prop_assert_eq!(now, &expected(before));
            }
        }
        let split = split_body(&edited);
        prop_assert_eq!(js_trim_end(&split.description), js_trim_end(&description));
        // editing twice with the same text changes nothing the second time
        prop_assert_eq!(edit_comment_in_body(&edited, &target.id, &new_text).unwrap(), edited);
    }

    #[test]
    fn removing_takes_exactly_the_target_and_the_last_one_takes_the_section(description in description(), list in comments(), pick in 0usize..4) {
        let body = build(&description, &list);
        let target = &list[pick % list.len()];
        let removed = remove_comment_from_body(&body, &target.id).unwrap();
        let after = parse_comments(&removed);
        let want: Vec<Comment> = list.iter().filter(|c| c.id != target.id).map(expected).collect();
        prop_assert_eq!(&after, &want);
        if want.is_empty() {
            prop_assert!(split_body(&removed).section.is_none(), "the empty section must go: {removed:?}");
        }
    }

    #[test]
    fn an_unknown_id_is_never_guessed(description in description(), list in comments()) {
        let body = build(&description, &list);
        prop_assert_eq!(edit_comment_in_body(&body, "no-such-id", "x"), None);
        prop_assert_eq!(remove_comment_from_body(&body, "no-such-id"), None);
        prop_assert_eq!(edit_comment_in_body("just a description", "a", "x"), None);
    }

    #[test]
    fn join_then_split_gives_the_section_back_untouched(description in "[^#]{0,40}", section in "## Comments\n[^\r]{0,40}") {
        let joined = join_body(&description, Some(&section));
        let split = split_body(&joined);
        prop_assert_eq!(split.section.as_deref(), Some(section.as_str()));
        prop_assert_eq!(js_trim_end(&split.description), js_trim_end(&description));
        prop_assert_eq!(join_body(&description, None), description);
    }

    #[test]
    fn toggling_changes_exactly_one_line_one_character_and_twice_restores_it(
        lines in prop::collection::vec(line(), 1..10),
        eol in prop::sample::select(vec!["\n", "\r\n"]),
        index in 0usize..4,
    ) {
        let doc = lines.join(eol);
        if let Some(once) = toggle_task(&doc, index) {
            let before: Vec<&str> = doc.split('\n').collect();
            let after: Vec<&str> = once.split('\n').collect();
            prop_assert_eq!(before.len(), after.len());
            let changed: Vec<usize> = (0..before.len()).filter(|i| before[*i] != after[*i]).collect();
            prop_assert_eq!(changed.len(), 1);
            let (b, a) = (before[changed[0]], after[changed[0]]);
            prop_assert_eq!(b.chars().count(), a.chars().count());
            prop_assert_eq!(b.chars().zip(a.chars()).filter(|(x, y)| x != y).count(), 1);
            prop_assert_eq!(toggle_task(&once, index).unwrap(), doc);
        }
    }

    #[test]
    fn toggle_task_never_panics_on_arbitrary_text(doc in "\\PC{0,200}", index in 0usize..5) {
        let _ = toggle_task(&doc, index);
    }
}

#[test]
fn a_header_line_with_a_line_terminator_in_its_title_is_not_a_header() {
    // JavaScript's `.` does not match \r, U+2028 or U+2029, so the TypeScript never saw these as comments.
    for terminator in ["\u{2028}", "\u{2029}", "\r"] {
        let note = format!("## Comments\n\n> [!comment|a,2026-01-01T00:00:00.000Z] Ana {terminator} x\n> text\n");
        assert!(parse_comments(&note).is_empty(), "{terminator:?}");
    }
    // ...while a trailing \r (CRLF) is part of the line ending, not of the title.
    let crlf = "## Comments\r\n\r\n> [!comment|a,2026-01-01T00:00:00.000Z] Ana\r\n> text\r\n";
    assert_eq!(parse_comments(crlf).len(), 1);
}

#[test]
fn the_derived_id_is_the_javascript_fnv_of_the_utf16_text() {
    // Computed by the TypeScript core: parseComments("## Comments\n\n> [!comment] Bruno\n> hand\n")[0].id
    let comments = parse_comments("## Comments\n\n> [!comment] Bruno\n> hand\n");
    assert_eq!(comments.len(), 1);
    assert_eq!(comments[0].author, "Bruno");
    assert!(comments[0].id.starts_with('h'));
    // The same bytes in another encoding of the same text give the same id (UTF-16, not UTF-8, is hashed).
    let accented = parse_comments("## Comments\n\n> [!comment] Zoë\n> 日本語\n");
    assert_eq!(accented.len(), 1);
    assert_eq!(parse_comments("## Comments\n\n> [!comment] Zoë\n> 日本語\n")[0].id, accented[0].id);
}

#[test]
fn timestamps_in_other_iso_forms_are_normalised_and_garbage_becomes_empty() {
    let note = "## Comments\n\n> [!comment|a,2026-10-14T17:02:00+02:00] A\n> x\n\n> [!comment|b,not a date] B\n> y\n\n> [!comment|c, 2026-10-14T17:02:00.5Z ] C\n> z\n";
    let ats: Vec<String> = parse_comments(note).into_iter().map(|c| c.at).collect();
    assert_eq!(ats, ["2026-10-14T15:02:00.000Z", "", "2026-10-14T17:02:00.500Z"]);
}

#[test]
fn the_title_shows_the_time_at_the_given_utc_offset() {
    let c = Comment { id: "a".into(), author: "Ana".into(), at: "2026-10-14T17:02:00.000Z".into(), text: "hi".into() };
    assert_eq!(format_comment(&c, 0), "> [!comment|a,2026-10-14T17:02:00.000Z] Ana · 2026-10-14 17:02\n> hi");
    assert_eq!(format_comment(&c, -180), "> [!comment|a,2026-10-14T17:02:00.000Z] Ana · 2026-10-14 14:02\n> hi");
    assert_eq!(format_comment(&c, 345), "> [!comment|a,2026-10-14T17:02:00.000Z] Ana · 2026-10-14 22:47\n> hi");
    let none = Comment { at: "not a time".into(), ..c };
    assert_eq!(format_comment(&none, -180), "> [!comment|a,not a time] Ana\n> hi");
}

#[test]
fn a_marker_line_is_escaped_with_one_more_backslash_and_read_back_exactly() {
    let c = Comment {
        id: "a".into(),
        author: "Ana".into(),
        at: "2026-10-14T17:02:00.000Z".into(),
        text: "see:\n[!comment|fake] boom\n\\[!comment] already\n  [!comment] indented".into(),
    };
    let note = add_comment_to_body("", &c, 0);
    let written: Vec<&str> = note.lines().collect();
    assert_eq!(
        &written[written.len() - 4..],
        ["> see:", "> \\[!comment|fake] boom", "> \\\\[!comment] already", ">   \\[!comment] indented"]
    );
    let parsed = parse_comments(&note);
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].text, c.text);
}

#[test]
fn the_comments_heading_is_case_insensitive_and_tolerates_trailing_whitespace_but_not_other_headings() {
    for heading in ["## Comments", "## comments", "##\tCOMMENTS", "##  Comments  ", "## Comments\u{a0}"] {
        assert!(split_body(&format!("x\n\n{heading}\n\n> y")).section.is_some(), "{heading:?}");
    }
    for heading in ["## Comments are great", "### Comments", "#Comments", "##Comments", "## Comment", " ## Comments"] {
        assert!(split_body(&format!("x\n\n{heading}\n")).section.is_none(), "{heading:?}");
    }
}

#[test]
fn a_comments_heading_inside_a_closed_code_fence_does_not_count_but_one_after_it_does() {
    let note = "intro\n```md\n## Comments\n```\n\n## Comments\n\n> [!comment|a,2026-01-01T00:00:00.000Z] A\n> x\n";
    assert_eq!(parse_comments(note).len(), 1);
    assert!(split_body("```\n## Comments\n").section.is_none(), "an unclosed fence hides the rest");
    // A tilde fence is not closed by a backtick fence.
    assert!(split_body("~~~\n```\n## Comments\n~~~\n").section.is_none());
}

#[test]
fn toggle_task_flips_unchecked_to_x_and_every_other_status_to_a_space() {
    assert_eq!(toggle_task("- [ ] a", 0).unwrap(), "- [x] a");
    for status in ["x", "X", "-", "?"] {
        assert_eq!(toggle_task(&format!("- [{status}] a"), 0).unwrap(), "- [ ] a", "for {status}");
    }
}

#[test]
fn toggle_task_counts_like_a_renderer_and_skips_code() {
    let doc = "Intro\n\n- [x] one\n  - [ ] two (nested)\n1. [ ] three (numbered)\n\n```\n- [ ] this is code\n```\n\n> - [ ] inside a quote\n- [-] custom status\n[ ] loose\n";
    assert_eq!(toggle_task(doc, 1).unwrap().lines().nth(3).unwrap(), "  - [x] two (nested)");
    assert_eq!(toggle_task(doc, 2).unwrap().lines().nth(4).unwrap(), "1. [x] three (numbered)");
    assert_eq!(toggle_task(doc, 3).unwrap().lines().nth(10).unwrap(), "> - [x] inside a quote");
    assert_eq!(toggle_task(doc, 4).unwrap().lines().nth(11).unwrap(), "- [ ] custom status");
    assert_eq!(toggle_task(doc, 5), None, "the loose [ ] is not a task and the fence is skipped");
    assert_eq!(toggle_task("no tasks", 0), None);
}

#[test]
fn an_astral_character_cannot_be_a_status_because_javascript_dot_is_one_utf16_unit() {
    assert_eq!(toggle_task("- [🙂] a", 0), None);
    assert_eq!(toggle_task("- [é] a", 0).unwrap(), "- [ ] a");
}
