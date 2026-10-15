//! Every case the TypeScript core produced for `card.ts`, replayed against `card.rs`.
mod common;

use common::{assert_json_eq, fixture, json_eq};
use oprojects_mcp::card::{
    apply_patch, count_checklist, is_valid_date, key_number, new_card_content, normalize_labels, parse_card, same_card,
};
use oprojects_mcp::types::{Card, CardPatch, CardType, Priority};
use serde_json::{Value, json};

fn card_of(v: &Value) -> Card {
    serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("not a card: {e}: {v}"))
}

fn patch_of(v: &Value) -> CardPatch {
    let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    // present as null clears, absent leaves alone
    let nullable = |k: &str| v.get(k).map(|x| x.as_str().map(str::to_string));
    CardPatch {
        title: text("title"),
        status: text("status"),
        card_type: text("type").and_then(|t| CardType::parse(&t)),
        priority: text("priority").and_then(|p| Priority::parse(&p)),
        assignee: nullable("assignee"),
        labels: v
            .get("labels")
            .map(|l| l.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()),
        due: nullable("due"),
        estimate: v.get("estimate").map(Value::as_f64),
        parent: nullable("parent"),
        rank: text("rank"),
        body: text("body"),
    }
}

#[test]
fn replays_the_whole_corpus() {
    let corpus = fixture("card");
    let mut counts = std::collections::BTreeMap::<&str, usize>::new();
    let mut exact = 0;
    for case in &corpus.cases {
        let kind = case.id.split(':').next().unwrap();
        *counts.entry(kind).or_default() += 1;
        match kind {
            "date" => assert_json_eq(&case.id, &json!(is_valid_date(case.input.as_str().unwrap())), &case.expected),
            "key" => {
                let got = key_number(case.input["key"].as_str().unwrap(), case.input["prefix"].as_str().unwrap());
                assert_json_eq(&case.id, &got.map_or(Value::Null, |n| json!(n)), &case.expected);
            }
            "checklist" => {
                let got = count_checklist(case.input.as_str().unwrap());
                assert_json_eq(&case.id, &json!({"done": got.done, "total": got.total}), &case.expected);
            }
            "labels" => {
                let labels: Vec<&str> = case.input.as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
                assert_json_eq(&case.id, &json!(normalize_labels(&labels)), &case.expected);
            }
            "parse" => {
                let got = parse_card(case.input["path"].as_str().unwrap(), case.input["content"].as_str().unwrap());
                let got = got.map_or(Value::Null, |c| serde_json::to_value(c).unwrap());
                assert!(case.expected["ok"] == json!(true), "{}: the core threw: {}", case.id, case.expected);
                assert!(
                    json_eq(&got, &case.expected["value"]),
                    "case \"{}\" differs\n  note     {}\n  expected {}\n  actual   {}",
                    case.id,
                    serde_json::to_string(&case.input["content"]).unwrap(),
                    case.expected["value"],
                    got
                );
            }
            "new" => {
                let card = card_of(&case.input);
                let text = new_card_content(&card, 0).unwrap_or_else(|e| panic!("{}: {e}", case.id));
                // what the core wrote reads as a card, and so does what this crate wrote, and it is the same card
                let reread = parse_card(&card.path, &text).map_or(Value::Null, |c| serde_json::to_value(c).unwrap());
                assert!(
                    json_eq(&reread, &case.expected["parsed"]["value"]),
                    "case \"{}\": the note this crate wrote reads differently\n  wrote    {text:?}\n  core     {}\n  rust     {reread}",
                    case.id,
                    case.expected["text"]
                );
                if case.expected["exact"] == json!(true) {
                    exact += 1;
                    assert_eq!(text, case.expected["text"].as_str().unwrap(), "case {}", case.id);
                }
            }
            "same" => {
                let got = same_card(&card_of(&case.input["a"]), &card_of(&case.input["b"]));
                assert_json_eq(&case.id, &json!(got), &case.expected);
            }
            "apply" => {
                let got = apply_patch(&card_of(&case.input["card"]), &patch_of(&case.input["patch"]));
                assert_json_eq(&case.id, &serde_json::to_value(got).unwrap(), &case.expected);
            }
            other => panic!("unknown kind {other}"),
        }
    }
    for kind in ["date", "key", "checklist", "labels", "parse", "new", "same", "apply"] {
        assert!(counts.get(kind).copied().unwrap_or(0) >= 100, "few {kind} cases: {counts:?}");
    }
    assert!(exact > 40, "few byte-exact cases: {exact}");
}
