//! Every case the TypeScript core produced for `rank.ts`, replayed against `rank.rs`.
mod common;

use common::{assert_json_eq, fixture};
use oprojects_mcp::rank::{is_valid_rank, rank_between, spread_ranks};
use serde_json::{Value, json};

fn bound(v: &Value) -> Option<&str> {
    v.as_str()
}

#[test]
fn replays_the_whole_corpus() {
    let corpus = fixture("rank");
    let mut counts = std::collections::BTreeMap::<&str, usize>::new();
    for case in &corpus.cases {
        let kind = case.id.split(':').next().unwrap();
        *counts.entry(kind).or_default() += 1;
        match kind {
            "valid" => {
                let got = json!(is_valid_rank(case.input.as_str().unwrap()));
                assert_json_eq(&case.id, &got, &case.expected);
            }
            "between" => {
                let got = match rank_between(bound(&case.input["a"]), bound(&case.input["b"])) {
                    Ok(rank) => json!({"ok": true, "value": rank}),
                    Err(e) => json!({"ok": false, "error": e.to_string()}),
                };
                assert_json_eq(&case.id, &got, &case.expected);
            }
            "spread" => {
                let got = json!(spread_ranks(case.input.as_u64().unwrap() as usize));
                assert_json_eq(&case.id, &got, &case.expected);
            }
            "insert" => {
                let mut list: Vec<String> = Vec::new();
                for at in case.input.as_array().unwrap() {
                    let at = at.as_u64().unwrap() as usize;
                    let lo = at.checked_sub(1).map(|i| list[i].as_str());
                    let hi = list.get(at).map(String::as_str);
                    list.insert(at, rank_between(lo, hi).unwrap());
                }
                assert_json_eq(&case.id, &json!(list), &case.expected);
            }
            other => panic!("unknown kind of case: {other}"),
        }
    }
    assert!(corpus.cases.len() > 550, "the corpus looks truncated: {} cases", corpus.cases.len());
    for kind in ["valid", "between", "spread", "insert"] {
        assert!(counts.get(kind).copied().unwrap_or(0) > 10, "few {kind} cases: {counts:?}");
    }
}
