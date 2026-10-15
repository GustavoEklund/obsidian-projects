//! The few JavaScript behaviors the card formats lean on, reproduced exactly so a note means the same thing to the
//! TypeScript core and to this crate: `String.prototype.trim`, `Number.prototype.toString`, and the ISO-8601 corner of
//! `Date.parse` / `Date.prototype.toISOString`.
//!
//! Dates: only ISO-8601 forms are understood (`2026`, `2026-10`, `2026-10-14`, and with a time `T17:02`, `T17:02:00`,
//! `T17:02:00.123`, followed by `Z` or `+02:00`/`-0300`), with V8's leniencies (a space instead of `T`, a day up to 31
//! in any month which then overflows, `24:00:00`, more than three fraction digits which are truncated, lower-case
//! `t`/`z`). The string must be exact: V8 reads a padded one with its legacy parser, which accepts date-only strings
//! (as local time) and rejects date-times, and callers trim first like the TypeScript does. V8's legacy formats (`Oct 14 2026`, `2026/10/14`, `12`) are not understood and give
//! `None`. A date-time without an offset is read as UTC here, where JavaScript reads it as local time; notes are
//! written with explicit `Z` timestamps, so the difference only shows up in hand-edited notes.

/// The code points `String.prototype.trim` removes: ECMAScript WhiteSpace plus LineTerminator.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `String.prototype.trim`. (Rust's `str::trim` differs: it removes U+0085 and keeps U+FEFF.)
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// `String(number)`: the shortest representation that reads back to the same value, in JavaScript's layout.
pub fn number_to_js_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-Infinity" } else { "Infinity" }.into();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust's `{:e}` is the shortest round-trip digits: "1.2345e3".
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').expect("`{:e}` always has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("exponent is an integer") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let exponent = format!("e{}{}", if e < 0 { "-" } else { "+" }, e.abs());
        if k == 1 { format!("{digits}{exponent}") } else { format!("{}.{}{exponent}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

// --- dates -------------------------------------------------------------------------------------------------------

const MS_PER_DAY: i64 = 86_400_000;
/// ECMAScript's time range: plus or minus 100,000,000 days from the epoch.
const MAX_TIME: i64 = 8_640_000_000_000_000;

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm). `month` is 1-12.
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of `days_from_civil`: `(year, month 1-12, day 1-31)`.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn digits(bytes: &[u8], at: &mut usize, count: usize) -> Option<i64> {
    let slice = bytes.get(*at..*at + count)?;
    if !slice.iter().all(u8::is_ascii_digit) {
        return None;
    }
    *at += count;
    Some(slice.iter().fold(0, |acc, d| acc * 10 + i64::from(d - b'0')))
}

fn eat(bytes: &[u8], at: &mut usize, byte: u8) -> bool {
    if bytes.get(*at) == Some(&byte) {
        *at += 1;
        true
    } else {
        false
    }
}

/// `Date.parse` for ISO-8601 strings: milliseconds since the epoch, or `None` where JavaScript gives `NaN` (and for
/// the legacy formats this crate does not read, see the module docs).
pub fn parse_iso_millis(input: &str) -> Option<i64> {
    let bytes = input.as_bytes();
    let mut at = 0;

    let year = match bytes.first()? {
        b'+' | b'-' => {
            let negative = bytes[0] == b'-';
            at = 1;
            let y = digits(bytes, &mut at, 6)?;
            if negative && y == 0 {
                return None; // "-000000" is not a valid year
            }
            if negative { -y } else { y }
        }
        _ => digits(bytes, &mut at, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    if eat(bytes, &mut at, b'-') {
        month = digits(bytes, &mut at, 2)?;
        if eat(bytes, &mut at, b'-') {
            day = digits(bytes, &mut at, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let (mut hour, mut minute, mut second, mut milli) = (0, 0, 0, 0);
    let mut offset_minutes: i64 = 0;
    if at < bytes.len() {
        if !(eat(bytes, &mut at, b'T') || eat(bytes, &mut at, b't') || eat(bytes, &mut at, b' ')) {
            return None;
        }
        hour = digits(bytes, &mut at, 2)?;
        if !eat(bytes, &mut at, b':') {
            return None;
        }
        minute = digits(bytes, &mut at, 2)?;
        if eat(bytes, &mut at, b':') {
            second = digits(bytes, &mut at, 2)?;
            if eat(bytes, &mut at, b'.') {
                let start = at;
                while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                    at += 1;
                }
                if at == start {
                    return None;
                }
                let fraction = &bytes[start..at];
                milli = (0..3).fold(0, |acc, i| acc * 10 + i64::from(fraction.get(i).map_or(0, |d| d - b'0')));
            }
        }
        if eat(bytes, &mut at, b'Z') || eat(bytes, &mut at, b'z') {
            // UTC
        } else if matches!(bytes.get(at), Some(b'+' | b'-')) {
            let sign = if bytes[at] == b'-' { -1 } else { 1 };
            at += 1;
            let oh = digits(bytes, &mut at, 2)?;
            eat(bytes, &mut at, b':');
            let om = digits(bytes, &mut at, 2)?;
            if oh > 23 || om > 59 {
                return None;
            }
            offset_minutes = sign * (oh * 60 + om);
        }
        if at != bytes.len() {
            return None;
        }
        if hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute, second, milli) != (0, 0, 0)) {
            return None;
        }
    }

    let days = days_from_civil(year, month, 1) + (day - 1);
    let ms = days * MS_PER_DAY + ((hour * 60 + minute) * 60 + second) * 1000 + milli - offset_minutes * 60_000;
    (ms.abs() <= MAX_TIME).then_some(ms)
}

/// `new Date(ms).toISOString()`: `2026-10-14T17:02:00.000Z`, with `+YYYYYY`/`-YYYYYY` outside 0000-9999.
pub fn iso_string(ms: i64) -> Option<String> {
    (ms.abs() <= MAX_TIME).then(|| {
        let (y, m, d) = civil_from_days(ms.div_euclid(MS_PER_DAY));
        let rest = ms.rem_euclid(MS_PER_DAY);
        let year = if (0..=9999).contains(&y) {
            format!("{y:04}")
        } else {
            format!("{}{:06}", if y < 0 { '-' } else { '+' }, y.abs())
        };
        format!(
            "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
            rest / 3_600_000,
            rest / 60_000 % 60,
            rest / 1000 % 60,
            rest % 1000
        )
    })
}

/// The wall-clock fields `(year, month, day, hour, minute)` of `ms` at a fixed offset east of UTC.
pub fn wall_clock(ms: i64, offset_minutes: i32) -> (i64, i64, i64, i64, i64) {
    let local = ms + i64::from(offset_minutes) * 60_000;
    let (y, m, d) = civil_from_days(local.div_euclid(MS_PER_DAY));
    let rest = local.rem_euclid(MS_PER_DAY);
    (y, m, d, rest / 3_600_000, rest / 60_000 % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_matches_javascript_not_rust() {
        assert_eq!(js_trim("\u{feff}\u{00a0} a \u{3000}\u{2028}"), "a");
        assert_eq!(js_trim("\u{0085}a\u{0085}"), "\u{0085}a\u{0085}", "NEL is not JavaScript whitespace");
        assert_eq!("\u{0085}a\u{0085}".trim(), "a", "but Rust trims it: that is why js_trim exists");
        assert_eq!(js_trim("\u{200b}a"), "\u{200b}a", "zero-width space is not whitespace either");
        assert_eq!((js_trim_start("  a "), js_trim_end("  a ")), ("a ", "  a"));
    }

    #[test]
    fn numbers_print_like_javascript() {
        let cases: [(f64, &str); 22] = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-12.5, "-12.5"),
            (0.1, "0.1"),
            (123456789.0, "123456789"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (123456789012345680000.0, "123456789012345680000"),
            (1.2345e25, "1.2345e+25"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (100.0, "100"),
            (1.0 / 3.0, "0.3333333333333333"),
            (4.35, "4.35"),
            (2.0f64.powi(53), "9007199254740992"),
        ];
        for (x, expected) in cases {
            assert_eq!(number_to_js_string(x), expected, "for {x:?}");
        }
    }

    #[test]
    fn civil_dates_round_trip_around_the_epoch_and_the_calendar_edges() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
        assert_eq!(civil_from_days(days_from_civil(1900, 3, 1)), (1900, 3, 1));
        assert_eq!(civil_from_days(days_from_civil(-1, 12, 31)), (-1, 12, 31));
        for days in (-800_000..800_000).step_by(997) {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
    }

    #[test]
    fn parses_the_iso_forms_v8_accepts() {
        let iso = |s: &str| parse_iso_millis(s).and_then(iso_string);
        assert_eq!(iso("2026-10-14").as_deref(), Some("2026-10-14T00:00:00.000Z"));
        assert_eq!(iso("2026-10").as_deref(), Some("2026-10-01T00:00:00.000Z"));
        assert_eq!(iso("2026").as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(iso("2026-10-14T17:02:00.000Z").as_deref(), Some("2026-10-14T17:02:00.000Z"));
        assert_eq!(iso("2026-10-14T17:02Z").as_deref(), Some("2026-10-14T17:02:00.000Z"));
        assert_eq!(iso("2026-10-14 17:02:00Z").as_deref(), Some("2026-10-14T17:02:00.000Z"));
        assert_eq!(iso("2026-10-14T17:02:00+02:00").as_deref(), Some("2026-10-14T15:02:00.000Z"));
        assert_eq!(iso("2026-10-14T17:02:00-0300").as_deref(), Some("2026-10-14T20:02:00.000Z"));
        assert_eq!(iso("2026-10-14T17:02:00.5Z").as_deref(), Some("2026-10-14T17:02:00.500Z"));
        assert_eq!(iso("2026-10-14T17:02:00.123456Z").as_deref(), Some("2026-10-14T17:02:00.123Z"));
        assert_eq!(iso("2026-10-14t17:02:00z").as_deref(), Some("2026-10-14T17:02:00.000Z"));
        assert_eq!(iso("2026-10-14T24:00:00Z").as_deref(), Some("2026-10-15T00:00:00.000Z"));
        assert_eq!(iso("+275760-09-13").as_deref(), Some("+275760-09-13T00:00:00.000Z"));
        assert_eq!(iso("-000001-01-01").as_deref(), Some("-000001-01-01T00:00:00.000Z"));
    }

    #[test]
    fn a_day_up_to_31_overflows_into_the_next_month_like_v8() {
        let iso = |s: &str| parse_iso_millis(s).and_then(iso_string);
        assert_eq!(iso("2026-02-30").as_deref(), Some("2026-03-02T00:00:00.000Z"));
        assert_eq!(iso("2026-02-29").as_deref(), Some("2026-03-01T00:00:00.000Z"));
        assert_eq!(iso("2026-04-31").as_deref(), Some("2026-05-01T00:00:00.000Z"));
    }

    #[test]
    fn rejects_what_javascript_calls_nan() {
        for bad in [
            "",
            "foo",
            "2026-13-01",
            "2026-00-10",
            "2026-10-32",
            "2026-10-00",
            "2026-10-14T24:00:01Z",
            "2026-10-14T25:00:00Z",
            "2026-10-14T17:60:00Z",
            "2026-10-14T17:02:60Z",
            "+275760-09-14",
            "2026-10-14T17:02:00 Z",
            "2026-10-14T17:02:00+2",
            "2026-10-14T7:02:00Z",
            "20261014",
            "2026-10-14T",
            "2026-10-14T17",
            "2026-10-14T17:02:00.Z",
            "-000000-01-01",
            "2026-10-14T17:02:00+24:00",
            "2026-10-14Z",
            "2026-10-14 ",
            " 2026-10-14",
            "2026-10-14T17:02Z ",
            "12",
            "Oct 14 2026",
            "2026/10/14",
        ] {
            assert_eq!(parse_iso_millis(bad), None, "{bad:?} should not parse");
        }
    }

    #[test]
    fn formats_years_outside_0_to_9999_with_six_digits_and_a_sign() {
        assert_eq!(iso_string(-62_167_219_200_000).as_deref(), Some("0000-01-01T00:00:00.000Z"));
        assert_eq!(iso_string(-62_167_219_200_001).as_deref(), Some("-000001-12-31T23:59:59.999Z"));
        assert_eq!(iso_string(253_402_300_800_000).as_deref(), Some("+010000-01-01T00:00:00.000Z"));
        assert_eq!(iso_string(MAX_TIME + 1), None);
        assert_eq!(iso_string(0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(iso_string(-1).as_deref(), Some("1969-12-31T23:59:59.999Z"));
    }

    #[test]
    fn wall_clock_applies_a_fixed_offset() {
        let ms = parse_iso_millis("2026-10-14T17:02:00Z").unwrap();
        assert_eq!(wall_clock(ms, 0), (2026, 10, 14, 17, 2));
        assert_eq!(wall_clock(ms, -180), (2026, 10, 14, 14, 2));
        assert_eq!(wall_clock(ms, 330), (2026, 10, 14, 22, 32));
        assert_eq!(wall_clock(ms, 7 * 60), (2026, 10, 15, 0, 2));
    }
}
