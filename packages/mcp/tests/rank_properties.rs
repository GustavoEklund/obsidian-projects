//! Properties of the ranking functions, independent of the TypeScript corpus.
use oprojects_mcp::rank::{compare_ranks, is_valid_rank, rank_between, spread_ranks};
use proptest::prelude::*;
use std::cmp::Ordering;

const DIGITS: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// Any valid rank: base-62 digits that do not end in '0'.
fn valid_rank() -> impl Strategy<Value = String> {
    proptest::collection::vec(proptest::sample::select(DIGITS.chars().collect::<Vec<_>>()), 1..9)
        .prop_map(|chars| chars.into_iter().collect::<String>())
        .prop_filter("must not end in 0", |s| is_valid_rank(s))
}

/// Two distinct valid ranks, in ascending order.
fn ordered_pair() -> impl Strategy<Value = (String, String)> {
    (valid_rank(), valid_rank())
        .prop_filter("distinct", |(a, b)| a != b)
        .prop_map(|(a, b)| if compare_ranks(&a, &b) == Ordering::Less { (a, b) } else { (b, a) })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 1000, failure_persistence: None, ..ProptestConfig::default() })]

    #[test]
    fn is_valid_rank_accepts_exactly_digit_strings_not_ending_in_zero(s in "\\PC{0,10}") {
        let expected = !s.is_empty() && !s.ends_with('0') && s.chars().all(|c| DIGITS.contains(c));
        prop_assert_eq!(is_valid_rank(&s), expected);
    }

    #[test]
    fn a_rank_between_two_ordered_ranks_is_valid_and_strictly_between((a, b) in ordered_pair()) {
        let mid = rank_between(Some(&a), Some(&b)).unwrap();
        prop_assert!(is_valid_rank(&mid), "{mid} is not valid");
        prop_assert_eq!(compare_ranks(&a, &mid), Ordering::Less);
        prop_assert_eq!(compare_ranks(&mid, &b), Ordering::Less);
    }

    #[test]
    fn there_is_always_room_above_and_below_a_rank(r in valid_rank()) {
        let above = rank_between(None, Some(&r)).unwrap();
        prop_assert!(is_valid_rank(&above));
        prop_assert_eq!(compare_ranks(&above, &r), Ordering::Less);
        let below = rank_between(Some(&r), None).unwrap();
        prop_assert!(is_valid_rank(&below));
        prop_assert_eq!(compare_ranks(&r, &below), Ordering::Less);
    }

    #[test]
    fn inverted_or_equal_bounds_are_refused_and_named((a, b) in ordered_pair()) {
        let inverted = rank_between(Some(&b), Some(&a)).unwrap_err().to_string();
        prop_assert!(inverted.contains("must sort before"));
        let equal = rank_between(Some(&a), Some(&a)).unwrap_err().to_string();
        let quoted = format!("\"{a}\"");
        prop_assert!(equal.contains(&quoted));
    }

    #[test]
    fn rank_between_is_deterministic((a, b) in ordered_pair()) {
        prop_assert_eq!(rank_between(Some(&a), Some(&b)).unwrap(), rank_between(Some(&a), Some(&b)).unwrap());
    }

    #[test]
    fn random_insertions_keep_a_strict_total_order(positions in proptest::collection::vec(0usize..10_000, 1..250)) {
        let mut list: Vec<String> = Vec::new();
        for p in positions {
            let at = p % (list.len() + 1);
            let lo = at.checked_sub(1).map(|i| list[i].as_str());
            let hi = list.get(at).map(String::as_str);
            let rank = rank_between(lo, hi).unwrap();
            prop_assert!(is_valid_rank(&rank));
            list.insert(at, rank);
        }
        prop_assert!(list.windows(2).all(|w| compare_ranks(&w[0], &w[1]) == Ordering::Less));
    }

    #[test]
    fn spread_ranks_are_valid_ascending_and_distinct(count in 0usize..400) {
        let ranks = spread_ranks(count);
        prop_assert_eq!(ranks.len(), count);
        prop_assert!(ranks.iter().all(|r| is_valid_rank(r)));
        prop_assert!(ranks.windows(2).all(|w| compare_ranks(&w[0], &w[1]) == Ordering::Less));
    }

    #[test]
    fn rank_between_never_panics_on_arbitrary_bounds(a in "\\PC{0,8}", b in "\\PC{0,8}") {
        let _ = rank_between(Some(&a), Some(&b));
        let _ = rank_between(None, Some(&b));
        let _ = rank_between(Some(&a), None);
    }
}

#[test]
fn appending_keeps_ranks_short() {
    let ranks = spread_ranks(2000);
    let longest = ranks.iter().map(String::len).max().unwrap();
    // Appending grows a rank by about one character every 31 inserts: 65 for 2000, the same as the TypeScript core.
    assert_eq!(longest, 65);
    assert_eq!(ranks[0], "V", "the first rank of an empty column");
}

#[test]
fn always_inserting_at_the_top_keeps_ranks_reasonable() {
    let mut top: Option<String> = None;
    let mut longest = 0;
    for _ in 0..200 {
        let next = rank_between(None, top.as_deref()).unwrap();
        assert!(top.as_deref().is_none_or(|t| compare_ranks(&next, t) == Ordering::Less));
        longest = longest.max(next.len());
        top = Some(next);
    }
    assert!(longest < 60, "{longest} characters after 200 inserts at the top");
}

#[test]
fn an_empty_upper_bound_is_a_bound_and_cannot_be_satisfied() {
    // The original documents "empty means bottom" for `b`, but its code treats '' as a bound: kept on purpose.
    let err = rank_between(Some("V"), Some("")).unwrap_err().to_string();
    assert_eq!(err, "rankBetween: lower bound \"V\" must sort before upper bound \"\"");
    assert_eq!(rank_between(Some(""), Some("V")).unwrap(), rank_between(None, Some("V")).unwrap());
}

#[test]
fn a_character_outside_the_alphabet_counts_as_digit_zero() {
    // Hand-edited garbage must still produce a rank that sorts where the original would put it.
    assert_eq!(rank_between(Some("0é"), Some("1")).unwrap(), "0V");
    assert_eq!(rank_between(Some("a-"), None).unwrap(), "a1");
}

#[test]
fn compare_ranks_uses_utf16_code_unit_order_like_javascript() {
    // U+FFFF is above the surrogate range in UTF-16 order, U+10000 is encoded as a surrogate pair: JS says it sorts first.
    assert_eq!(compare_ranks("\u{10000}", "\u{ffff}"), Ordering::Less);
    assert_eq!(compare_ranks("a", "b"), Ordering::Less);
    assert_eq!(compare_ranks("ab", "a"), Ordering::Greater);
    assert_eq!(compare_ranks("", ""), Ordering::Equal);
}

#[test]
fn the_first_ranks_of_a_column_are_the_known_values() {
    assert_eq!(spread_ranks(3), ["V", "W", "X"]);
    assert_eq!(rank_between(Some("z"), None).unwrap(), "zV");
}
