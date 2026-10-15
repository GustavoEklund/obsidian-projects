//! Every case the TypeScript core produced for `body.ts`, replayed against `body.rs`.
mod common;

use common::{assert_json_eq, fixture};
use oprojects_mcp::body::{
    add_comment_to_body, clean_author, edit_comment_in_body, format_comment, format_section, join_body, parse_comments,
    remove_comment_from_body, split_body, toggle_task,
};
use oprojects_mcp::types::Comment;
use serde_json::{Value, json};

fn comment(v: &Value) -> Comment {
    serde_json::from_value(v.clone()).expect("a comment")
}

fn optional(s: Option<String>) -> Value {
    s.map_or(Value::Null, Value::String)
}

#[test]
fn replays_the_whole_corpus() {
    let corpus = fixture("body");
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for case in &corpus.cases {
        let kind = case.id.split(':').next().unwrap().to_string();
        *counts.entry(kind.clone()).or_default() += 1;
        let input = &case.input;
        let got = match kind.as_str() {
            "split" => {
                let s = split_body(input.as_str().unwrap());
                json!({"description": s.description, "section": s.section})
            }
            "join" => json!(join_body(input["description"].as_str().unwrap(), input["section"].as_str())),
            "parse" => json!(parse_comments(input.as_str().unwrap())),
            "clean-author" => json!(clean_author(input.as_str().unwrap())),
            "format" => {
                let text = format_comment(&comment(&input["comment"]), input["offset"].as_i64().unwrap() as i32);
                json!({"zone": case.expected["zone"], "text": text})
            }
            "section" => {
                let list: Vec<Comment> = input["comments"].as_array().unwrap().iter().map(comment).collect();
                json!(format_section(&list, input["offset"].as_i64().unwrap() as i32))
            }
            "add" => json!(add_comment_to_body(
                input["body"].as_str().unwrap(),
                &comment(&input["comment"]),
                input["offset"].as_i64().unwrap() as i32
            )),
            "edit" => optional(edit_comment_in_body(
                input["body"].as_str().unwrap(),
                input["id"].as_str().unwrap(),
                input["text"].as_str().unwrap(),
            )),
            "remove" => {
                optional(remove_comment_from_body(input["body"].as_str().unwrap(), input["id"].as_str().unwrap()))
            }
            "toggle" => {
                optional(toggle_task(input["markdown"].as_str().unwrap(), input["index"].as_u64().unwrap() as usize))
            }
            other => panic!("unknown kind of case: {other}"),
        };
        assert_json_eq(&case.id, &got, &case.expected);
    }
    for kind in ["split", "join", "parse", "clean-author", "format", "section", "add", "edit", "remove", "toggle"] {
        assert!(counts.get(kind).copied().unwrap_or(0) > 30, "few {kind} cases: {counts:?}");
    }
}
