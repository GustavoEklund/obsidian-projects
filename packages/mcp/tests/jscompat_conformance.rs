//! The JavaScript behaviors (`trim`, `Number#toString`, ISO `Date.parse`) against what Node actually returned.
mod common;

use common::{assert_json_eq, fixture};
use oprojects_mcp::jscompat::{iso_string, js_trim, js_trim_end, js_trim_start, number_to_js_string, parse_iso_millis};
use serde_json::{Value, json};

#[test]
fn replays_the_whole_corpus() {
    let corpus = fixture("jscompat");
    let (mut trims, mut numbers, mut dates, mut parsed, mut legacy) = (0, 0, 0, 0, 0);
    for case in &corpus.cases {
        let (kind, _) = case.id.split_once(':').unwrap();
        match kind {
            "trim" => {
                trims += 1;
                let s = case.input.as_str().unwrap();
                let got = json!({"trim": js_trim(s), "start": js_trim_start(s), "end": js_trim_end(s)});
                assert_json_eq(&case.id, &got, &case.expected);
            }
            "number" => {
                numbers += 1;
                let got = json!(number_to_js_string(case.input.as_f64().unwrap()));
                assert_json_eq(&case.id, &got, &case.expected);
            }
            "date" => {
                dates += 1;
                let ms = parse_iso_millis(case.input.as_str().unwrap());
                let got = match ms {
                    Some(ms) => {
                        parsed += 1;
                        json!({"ms": ms, "iso": iso_string(ms).unwrap()})
                    }
                    None => Value::Null,
                };
                assert_json_eq(&case.id, &got, &case.expected);
            }
            "legacy" => {
                // V8's legacy date parser reads these; this crate deliberately does not (see the module docs).
                legacy += 1;
                let ms = parse_iso_millis(case.input.as_str().unwrap());
                assert!(ms.is_none(), "case \"{}\": {:?} is not ISO-8601 and must not parse", case.id, case.input);
                assert!(case.expected.is_object(), "the legacy cases are the ones V8 does parse");
            }
            other => panic!("unknown kind of case: {other}"),
        }
    }
    assert!(trims > 100 && numbers > 250 && dates > 300, "corpus looks truncated: {trims} {numbers} {dates}");
    assert!(parsed > 150, "too few dates parsed: {parsed}");
    assert!(legacy >= 8, "the divergences should be documented in the corpus: {legacy}");
}
