//! `JSON.stringify(value, null, 2)` the way JavaScript writes it, so the `--json` output of the Rust command line is
//! byte for byte the TypeScript one. `serde_json` differs in two places that show: it writes `3.0` for a whole float
//! where JavaScript writes `3`, and it writes `1e21` where JavaScript writes `1e+21`.
use crate::jscompat::number_to_js_string;
use serde_json::Value;

/// Two-space indentation, one item per line; `[]` and `{}` for empty ones.
pub fn pretty(value: &Value) -> String {
    let mut out = String::new();
    write(value, Some(0), &mut out);
    out
}

/// No spaces or line breaks at all.
pub fn compact(value: &Value) -> String {
    let mut out = String::new();
    write(value, None, &mut out);
    out
}

/// A string as a JSON literal, with JavaScript's escapes (`\b` `\f` `\n` `\r` `\t`, `\u00xx` for other control characters).
pub fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn newline(depth: usize, out: &mut String) {
    out.push('\n');
    for _ in 0..depth {
        out.push_str("  ");
    }
}

fn write(value: &Value, depth: Option<usize>, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number_to_js_string(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => out.push_str(&quote(s)),
        Value::Array(items) if items.is_empty() => out.push_str("[]"),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if let Some(d) = depth {
                    newline(d + 1, out);
                }
                write(item, depth.map(|d| d + 1), out);
            }
            if let Some(d) = depth {
                newline(d, out);
            }
            out.push(']');
        }
        Value::Object(fields) if fields.is_empty() => out.push_str("{}"),
        Value::Object(fields) => {
            out.push('{');
            for (i, (key, item)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if let Some(d) = depth {
                    newline(d + 1, out);
                }
                out.push_str(&quote(key));
                out.push(':');
                if depth.is_some() {
                    out.push(' ');
                }
                write(item, depth.map(|d| d + 1), out);
            }
            if let Some(d) = depth {
                newline(d, out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pretty_matches_json_stringify_with_two_spaces() {
        let value = json!({"a": 1, "b": [1, 2.5, {"c": null}], "d": [], "e": {}, "f": "x\ty\"z\\", "g": true});
        assert_eq!(
            pretty(&value),
            "{\n  \"a\": 1,\n  \"b\": [\n    1,\n    2.5,\n    {\n      \"c\": null\n    }\n  ],\n  \"d\": [],\n  \"e\": {},\n  \"f\": \"x\\ty\\\"z\\\\\",\n  \"g\": true\n}"
        );
    }

    #[test]
    fn numbers_are_written_like_javascript() {
        assert_eq!(
            compact(&json!([3.0, 0.1, 1e21, 1e-7, -0.0, 123456789012345680000.0])),
            "[3,0.1,1e+21,1e-7,0,123456789012345680000]"
        );
    }

    #[test]
    fn compact_has_no_whitespace_and_keeps_key_order() {
        assert_eq!(compact(&json!({"error": "bad \"thing\""})), r#"{"error":"bad \"thing\""}"#);
        let value: Value = serde_json::from_str(r#"{"z":1,"a":[1,2],"m":{"y":2,"b":3}}"#).unwrap();
        assert_eq!(compact(&value), r#"{"z":1,"a":[1,2],"m":{"y":2,"b":3}}"#);
    }

    #[test]
    fn control_characters_use_javascript_escapes() {
        assert_eq!(
            quote("\u{8}\u{c}\n\r\t\u{1}\u{1f}\u{7f}é日🚀\u{2028}"),
            "\"\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}é日🚀\u{2028}\""
        );
    }
}
