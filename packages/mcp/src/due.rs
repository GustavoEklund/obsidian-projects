//! Relative due dates for the tools: `today`, `tomorrow`, `+3d`, `+2w`, or a `YYYY-MM-DD` date. A port of `parseDue` in
//! `packages/cli/src/run.ts`, with the same validation message, so an agent and a person at the terminal get the same
//! answer.
use crate::card::is_valid_date;
use crate::error::{Error, Result};
use crate::jscompat::js_trim;
use crate::query::{CivilDate, local_date};

/// The longest run of digits accepted after `+`: 7 digits is 9,999,999 days, far beyond any date a card can hold.
/// JavaScript turns a huge offset into an invalid date; here it is simply an invalid input.
const MAX_OFFSET_DIGITS: usize = 7;

/// `YYYY-MM-DD` (as written by [`local_date`]) back into a date; `None` for anything else.
pub fn parse_civil_date(text: &str) -> Option<CivilDate> {
    let mut parts = text.split('-');
    let (year, month, day) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return None;
    }
    Some(CivilDate::new(year.parse().ok()?, month.parse().ok()?, day.parse().ok()?))
}

/// The date `input` stands for, given today's date in the user's time zone.
pub fn parse_due(input: &str, today: CivilDate) -> Result<String> {
    let value = js_trim(input).to_lowercase();
    match value.as_str() {
        "today" => return Ok(local_date(today)),
        "tomorrow" => return Ok(local_date(today.add_days(1))),
        _ => {}
    }
    if let Some(rest) = value.strip_prefix('+') {
        let unit = rest.chars().last();
        if let Some(unit @ ('d' | 'w')) = unit {
            let digits = &rest[..rest.len() - 1];
            if !digits.is_empty() && digits.len() <= MAX_OFFSET_DIGITS && digits.bytes().all(|b| b.is_ascii_digit()) {
                let days: i64 = digits.parse().expect("at most 7 ASCII digits always fit an i64");
                let days = if unit == 'w' { days * 7 } else { days };
                return Ok(local_date(today.add_days(days)));
            }
        }
    }
    if !is_valid_date(&value) {
        return Err(Error::validation(format!("Invalid date \"{input}\" (use YYYY-MM-DD, today, tomorrow, +3d, +2w)")));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: CivilDate = CivilDate { year: 2026, month: 10, day: 14 };

    fn due(input: &str) -> String {
        parse_due(input, TODAY).unwrap()
    }

    #[test]
    fn keywords_are_relative_to_today_whatever_their_case_or_padding() {
        assert_eq!(due("today"), "2026-10-14");
        assert_eq!(due("  TODAY "), "2026-10-14");
        assert_eq!(due("Tomorrow"), "2026-10-15");
    }

    #[test]
    fn offsets_count_days_and_weeks() {
        assert_eq!(due("+0d"), "2026-10-14");
        assert_eq!(due("+3d"), "2026-10-17");
        assert_eq!(due("+2w"), "2026-10-28");
        assert_eq!(due("+1W"), "2026-10-21");
        assert_eq!(due("+10D"), "2026-10-24");
    }

    #[test]
    fn offsets_roll_over_month_and_year_ends() {
        assert_eq!(due("+17d"), "2026-10-31");
        assert_eq!(due("+18d"), "2026-11-01");
        assert_eq!(due("+78d"), "2026-12-31");
        assert_eq!(due("+79d"), "2027-01-01");
        assert_eq!(parse_due("tomorrow", CivilDate::new(2026, 12, 31)).unwrap(), "2027-01-01");
    }

    #[test]
    fn leap_years_have_a_february_29() {
        assert_eq!(parse_due("tomorrow", CivilDate::new(2028, 2, 28)).unwrap(), "2028-02-29");
        assert_eq!(parse_due("tomorrow", CivilDate::new(2027, 2, 28)).unwrap(), "2027-03-01");
        assert_eq!(parse_due("+1d", CivilDate::new(2100, 2, 28)).unwrap(), "2100-03-01"); // 2100 is not a leap year
        assert_eq!(parse_due("+1d", CivilDate::new(2000, 2, 28)).unwrap(), "2000-02-29"); // 2000 is
        assert_eq!(due("2028-02-29"), "2028-02-29");
    }

    #[test]
    fn explicit_dates_are_checked_for_real() {
        assert_eq!(due("2026-10-20"), "2026-10-20");
        for bad in ["2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-1-5", "20261020", "10/20/2026"] {
            assert!(parse_due(bad, TODAY).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn anything_else_is_a_validation_error_that_says_what_would_work() {
        for bad in ["", " ", "someday", "+d", "+3", "+3x", "-3d", "++3d", "+3 d", "+1.5d", "+99999999d", "next week"] {
            let error = parse_due(bad, TODAY).unwrap_err();
            assert!(matches!(error, Error::Validation(_)), "{bad}");
            assert_eq!(
                error.to_string(),
                format!("Invalid date \"{bad}\" (use YYYY-MM-DD, today, tomorrow, +3d, +2w)"),
                "{bad}"
            );
        }
    }

    #[test]
    fn parses_the_dates_it_writes() {
        assert_eq!(parse_civil_date("2026-10-14"), Some(TODAY));
        assert_eq!(parse_civil_date("0999-01-02"), Some(CivilDate::new(999, 1, 2)));
        for bad in ["", "2026-10", "2026-10-14-1", "26-10-14", "2026-1-14", "2026/10/14", "abcd-ef-gh"] {
            assert_eq!(parse_civil_date(bad), None, "{bad}");
        }
    }
}
