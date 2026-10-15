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
