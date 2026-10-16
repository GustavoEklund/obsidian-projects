//! Replays the scenarios of `tests/fixtures/service.json`, which the TypeScript `CardService` produced: the same board,
//! the same notes, the same steps, the same clock and comment ids. Every step must return what the reference returned
//! (a card as JSON, a list of keys, a string) or fail with the same message, and the notes at the end must be the same:
//! byte for byte in the scenarios whose text is ordinary, as the cards they parse to in the others.
mod common;

use common::{fixture, json_eq};
use oprojects_mcp::api::{Board, CardQuery, CommentInput};
use oprojects_mcp::card::parse_card;
use oprojects_mcp::config::normalize_config;
use oprojects_mcp::error::Error;
use oprojects_mcp::service::{CardService, ServiceOptions};
use oprojects_mcp::storage::MemoryStorage;
use oprojects_mcp::types::{CardPatch, CardType, NewCardInput, Placement, Priority};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

fn string(v: &Value) -> String {
    v.as_str().unwrap_or_else(|| panic!("expected a string, got {v}")).to_string()
}

fn optional_string(object: &Value, key: &str) -> Option<String> {
    object.get(key).filter(|v| !v.is_null()).map(string)
}

fn strings(object: &Value, key: &str) -> Vec<String> {
    object.get(key).and_then(Value::as_array).map(|a| a.iter().map(string).collect()).unwrap_or_default()
}

fn card_type(v: &Value) -> CardType {
    CardType::parse(v.as_str().unwrap()).unwrap_or_else(|| panic!("the corpus uses only valid types, got {v}"))
}

fn priority(v: &Value) -> Priority {
    Priority::parse(v.as_str().unwrap()).unwrap_or_else(|| panic!("the corpus uses only valid priorities, got {v}"))
}

fn new_card(input: &Value) -> NewCardInput {
    NewCardInput {
        title: string(&input["title"]),
        status: optional_string(input, "status"),
        card_type: input.get("type").map(card_type),
        priority: input.get("priority").map(priority),
        assignee: optional_string(input, "assignee"),
        labels: input.get("labels").map(|_| strings(input, "labels")),
        due: optional_string(input, "due"),
        estimate: input.get("estimate").and_then(Value::as_f64),
        parent: optional_string(input, "parent"),
        body: optional_string(input, "body"),
        rank: optional_string(input, "rank"),
    }
}

/// `null` clears a field (`Some(None)`), a value sets it, a missing key leaves it alone.
fn nullable<T>(patch: &Value, key: &str, read: impl Fn(&Value) -> T) -> Option<Option<T>> {
    patch.get(key).map(|v| if v.is_null() { None } else { Some(read(v)) })
}

fn card_patch(patch: &Value) -> CardPatch {
    CardPatch {
        title: optional_string(patch, "title"),
        status: optional_string(patch, "status"),
        card_type: patch.get("type").map(card_type),
        priority: patch.get("priority").map(priority),
        assignee: nullable(patch, "assignee", string),
        labels: patch.get("labels").map(|_| strings(patch, "labels")),
        due: nullable(patch, "due", string),
        estimate: nullable(patch, "estimate", |v| v.as_f64().unwrap()),
        parent: nullable(patch, "parent", string),
        rank: optional_string(patch, "rank"),
        body: optional_string(patch, "body"),
    }
}

fn query(q: &Value) -> CardQuery {
    CardQuery {
        text: optional_string(q, "text"),
        status: strings(q, "status"),
        card_type: q
            .get("type")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(card_type).collect())
            .unwrap_or_default(),
        priority: q
            .get("priority")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(priority).collect())
            .unwrap_or_default(),
        assignee: strings(q, "assignee"),
        labels: strings(q, "labels"),
        parent: optional_string(q, "parent"),
        include_archived: q.get("includeArchived").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn keys(cards: Vec<Arc<oprojects_mcp::types::Card>>) -> Value {
    json!(cards.iter().map(|c| c.key.as_str()).collect::<Vec<_>>())
}

fn card_json(card: oprojects_mcp::types::Card) -> Value {
    serde_json::to_value(card).unwrap()
}

fn step(service: &CardService<Arc<MemoryStorage>>, op: &str, args: &Value) -> Result<Value, Error> {
    match op {
        "create" => service.create(new_card(&args["input"])).map(card_json),
        "update" => service.update(&string(&args["key"]), card_patch(&args["patch"])).map(card_json),
        "move" => {
            let placement = Placement {
                before: optional_string(&args["placement"], "before"),
                after: optional_string(&args["placement"], "after"),
            };
            service.move_card(&string(&args["key"]), &string(&args["column"]), placement).map(card_json)
        }
        "remove" => service.remove(&string(&args["key"])).map(card_json),
        "get" => service.get(&string(&args["key"])).map(card_json),
        "find" => service.find(&query(&args["query"])).map(keys),
        "list" => service.list().map(keys),
        "addComment" => {
            let comment = CommentInput {
                text: string(&args["comment"]["text"]),
                author: optional_string(&args["comment"], "author"),
            };
            service.add_comment(&string(&args["key"]), comment).map(card_json)
        }
        "editComment" => {
            service.edit_comment(&string(&args["key"]), &string(&args["id"]), &string(&args["text"])).map(card_json)
        }
        "removeComment" => service.remove_comment(&string(&args["key"]), &string(&args["id"])).map(card_json),
        "resolveKey" => service.resolve_key(&string(&args["input"])).map(Value::String),
        "checkStatus" => service.check_status(&string(&args["input"])).map(Value::String),
        other => panic!("unknown op {other}"),
    }
}

/// How the TypeScript names what it threw: a mistake of the caller is "validation", a missing card or comment is
/// "not_found", a path taken by someone else is "file_exists", and a plain `Error` is "other".
fn kind_matches(expected: &str, error: &Error) -> bool {
    match (expected, error) {
        ("validation", Error::Validation(_))
        | ("not_found", Error::NotFound(_))
        | ("file_exists", Error::FileExists(_)) => true,
        ("other", Error::Validation(_) | Error::NotFound(_) | Error::FileExists(_)) => false,
        ("other", _) => true,
        _ => false,
    }
}

fn replay(id: &str, scenario: &Value, expected: &Value) -> Vec<String> {
    let storage = Arc::new(MemoryStorage::new());
    for (path, content) in scenario["files"].as_object().unwrap() {
        storage.insert(path, content.as_str().unwrap());
    }
    let config = normalize_config(&scenario["config"]);
    let ids: Vec<String> = scenario["ids"].as_array().unwrap().iter().map(string).collect();
    let clock = Arc::new(AtomicI64::new(0));
    let next_id = Arc::new(AtomicUsize::new(0));
    let service = CardService::new(
        Arc::clone(&storage),
        config,
        ServiceOptions {
            clock: {
                let clock = Arc::clone(&clock);
                Arc::new(move || clock.load(Ordering::SeqCst))
            },
            new_id: Arc::new(move || {
                let n = next_id.fetch_add(1, Ordering::SeqCst);
                ids.get(n).cloned().unwrap_or_else(|| format!("z{}", n + 1))
            }),
            source: None,
            utc_offset_minutes: 0,
        },
    );

    let mut problems = Vec::new();
    let steps = scenario["steps"].as_array().unwrap();
    let outcomes = expected["outcomes"].as_array().unwrap();
    for (i, (s, outcome)) in steps.iter().zip(outcomes).enumerate() {
        clock.store(s["at"].as_i64().unwrap(), Ordering::SeqCst);
        let op = s["op"].as_str().unwrap();
        let label = format!("{id} step {i} ({op} {})", s["args"]);
        let got = step(&service, op, &s["args"]);
        match (outcome["ok"].as_bool().unwrap(), got) {
            (true, Ok(value)) => {
                if !json_eq(&value, &outcome["value"]) {
                    problems.push(format!("{label}\n   expected {}\n   actual   {value}", outcome["value"]));
                }
            }
            (true, Err(e)) => {
                problems.push(format!("{label}\n   expected {}\n   but it failed: {e}", outcome["value"]))
            }
            (false, Ok(value)) => {
                problems
                    .push(format!("{label}\n   expected the error {:?}\n   but it returned {value}", outcome["error"]));
            }
            (false, Err(e)) => {
                if e.to_string() != outcome["error"].as_str().unwrap()
                    || !kind_matches(outcome["kind"].as_str().unwrap(), &e)
                {
                    problems.push(format!(
                        "{label}\n   expected the {} error {:?}\n   actual   {e:?} ({e})",
                        outcome["kind"], outcome["error"]
                    ));
                }
            }
        }
    }

    // the notes at the end
    let notes = storage.snapshot();
    let files = expected["files"].as_array().unwrap();
    let want: Vec<&str> = files.iter().map(|f| f["path"].as_str().unwrap()).collect();
    let have: Vec<&str> = notes.keys().map(String::as_str).collect();
    if want != have {
        problems.push(format!("{id}: the vault ends with {have:?}, the reference with {want:?}"));
    }
    let exact = expected["exactText"].as_bool().unwrap();
    for file in files {
        let path = file["path"].as_str().unwrap();
        let Some(text) = notes.get(path) else { continue };
        if exact && file["text"].as_str() != Some(text.as_str()) {
            problems
                .push(format!("{id} {path}: the note differs\n   expected {:?}\n   actual   {text:?}", file["text"]));
        }
        let card = parse_card(path, text).map_or(Value::Null, |c| serde_json::to_value(c).unwrap());
        if !json_eq(&card, &file["card"]) {
            problems.push(format!(
                "{id} {path}: the note reads as a different card\n   expected {}\n   actual   {card}",
                file["card"]
            ));
        }
    }
    problems
}

#[test]
fn every_scenario_ends_exactly_where_the_typescript_service_did() {
    let corpus = fixture("service");
    let (mut scenarios, mut steps) = (0, 0);
    let mut problems = Vec::new();
    for case in &corpus.cases {
        scenarios += 1;
        steps += case.input["steps"].as_array().unwrap().len();
        problems.extend(replay(&case.id, &case.input, &case.expected));
    }
    assert!(scenarios > 150 && steps > 2000, "the corpus looks truncated: {scenarios} scenarios, {steps} steps");
    assert!(
        problems.is_empty(),
        "{} problem(s) in {scenarios} scenarios ({steps} steps); the first ones:\n{}",
        problems.len(),
        problems.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn the_corpus_exercises_what_it_claims_to() {
    let corpus = fixture("service");
    let mut ops: std::collections::BTreeMap<String, usize> =
        Map::new().into_iter().map(|(k, _): (String, Value)| (k, 0)).collect();
    let mut errors = 0;
    for case in &corpus.cases {
        let steps = case.input["steps"].as_array().unwrap();
        let outcomes = case.expected["outcomes"].as_array().unwrap();
        assert_eq!(steps.len(), outcomes.len(), "{}", case.id);
        for (s, o) in steps.iter().zip(outcomes) {
            *ops.entry(s["op"].as_str().unwrap().to_string()).or_default() += 1;
            errors += usize::from(!o["ok"].as_bool().unwrap());
        }
    }
    for op in
        ["create", "update", "move", "remove", "get", "find", "list", "addComment", "editComment", "removeComment"]
    {
        assert!(ops.get(op).copied().unwrap_or(0) > 40, "few {op} steps: {ops:?}");
    }
    assert!(errors > 300, "few error steps: {errors}");
}
