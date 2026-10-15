//! Every case the TypeScript core produced for `frontmatter.ts`, replayed against `frontmatter.rs`.
mod common;

use common::{assert_json_eq, fixture};
use oprojects_mcp::frontmatter::{parse_frontmatter, patch_frontmatter, split_frontmatter};
use serde_json::{Value, json};

#[test]
fn splitting_agrees_with_the_core() {
    let corpus = fixture("frontmatter");
    let mut n = 0;
    for case in corpus.cases.iter().filter(|c| c.id.starts_with("split:")) {
        let s = split_frontmatter(case.input.as_str().unwrap());
        let got = json!({"yaml": s.yaml, "body": s.body});
        assert_json_eq(&case.id, &got, &case.expected);
        n += 1;
    }
    assert!(n > 150, "few split cases: {n}");
}

#[test]
fn reading_agrees_with_the_core() {
    let corpus = fixture("frontmatter");
    let (mut agreed, mut core_threw, mut mismatches) = (0, 0, Vec::new());
    for case in corpus.cases.iter().filter(|c| c.id.starts_with("parse:")) {
        let got = Value::Object(parse_frontmatter(case.input.as_str().unwrap()));
        if case.expected["ok"] == json!(true) {
            if common::json_eq(&got, &case.expected["value"]) {
                agreed += 1;
            } else {
                mismatches.push(format!(
                    "{}\n  input    {}\n  expected {}\n  actual   {}",
                    case.id,
                    serde_json::to_string(&case.input).unwrap(),
                    case.expected["value"],
                    got
                ));
            }
        } else {
            // The TypeScript throws (a dangling alias is only found by `toJS`); this crate reads it as no frontmatter.
            core_threw += 1;
            assert_eq!(got, json!({}), "case {} where the core throws", case.id);
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} of {} cases differ:\n{}",
        mismatches.len(),
        agreed + mismatches.len(),
        mismatches.join("\n")
    );
    assert!(agreed > 250, "few parse cases: {agreed}");
    assert!(core_threw >= 1, "the corpus should show where the core throws");
}

/// `!!binary`, `!!set` and the like: the core makes a Buffer or a Set, this crate an empty object. Neither is a string,
/// a number or a boolean, which is all a card field can be, so the two agree on everything that matters.
#[test]
fn exotic_tags_read_as_objects_like_the_core() {
    let corpus = fixture("frontmatter");
    let mut n = 0;
    for case in corpus.cases.iter().filter(|c| c.id.starts_with("exotic:")) {
        let got = parse_frontmatter(case.input.as_str().unwrap());
        let expected = case.expected["value"].as_object().expect("the core reads exotic tags");
        assert_eq!(got.keys().collect::<Vec<_>>(), expected.keys().collect::<Vec<_>>(), "keys of {}", case.id);
        for (key, want) in expected {
            if want.is_object() {
                assert_eq!(got[key], json!({}), "{}: {key} should be an empty object", case.id);
            } else {
                assert_json_eq(&format!("{}/{key}", case.id), &got[key], want);
            }
        }
        n += 1;
    }
    assert!(n >= 3, "few exotic cases: {n}");
}

fn patch_of(case: &common::Case) -> (String, Vec<(String, Value)>, Option<String>) {
    let content = case.input["content"].as_str().unwrap().to_string();
    let patch = case.input["patch"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| (pair[0].as_str().unwrap().to_string(), pair[1].clone()))
        .collect();
    (content, patch, case.input["body"].as_str().map(str::to_string))
}

#[test]
fn patching_agrees_with_the_core() {
    let corpus = fixture("frontmatter");
    let (mut checked, mut exact, mut rejected, mut lenient, mut problems) = (0, 0, 0, 0, Vec::new());
    for case in corpus.cases.iter().filter(|c| c.id.starts_with("patch:")) {
        let (content, patch, body) = patch_of(case);
        let got = patch_frontmatter(&content, &patch, body.as_deref());
        let describe = || {
            format!(
                "{}\n  content  {}\n  patch    {}\n  body     {:?}",
                case.id,
                serde_json::to_string(&content).unwrap(),
                serde_json::to_string(&patch).unwrap(),
                body
            )
        };
        if case.expected["lenient"] == json!(true) {
            // tags and aliases: the result must say what was asked for, whatever the core did with the tag
            lenient += 1;
            let Ok(text) = got else { continue };
            let mut want = parse_frontmatter(&content);
            for (key, value) in &patch {
                if value.is_null() {
                    want.remove(key);
                } else {
                    want.insert(key.clone(), value.clone());
                }
            }
            let reread = Value::Object(parse_frontmatter(&text));
            if !common::json_eq(&reread, &Value::Object(want.clone())) {
                problems.push(format!(
                    "{}\n  wrote {text:?}\n  reads as {reread}\n  wanted {}",
                    describe(),
                    Value::Object(want)
                ));
            }
            continue;
        }
        if case.expected["ok"] == json!(false) {
            rejected += 1;
            match got {
                Err(e) => {
                    let not_map = e.to_string().contains("key: value");
                    if not_map != (case.expected["kind"] == json!("not-map")) {
                        problems.push(format!("{}\n  wrong kind of error: {e}", describe()));
                    }
                }
                Ok(text) => {
                    problems.push(format!("{}\n  the core refuses this note, this crate wrote {text:?}", describe()))
                }
            }
            continue;
        }
        let text = match got {
            Ok(text) => text,
            Err(e) => {
                problems.push(format!("{}\n  the core wrote this, this crate refused: {e}", describe()));
                continue;
            }
        };
        checked += 1;
        let parsed = &case.expected["parsed"];
        let reread = Value::Object(parse_frontmatter(&text));
        if parsed["ok"] == json!(true) && !common::json_eq(&reread, &parsed["value"]) {
            problems.push(format!(
                "{}\n  wrote {text:?}\n  reads as {reread}\n  core reads {}",
                describe(),
                parsed["value"]
            ));
        } else if split_frontmatter(&text).body != case.expected["body"].as_str().unwrap() {
            problems.push(format!(
                "{}\n  wrote {text:?}\n  body differs from the core's {}",
                describe(),
                case.expected["body"]
            ));
        } else if case.expected["exact"] == json!(true) {
            exact += 1;
            if text != case.expected["text"].as_str().unwrap() {
                problems.push(format!("{}\n  wrote    {text:?}\n  core did {}", describe(), case.expected["text"]));
            }
        }
    }
    assert!(problems.is_empty(), "{} problems:\n{}", problems.len(), problems.join("\n"));
    assert!(
        checked > 250 && exact > 100 && rejected > 30 && lenient > 5,
        "few patch cases: {checked} written, {exact} exact, {rejected} refused, {lenient} with tags or aliases"
    );
}
