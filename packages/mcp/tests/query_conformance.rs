//! Replays `tests/fixtures/query.json`, which `npm run conformance` generates by running the TypeScript `query.ts`.
//! Every case here is a result the reference produced; this crate must produce the same.
mod common;

use common::{assert_json_eq, fixture};
use oprojects_mcp::query::{
    CardFilter, CivilDate, DueState, Now, PreparedFilter, compare_cards, due_state, filter_cards, group_by_column,
    haystack, is_archived_done, local_date, matches_filter, normalize_text, parse_timestamp_ms, priority_weight,
    rank_for_placement, sort_cards,
};
use oprojects_mcp::types::{BoardConfig, Card, Placement, Priority};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;

fn from<T: serde::de::DeserializeOwned>(value: &Value, what: &str) -> T {
    serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("bad {what}: {e}\n{value}"))
}

fn keys<'a>(cards: impl IntoIterator<Item = &'a Card>) -> Vec<String> {
    cards.into_iter().map(|c| c.key.clone()).collect()
}

/// A card with every field at its default, then the given fields on top.
fn card_with(fields: Value) -> Card {
    let mut base = json!({
        "key": "OP-1", "path": "Cards/OP-1.md", "title": "OP-1", "status": "todo", "type": "task", "priority": "medium",
        "labels": [], "rank": "V", "created": "2026-01-01T00:00:00.000Z", "updated": "2026-01-01T00:00:00.000Z",
        "body": "", "checklist": { "done": 0, "total": 0 }, "comments": []
    });
    for (k, v) in fields.as_object().expect("fields must be an object") {
        if !v.is_null() {
            base[k] = v.clone();
        }
    }
    from(&base, "card")
}

fn board(id: &str, input: &Value, expected: &Value) {
    let config: BoardConfig = from(&input["config"], "config");
    let cards: Vec<Card> = from(&input["cards"], "cards");
    let filters: Vec<CardFilter> = from(&input["filters"], "filters");

    for (i, filter) in filters.iter().enumerate() {
        let expected_keys = &expected["filter"][i];
        let got = keys(filter_cards(&cards, filter, &config));
        assert_json_eq(&format!("{id}/filter[{i}]"), &json!(got), expected_keys);

        // The other ways of asking give the same answer: card by card, prepared once, with a cached haystack.
        let one_by_one = keys(cards.iter().filter(|c| matches_filter(c, filter, &config)));
        assert_eq!(one_by_one, got, "{id}/filter[{i}]: matches_filter disagrees with filter_cards");
        let prepared = PreparedFilter::new(filter);
        let cached: Vec<String> =
            cards.iter().filter(|c| prepared.matches(c, &config, Some(&haystack(c)))).map(|c| c.key.clone()).collect();
        assert_eq!(cached, got, "{id}/filter[{i}]: a cached haystack changes the result");
    }

    let sorted = sort_cards(&cards, &config);
    assert_json_eq(&format!("{id}/sort"), &json!(keys(&sorted)), &expected["sort"]);
    // sorting references or shared cards is the same thing, and the comparator agrees with the sort
    let refs: Vec<&Card> = cards.iter().collect();
    assert_eq!(keys(sort_cards(&refs, &config)), keys(&sorted), "{id}: sorting references");
    let shared: Vec<Arc<Card>> = cards.iter().cloned().map(Arc::new).collect();
    assert_eq!(keys(sort_cards(&shared, &config).iter().map(|c| c.as_ref())), keys(&sorted), "{id}: sorting Arcs");
    let cmp = compare_cards(&config);
    assert!(sorted.windows(2).all(|w| cmp(&w[0], &w[1]).is_le()), "{id}: compare_cards disagrees with sort_cards");

    let groups = group_by_column(&cards, &config);
    let got: Vec<Value> = groups.iter().map(|g| json!({ "column": g.column, "cards": keys(&g.cards) })).collect();
    assert_json_eq(&format!("{id}/group"), &json!(got), &expected["group"]);
}

fn normalize(id: &str, input: &Value, expected: &Value) {
    let texts: Vec<String> = from(&input["texts"], "texts");
    for (i, text) in texts.iter().enumerate() {
        assert_eq!(&json!(normalize_text(text)), &expected[i], "{id}[{i}]: normalize_text({text:?})");
    }
}

fn now_from(value: &Value) -> Now {
    let local = |k: &str| value[k].as_i64().unwrap_or(1);
    Now {
        epoch_ms: value["epoch_ms"].as_i64().expect("epoch_ms"),
        local_date: CivilDate::new(local("year") as i32, local("month") as u32, local("day") as u32),
    }
}

fn due(id: &str, input: &Value, expected: &Value) {
    let config: BoardConfig = from(&input["config"], "config");
    let now = now_from(&input["now"]);
    for (i, c) in input["cards"].as_array().unwrap().iter().enumerate() {
        let card = card_with(json!({ "status": c["status"], "due": c["due"] }));
        let got = match due_state(&card, &config, &now) {
            None => Value::Null,
            Some(DueState::Overdue) => json!("overdue"),
            Some(DueState::Soon) => json!("soon"),
            Some(DueState::Later) => json!("later"),
        };
        assert_eq!(
            got,
            expected[i],
            "{id}[{i}]: due {:?}, status {:?}, today {}",
            c["due"],
            c["status"],
            local_date(now.local_date)
        );
    }
}

fn archived(id: &str, input: &Value, expected: &Value) {
    let config: BoardConfig = from(&input["config"], "config");
    let now = Now { epoch_ms: input["now"]["epoch_ms"].as_i64().unwrap(), local_date: CivilDate::new(1970, 1, 1) };
    for (i, c) in input["cards"].as_array().unwrap().iter().enumerate() {
        let card = card_with(json!({ "status": c["status"], "resolved": c["resolved"], "updated": c["updated"] }));
        assert_eq!(
            &json!(is_archived_done(&card, &config, &now)),
            &expected[i],
            "{id}[{i}]: status {:?}, resolved {:?}, updated {:?}, hide after {} days",
            c["status"],
            c["resolved"],
            c["updated"],
            config.hide_done_after_days
        );
    }
}

fn timestamps(id: &str, input: &Value, expected: &Value) {
    for (i, text) in input["texts"].as_array().unwrap().iter().enumerate() {
        let text = text.as_str().unwrap();
        let got = parse_timestamp_ms(text).map_or(Value::Null, |ms| json!(ms));
        assert_eq!(got, expected[i], "{id}[{i}]: parse_timestamp_ms({text:?})");
    }
}

fn local_dates(id: &str, input: &Value, expected: &Value) {
    for (i, d) in input["dates"].as_array().unwrap().iter().enumerate() {
        let [y, m, day] = [0, 1, 2].map(|n| d[n].as_i64().unwrap());
        let got = local_date(CivilDate::new(y as i32, m as u32, day as u32));
        assert_eq!(json!(got), expected[i], "{id}[{i}]");
    }
}

fn weights(id: &str, input: &Value, expected: &Value) {
    for (i, p) in input["priorities"].as_array().unwrap().iter().enumerate() {
        let priority = Priority::parse(p.as_str().unwrap()).expect("a known priority");
        assert_eq!(json!(priority_weight(priority)), expected[i], "{id}[{i}]");
    }
}

fn placements(id: &str, input: &Value, expected: &Value) {
    let config: BoardConfig = from(&input["config"], "config");
    let cards: Vec<Card> = from(&input["cards"], "cards");
    for (i, m) in input["moves"].as_array().unwrap().iter().enumerate() {
        let side = |k: &str| m["placement"].get(k).and_then(Value::as_str).map(str::to_owned);
        let placement = Placement { before: side("before"), after: side("after") };
        let got = match rank_for_placement(
            &cards,
            &config,
            m["moving"].as_str().unwrap(),
            m["status"].as_str().unwrap(),
            &placement,
        ) {
            Ok(rank) => json!({ "rank": rank }),
            Err(e) => json!({ "error": e.to_string() }),
        };
        assert_json_eq(&format!("{id}[{i}] move {m}"), &got, &expected[i]);
    }
}

#[test]
fn every_case_matches_the_typescript_core() {
    let corpus = fixture("query");
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for case in &corpus.cases {
        let kind = case.input["fn"].as_str().expect("every case names its function").to_owned();
        match kind.as_str() {
            "board" => board(&case.id, &case.input, &case.expected),
            "normalize_text" => normalize(&case.id, &case.input, &case.expected),
            "due_state" => due(&case.id, &case.input, &case.expected),
            "is_archived_done" => archived(&case.id, &case.input, &case.expected),
            "parse_timestamp" => timestamps(&case.id, &case.input, &case.expected),
            "local_date" => local_dates(&case.id, &case.input, &case.expected),
            "priority_weight" => weights(&case.id, &case.input, &case.expected),
            "rank_for_placement" => placements(&case.id, &case.input, &case.expected),
            other => panic!("case {}: the corpus has a kind this test does not know: {other}", case.id),
        }
        *seen.entry(kind).or_default() += 1;
    }
    // Guards against the corpus quietly shrinking: every kind must be there, and in quantity.
    let at_least = |kind: &str, n: usize| assert!(seen.get(kind).copied().unwrap_or(0) >= n, "only {seen:?} of {kind}");
    at_least("board", 150);
    at_least("normalize_text", 20);
    at_least("due_state", 40);
    at_least("is_archived_done", 15);
    at_least("parse_timestamp", 1);
    at_least("rank_for_placement", 100);
    at_least("local_date", 1);
    at_least("priority_weight", 1);
}
