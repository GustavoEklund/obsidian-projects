//! The pipeline end to end: the TypeScript core generated these constants, and the Rust model must match them.
mod common;

use common::{case, fixture};
use oprojects_mcp::types::{BoardConfig, CARD_TYPES, PRIORITIES};
use serde_json::json;

#[test]
fn priorities_match_the_core_in_value_and_order() {
    let corpus = fixture("smoke");
    let expected = &case(&corpus, "priorities").expected;
    let ours: Vec<&str> = PRIORITIES.iter().map(|p| p.as_str()).collect();
    assert_eq!(expected, &json!(ours));
}

#[test]
fn card_types_match_the_core_in_value_and_order() {
    let corpus = fixture("smoke");
    let expected = &case(&corpus, "card-types").expected;
    let ours: Vec<&str> = CARD_TYPES.iter().map(|t| t.as_str()).collect();
    assert_eq!(expected, &json!(ours));
}

#[test]
fn the_default_board_config_serializes_exactly_like_the_core_default() {
    let corpus = fixture("smoke");
    let expected = &case(&corpus, "default-config").expected;
    assert_eq!(expected, &serde_json::to_value(BoardConfig::default()).unwrap());
}

#[test]
fn parse_is_the_inverse_of_as_str() {
    for p in PRIORITIES {
        assert_eq!(oprojects_mcp::types::Priority::parse(p.as_str()), Some(p));
    }
    for t in CARD_TYPES {
        assert_eq!(oprojects_mcp::types::CardType::parse(t.as_str()), Some(t));
    }
    assert_eq!(oprojects_mcp::types::Priority::parse("urgent"), None);
}

#[test]
fn json_eq_treats_whole_numbers_alike_and_ignores_key_order() {
    use common::json_eq;
    assert!(json_eq(&json!(3), &json!(3.0)));
    assert!(json_eq(&json!({"a": [1, {"b": 2.0}], "c": null}), &json!({"c": null, "a": [1.0, {"b": 2}]})));
    assert!(!json_eq(&json!(3), &json!(3.5)));
    assert!(!json_eq(&json!([1, 2]), &json!([2, 1])));
    assert!(!json_eq(&json!({"a": 1}), &json!({"a": 1, "b": 2})));
    assert!(!json_eq(&json!("3"), &json!(3)));
}
