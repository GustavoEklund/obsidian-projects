//! Fractional ranking, a port of `packages/core/src/rank.ts`.
//!
//! Every card has a string rank and a column is ordered by plain string comparison, so putting a card between two
//! others only needs a rank that sorts between theirs: moving a card rewrites exactly one note. Ranks are base-62
//! fractions (`0.xyz` without the `0.`), with digits in ASCII order so comparing the strings is comparing the numbers.
//! They never end in `0`.
//!
//! Ranks written by the TypeScript core and by this crate interleave, so the alphabet, the midpoint rule and even the
//! quirks of the original are kept exactly (a character outside the alphabet counts as digit 0; an empty upper bound
//! is an upper bound, not "the bottom"). Ranks are ASCII in practice: the algorithm works on `char`s, which is exact
//! for the Basic Multilingual Plane, and only the ordering helper is careful about UTF-16 code unit order.
use crate::error::{Error, Result};
use std::cmp::Ordering;

const DIGITS: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: usize = DIGITS.len();
const LAST: char = 'z';

/// The value of a digit; anything outside the alphabet (or nothing at all) counts as 0, like the original.
fn digit(ch: Option<char>) -> usize {
    ch.and_then(|c| DIGITS.find(c)).unwrap_or(0)
}

fn digit_char(index: usize) -> char {
    DIGITS.as_bytes()[index] as char
}

/// JavaScript compares strings by UTF-16 code units, which differs from code point order above the BMP.
pub fn compare_ranks(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A string strictly between `a` (empty means the start) and `b` (`None` means the end). Requires `a < b`.
fn midpoint(a: &[char], b: Option<&[char]>) -> String {
    if let Some(b) = b {
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or('0') == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out: String = b[..n].iter().collect();
            out.push_str(&midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..])));
            return out;
        }
    }
    let da = if a.is_empty() { 0 } else { digit(a.first().copied()) };
    let db = match b {
        Some(b) => digit(b.first().copied()),
        None => BASE,
    };
    if db > da + 1 {
        // Math.round((da + db) / 2): halves round up.
        return digit_char((da + db).div_ceil(2)).to_string();
    }
    if let Some(b) = b
        && b.len() > 1
    {
        return b[..1].iter().collect();
    }
    let mut out = String::new();
    out.push(digit_char(da));
    out.push_str(&midpoint(a.get(1..).unwrap_or(&[]), None));
    out
}

/// The next rank after `a`: bumps the last digit so sequential appends stay short.
fn after(a: &[char]) -> String {
    let (last, head) = a.split_last().expect("`after` is only called with a non-empty rank");
    let mut out: String = head.iter().collect();
    if *last == LAST {
        out.push(*last);
        out.push(digit_char(BASE >> 1));
    } else {
        out.push(digit_char(digit(Some(*last)) + 1));
    }
    out
}

/// A valid rank is not empty, does not end in `0` and only uses the alphabet.
pub fn is_valid_rank(rank: &str) -> bool {
    !rank.is_empty() && !rank.ends_with('0') && rank.chars().all(|c| DIGITS.contains(c))
}

/// A rank that sorts strictly between `a` and `b`. `None` for `a` (or an empty string) means "top", `None` for `b`
/// means "bottom". Note that `Some("")` for `b` is an upper bound that nothing can sort before, so it is an error.
pub fn rank_between(a: Option<&str>, b: Option<&str>) -> Result<String> {
    let lo = a.unwrap_or("");
    if let Some(hi) = b
        && compare_ranks(lo, hi) != Ordering::Less
    {
        return Err(Error::validation(format!(
            "rankBetween: lower bound \"{lo}\" must sort before upper bound \"{hi}\""
        )));
    }
    let lo: Vec<char> = lo.chars().collect();
    match b {
        None if !lo.is_empty() => Ok(after(&lo)),
        None => Ok(midpoint(&lo, None)),
        Some(hi) => {
            let hi: Vec<char> = hi.chars().collect();
            Ok(midpoint(&lo, Some(&hi)))
        }
    }
}

/// `count` evenly spread, ascending ranks (used when seeding or rebalancing).
pub fn spread_ranks(count: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(count);
    for _ in 0..count {
        let next = rank_between(out.last().map(String::as_str), None).expect("appending always has room");
        out.push(next);
    }
    out
}
