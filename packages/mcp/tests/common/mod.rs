//! Loads the conformance corpus that `npm run conformance` generates from the TypeScript core.
#![allow(dead_code)] // each test file uses a different part of this module
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct Case {
    pub id: String,
    pub input: Value,
    pub expected: Value,
}

#[derive(Debug, Deserialize)]
pub struct Fixture {
    pub description: String,
    pub cases: Vec<Case>,
}

pub fn fixture(name: &str) -> Fixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("cannot read {}: {e}. Run `npm run conformance` from the repo root.", path.display())
    });
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not a valid fixture: {e}", path.display()))
}

/// The case with this id, panicking with a useful message when the corpus has no such case.
pub fn case<'a>(fixture: &'a Fixture, id: &str) -> &'a Case {
    fixture.cases.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("no case \"{id}\" in the fixture"))
}

/// JSON equality for conformance tests. JavaScript has one number type, so the corpus writes `3`, while Rust may
/// produce `3.0`; both mean the same value, and objects are compared regardless of key order (as `Value` already does).
pub fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

/// Asserts `json_eq`, printing both values as pretty JSON and the case id on failure.
pub fn assert_json_eq(id: &str, actual: &Value, expected: &Value) {
    assert!(
        json_eq(actual, expected),
        "case \"{id}\" differs\n--- expected (from the TypeScript core)\n{}\n--- actual (Rust)\n{}",
        serde_json::to_string_pretty(expected).unwrap(),
        serde_json::to_string_pretty(actual).unwrap()
    );
}
