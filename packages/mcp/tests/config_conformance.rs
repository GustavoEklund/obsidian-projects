//! Every case the TypeScript core produced for `config.ts`, replayed against `config.rs`.
mod common;

use common::{assert_json_eq, fixture};
use oprojects_mcp::config::{
    column_by_id, display_column, is_done_status, is_valid_prefix, normalize_config, normalize_folder, resolve_column,
    slugify_column_id,
};
use serde_json::{Value, json};

fn column_json(column: Option<&oprojects_mcp::types::Column>) -> Value {
    column.map_or(Value::Null, |c| serde_json::to_value(c).unwrap())
}

#[test]
fn replays_the_whole_corpus() {
    let corpus = fixture("config");
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for case in &corpus.cases {
        let kind = case.id.split(':').next().unwrap().to_string();
        *counts.entry(kind.clone()).or_default() += 1;
        let got = match kind.as_str() {
            "prefix" => json!(is_valid_prefix(case.input.as_str().unwrap())),
            "slug" => json!(slugify_column_id(case.input.as_str().unwrap())),
            "folder" => json!(normalize_folder(case.input.as_str().unwrap())),
            "normalize" => serde_json::to_value(normalize_config(&case.input)).unwrap(),
            "helper" => {
                let op = case.id.split(':').nth(1).unwrap();
                let config = normalize_config(&case.input["raw"]);
                let needle = case.input["needle"].as_str().unwrap();
                match op {
                    "by-id" => column_json(column_by_id(&config, needle)),
                    "display" => column_json(Some(display_column(&config, needle))),
                    "is-done" => json!(is_done_status(&config, needle)),
                    "resolve" => column_json(resolve_column(&config, needle)),
                    other => panic!("unknown helper {other}"),
                }
            }
            other => panic!("unknown kind of case: {other}"),
        };
        assert_json_eq(&case.id, &got, &case.expected);
    }
    for kind in ["prefix", "slug", "folder", "normalize", "helper"] {
        assert!(counts.get(kind).copied().unwrap_or(0) > 100, "few {kind} cases: {counts:?}");
    }
}
