//! Properties of the board configuration, whatever JSON it is given.
use oprojects_mcp::config::{
    column_by_id, display_column, is_done_status, is_valid_prefix, normalize_config, normalize_folder, resolve_column,
    slugify_column_id,
};
use oprojects_mcp::types::BoardConfig;
use proptest::prelude::*;
use serde_json::{Map, Value, json};

/// Any JSON value, nested a few levels deep, with the sort of strings a hand-edited file has.
fn json_value() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i32>().prop_map(|n| json!(n)),
        (-1.0e6f64..1.0e6).prop_map(|f| json!(f)),
        "\\PC{0,12}".prop_map(Value::String),
        prop::sample::select(vec![
            "",
            " ",
            "WEB",
            "web",
            "Cards",
            "../..",
            "A B",
            "Zoë",
            "\u{85}x",
            "\u{feff}x",
            "todo"
        ])
        .prop_map(|s| Value::String(s.to_string())),
    ];
    leaf.prop_recursive(3, 24, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..5).prop_map(Value::Array),
            prop::collection::vec(
                (
                    prop::sample::select(vec![
                        "folder",
                        "prefix",
                        "columns",
                        "hideDoneAfterDays",
                        "me",
                        "members",
                        "id",
                        "name",
                        "done",
                        "wip",
                        "other",
                    ]),
                    inner
                ),
                0..6
            )
            .prop_map(|pairs| Value::Object(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect::<Map<_, _>>())),
        ]
    })
}

fn is_column_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 600, failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn normalize_config_never_panics_and_always_returns_a_valid_config(raw in json_value()) {
        let config = normalize_config(&raw);
        prop_assert!(is_valid_prefix(&config.prefix), "prefix {:?}", config.prefix);
        prop_assert!(!config.folder.is_empty());
        prop_assert!(!config.folder.split('/').any(|p| p == ".." || p == "." || p.is_empty()));
        prop_assert!(!config.columns.is_empty());
        let ids: Vec<&str> = config.columns.iter().map(|c| c.id.as_str()).collect();
        let unique: std::collections::HashSet<&&str> = ids.iter().collect();
        prop_assert_eq!(unique.len(), ids.len(), "column ids must be unique: {:?}", ids);
        prop_assert!(ids.iter().all(|id| is_column_id(id)), "invalid column id in {:?}", ids);
        let members: std::collections::HashSet<&String> = config.members.iter().collect();
        prop_assert_eq!(members.len(), config.members.len());
        prop_assert!(config.members.iter().all(|m| !m.is_empty()));
    }

    #[test]
    fn normalizing_twice_changes_nothing_and_survives_a_json_round_trip(raw in json_value()) {
        let once = normalize_config(&raw);
        let again = normalize_config(&serde_json::to_value(&once).unwrap());
        prop_assert_eq!(&again, &once);
        let text = serde_json::to_string(&once).unwrap();
        prop_assert_eq!(normalize_config(&serde_json::from_str::<Value>(&text).unwrap()), once);
    }

    #[test]
    fn the_config_serialises_to_what_the_typescript_reads(raw in json_value()) {
        let config = normalize_config(&raw);
        let value = serde_json::to_value(&config).unwrap();
        let keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        prop_assert_eq!(keys, ["folder", "prefix", "columns", "hideDoneAfterDays", "me", "members"]);
        let back: BoardConfig = serde_json::from_value(value).unwrap();
        prop_assert_eq!(back, config);
    }

    #[test]
    fn slugify_always_gives_a_valid_idempotent_id(name in "\\PC{0,30}") {
        let slug = slugify_column_id(&name);
        prop_assert!(slug == "column" || is_column_id(&slug), "{slug}");
        prop_assert!(!slug.starts_with('-') && !slug.ends_with('-') && !slug.contains("--"));
        prop_assert_eq!(slugify_column_id(&slug), slug);
    }

    #[test]
    fn normalize_folder_can_never_leave_the_vault_and_is_idempotent(folder in "[a-z./\\\\ é]{0,30}") {
        let clean = normalize_folder(&folder);
        prop_assert!(!clean.split('/').any(|p| p == ".."));
        prop_assert!(!clean.starts_with('/') && !clean.ends_with('/') && !clean.contains("//") && !clean.contains('\\'));
        prop_assert_eq!(normalize_folder(&clean), clean);
    }

    #[test]
    fn is_valid_prefix_agrees_with_the_documented_pattern(s in "\\PC{0,12}") {
        let expected = s.len() >= 2
            && s.len() <= 10
            && s.starts_with(|c: char| c.is_ascii_uppercase())
            && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
        prop_assert_eq!(is_valid_prefix(&s), expected);
    }

    #[test]
    fn column_lookups_never_panic_and_agree_with_each_other(raw in json_value(), needle in "\\PC{0,10}") {
        let config = normalize_config(&raw);
        let _ = column_by_id(&config, &needle);
        let shown = display_column(&config, &needle);
        prop_assert!(config.columns.iter().any(|c| c.id == shown.id));
        if let Some(found) = resolve_column(&config, &needle) {
            prop_assert!(config.columns.iter().any(|c| c.id == found.id));
        }
        prop_assert_eq!(is_done_status(&config, &needle), column_by_id(&config, &needle).is_some_and(|c| c.done));
    }
}

#[test]
fn defaults_for_anything_that_is_not_an_object() {
    for junk in [json!(null), json!(0), json!("text"), json!(true), json!([]), json!([1, 2])] {
        assert_eq!(normalize_config(&junk), BoardConfig::default(), "for {junk}");
    }
}

#[test]
fn a_fraction_of_a_wip_limit_floors_to_zero_but_is_kept() {
    // The original keeps `wip` when the number is positive and then floors it, so 0.5 becomes 0, not "no limit".
    let config = normalize_config(
        &json!({"columns": [{"id": "a", "name": "A", "wip": 0.5}, {"id": "b", "name": "B", "wip": 0}]}),
    );
    assert_eq!(config.columns[0].wip, Some(0));
    assert_eq!(config.columns[1].wip, None);
}

#[test]
fn huge_numbers_saturate_instead_of_wrapping() {
    let config =
        normalize_config(&json!({"hideDoneAfterDays": 1e30, "columns": [{"id": "a", "name": "A", "wip": 1e30}]}));
    assert_eq!(config.hide_done_after_days, u32::MAX);
    assert_eq!(config.columns[0].wip, Some(u32::MAX));
}

#[test]
fn trimming_follows_javascript_not_rust() {
    // NEL is not JavaScript whitespace (kept), the byte order mark is (removed).
    let config =
        normalize_config(&json!({"me": "\u{feff}Ana\u{feff}", "members": ["\u{85}Bruno", "\u{a0}Carla\u{3000}"]}));
    assert_eq!(config.me, "Ana");
    assert_eq!(config.members, ["\u{85}Bruno", "Carla"]);
}

#[test]
fn an_upper_cased_prefix_uses_unicode_case_mapping_like_javascript() {
    assert_eq!(normalize_config(&json!({"prefix": "web"})).prefix, "WEB");
    // "ß".toUpperCase() is "SS" in JavaScript: valid, so the prefix becomes "SS".
    assert_eq!(normalize_config(&json!({"prefix": "ß"})).prefix, "SS");
}

#[test]
fn the_default_columns_are_not_shared_between_results() {
    let mut first = normalize_config(&json!({}));
    first.columns[0].name = "Hacked".into();
    first.columns.push(oprojects_mcp::types::Column {
        id: "extra".into(),
        name: "Extra".into(),
        done: false,
        wip: None,
    });
    assert_eq!(normalize_config(&json!({})).columns[0].name, "To Do");
    assert_eq!(oprojects_mcp::config::default_columns().len(), 4);
}

#[test]
fn unknown_keys_and_prototype_pollution_attempts_are_ignored() {
    let raw: Value = serde_json::from_str(
        r#"{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "extra": 1, "prefix": "OK"}"#,
    )
    .unwrap();
    let config = normalize_config(&raw);
    assert_eq!(config.prefix, "OK");
    assert_eq!(serde_json::to_value(&config).unwrap().as_object().unwrap().len(), 6);
}

#[test]
fn the_documented_examples_slugify_as_expected() {
    assert_eq!(slugify_column_id("In Review"), "in-review");
    assert_eq!(slugify_column_id("  Zoë  Müller!! "), "zoe-muller");
    assert_eq!(slugify_column_id("Café / Bar"), "cafe-bar");
    assert_eq!(slugify_column_id("WIP_2"), "wip-2");
    for nothing in ["", "   ", "!!!", "日本語", "---", "🙂"] {
        assert_eq!(slugify_column_id(nothing), "column");
    }
}
