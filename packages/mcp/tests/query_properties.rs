//! Property tests for `query`: the invariants the TypeScript `query.property.test.ts` checks, plus the ones that only
//! exist because this is Rust (UTF-16 ordering, the JavaScript whitespace set, date arithmetic).
use oprojects_mcp::query::{
    CardFilter, CivilDate, DueState, Now, PreparedFilter, UNASSIGNED, compare_cards, due_state, filter_cards,
    group_by_column, haystack, is_archived_done, is_js_whitespace, js_cmp, js_trim, local_date, matches_filter,
    normalize_text, parse_timestamp_ms, rank_for_placement, sort_cards,
};
use oprojects_mcp::rank::{is_valid_rank, spread_ranks};
use oprojects_mcp::types::{
    BoardConfig, CARD_TYPES, Card, CardType, Checklist, Comment, PRIORITIES, Placement, Priority,
};
use proptest::prelude::*;
use std::cmp::Ordering;
use std::collections::HashSet;

fn config() -> BoardConfig {
    BoardConfig { hide_done_after_days: 14, me: "Ana".into(), ..BoardConfig::default() }
}

const STATUSES: [&str; 4] = ["todo", "doing", "review", "done"];

fn base_card(key: &str) -> Card {
    Card {
        key: key.into(),
        path: format!("Cards/{key}.md"),
        title: key.into(),
        status: "todo".into(),
        card_type: CardType::Task,
        priority: Priority::Medium,
        assignee: None,
        labels: vec![],
        due: None,
        estimate: None,
        parent: None,
        rank: "V".into(),
        created: "2026-01-01T00:00:00.000Z".into(),
        updated: "2026-01-01T00:00:00.000Z".into(),
        resolved: None,
        body: String::new(),
        checklist: Checklist::default(),
        comments: vec![],
    }
}

// --- generators -------------------------------------------------------------------------------------------------------

const WORDS: [&str; 10] = ["login", "Café", "résumé", "Zoë", "checkout", "API", "Müller", "bug", "ünïcode", "payments"];

fn phrase() -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(WORDS.to_vec()), 1..4).prop_map(|w| w.join(" "))
}

fn card_fields() -> impl Strategy<Value = Card> {
    (
        phrase(),
        prop::sample::select(vec!["todo", "doing", "review", "done", "ghost", ""]),
        prop::sample::select(CARD_TYPES.to_vec()),
        prop::sample::select(PRIORITIES.to_vec()),
        prop::option::of(prop::sample::select(vec!["Ana", "Bruno", "Zoë", "ana"])),
        prop::collection::hash_set(prop::sample::select(vec!["api", "ux", "Café", "bug", "ops"]), 0..4),
        prop::option::of(prop::sample::select(vec!["OP-1", "OP-2"])),
        prop::sample::select(vec!["V", "W", "Vb", "A", "z", "1", "V1", "\u{e000}", "\u{10000}"]),
        prop::sample::select(vec!["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]),
        phrase(),
        prop::collection::vec(phrase(), 0..3),
    )
        .prop_map(|(title, status, ty, pr, assignee, labels, parent, rank, created, body, comments)| {
            let mut card = base_card("OP-1");
            card.title = title;
            card.status = status.into();
            card.card_type = ty;
            card.priority = pr;
            card.assignee = assignee.map(str::to_owned);
            card.labels = labels.into_iter().map(str::to_owned).collect();
            card.labels.sort();
            card.parent = parent.map(str::to_owned);
            card.rank = rank.into();
            card.created = created.into();
            card.body = body;
            card.comments = comments
                .into_iter()
                .enumerate()
                .map(|(n, text)| Comment { id: format!("c{n}"), author: "x".into(), at: String::new(), text })
                .collect();
            card
        })
}

fn cards() -> impl Strategy<Value = Vec<Card>> {
    prop::collection::vec(card_fields(), 0..14).prop_map(|mut list| {
        for (i, card) in list.iter_mut().enumerate() {
            card.key = format!("OP-{}", i + 1);
            card.path = format!("Cards/{}.md", card.key);
        }
        list
    })
}

fn filter() -> impl Strategy<Value = CardFilter> {
    (
        prop::option::of(phrase()),
        prop::collection::vec(prop::sample::select(STATUSES.to_vec()), 0..3),
        prop::collection::vec(prop::sample::select(CARD_TYPES.to_vec()), 0..3),
        prop::collection::vec(prop::sample::select(PRIORITIES.to_vec()), 0..3),
        prop::collection::vec(prop::sample::select(vec!["Ana", "bruno", UNASSIGNED, "ZOE"]), 0..3),
        prop::collection::vec(prop::sample::select(vec!["api", "UX", "cafe"]), 0..3),
        prop::option::of(prop::sample::select(vec!["OP-1", "op-2"])),
    )
        .prop_map(|(text, status, ty, pr, assignee, labels, parent)| CardFilter {
            text,
            status: status.into_iter().map(str::to_owned).collect(),
            card_type: ty,
            priority: pr,
            assignee: assignee.into_iter().map(str::to_owned).collect(),
            labels: labels.into_iter().map(str::to_owned).collect(),
            parent: parent.map(str::to_owned),
        })
}

fn keys<'a>(cards: impl IntoIterator<Item = &'a Card>) -> Vec<String> {
    cards.into_iter().map(|c| c.key.clone()).collect()
}

// --- filtering --------------------------------------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn filtering_returns_a_subsequence_in_the_original_order(cards in cards(), f in filter()) {
        let out = filter_cards(&cards, &f, &config());
        let mut from = 0;
        for card in out {
            let at = cards[from..].iter().position(|c| std::ptr::eq(c, card));
            prop_assert!(at.is_some(), "an output card is not a later element of the input");
            from += at.unwrap() + 1;
        }
    }

    #[test]
    fn an_empty_filter_keeps_every_card_and_so_do_blank_parts(cards in cards()) {
        let blank = CardFilter { text: Some("   \u{a0}\u{feff} ".into()), status: vec![], labels: vec![], ..CardFilter::default() };
        prop_assert_eq!(filter_cards(&cards, &CardFilter::default(), &config()).len(), cards.len());
        prop_assert_eq!(filter_cards(&cards, &blank, &config()).len(), cards.len());
    }

    #[test]
    fn adding_a_dimension_never_grows_the_result(cards in cards(), a in filter(), b in filter()) {
        // `narrow` is `a` plus whatever `b` constrains where `a` does not: strictly more conditions than `a`.
        let a_text = a.text.clone().filter(|t| !js_trim(t).is_empty());
        let narrow = CardFilter {
            text: a_text.clone().or(b.text.clone()),
            status: if a.status.is_empty() { b.status.clone() } else { a.status.clone() },
            card_type: if a.card_type.is_empty() { b.card_type.clone() } else { a.card_type.clone() },
            priority: if a.priority.is_empty() { b.priority.clone() } else { a.priority.clone() },
            assignee: if a.assignee.is_empty() { b.assignee.clone() } else { a.assignee.clone() },
            labels: if a.labels.is_empty() { b.labels.clone() } else { a.labels.clone() },
            parent: a.parent.clone().or(b.parent.clone()),
        };
        let wide: HashSet<String> = keys(filter_cards(&cards, &a, &config())).into_iter().collect();
        for key in keys(filter_cards(&cards, &narrow, &config())) {
            prop_assert!(wide.contains(&key), "{key} passes the narrower filter but not the wider one");
        }
    }

    #[test]
    fn filtering_by_two_dimensions_is_the_intersection_of_filtering_by_each(cards in cards(), a in filter()) {
        let only_status = CardFilter { status: a.status.clone(), ..CardFilter::default() };
        let only_type = CardFilter { card_type: a.card_type.clone(), ..CardFilter::default() };
        let both = CardFilter { status: a.status.clone(), card_type: a.card_type.clone(), ..CardFilter::default() };
        let by_status: HashSet<String> = keys(filter_cards(&cards, &only_status, &config())).into_iter().collect();
        let by_type: HashSet<String> = keys(filter_cards(&cards, &only_type, &config())).into_iter().collect();
        let intersection: HashSet<String> = by_status.intersection(&by_type).cloned().collect();
        let combined: HashSet<String> = keys(filter_cards(&cards, &both, &config())).into_iter().collect();
        prop_assert_eq!(combined, intersection);
    }

    #[test]
    fn matching_card_by_card_agrees_with_filtering_the_list_and_with_a_cached_haystack(cards in cards(), f in filter()) {
        let cfg = config();
        let listed = keys(filter_cards(&cards, &f, &cfg));
        let one_by_one = keys(cards.iter().filter(|c| matches_filter(c, &f, &cfg)));
        let prepared = PreparedFilter::new(&f);
        let cached: Vec<String> =
            cards.iter().filter(|c| prepared.matches(c, &cfg, Some(&haystack(c)))).map(|c| c.key.clone()).collect();
        prop_assert_eq!(&listed, &one_by_one);
        prop_assert_eq!(&listed, &cached);
    }

    #[test]
    fn text_search_ignores_case_and_accents_and_needs_every_word(cards in cards()) {
        for card in &cards {
            for query in [card.title.to_uppercase(), card.title.to_lowercase(), normalize_text(&card.title)] {
                let hit = CardFilter { text: Some(query.clone()), ..CardFilter::default() };
                prop_assert!(matches_filter(card, &hit, &config()), "{query:?} should match {:?}", card.title);
                let miss = CardFilter { text: Some(format!("{query} definitely-not-present")), ..CardFilter::default() };
                prop_assert!(!matches_filter(card, &miss, &config()));
            }
        }
    }

    #[test]
    fn the_unassigned_sentinel_matches_exactly_the_cards_without_an_assignee(cards in cards()) {
        let f = CardFilter { assignee: vec![UNASSIGNED.into()], ..CardFilter::default() };
        let out = filter_cards(&cards, &f, &config());
        prop_assert!(out.iter().all(|c| c.assignee.is_none()));
        prop_assert_eq!(out.len(), cards.iter().filter(|c| c.assignee.is_none()).count());
        let zoe = CardFilter { assignee: vec!["ZOE".into()], ..CardFilter::default() };
        prop_assert!(filter_cards(&cards, &zoe, &config()).iter().all(|c| c.assignee.as_deref() == Some("Zoë")));
    }
}

// --- sorting and grouping ---------------------------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(250))]

    #[test]
    fn sorting_is_a_permutation_that_ignores_the_input_order(cards in cards(), seed in 0usize..1000) {
        let cfg = config();
        let sorted = sort_cards(&cards, &cfg);
        prop_assert_eq!(sorted.len(), cards.len());
        let mut shuffled = cards.clone();
        let n = shuffled.len().max(1);
        shuffled.rotate_left(seed % n);
        shuffled.reverse();
        prop_assert_eq!(keys(&sort_cards(&shuffled, &cfg)), keys(&sorted));
        prop_assert_eq!(keys(&sort_cards(&sorted, &cfg)), keys(&sorted), "sorting twice changes nothing");
    }

    #[test]
    fn sorting_orders_by_column_then_rank_then_created_then_key(cards in cards()) {
        let sorted = sort_cards(&cards, &config());
        let column = |c: &Card| STATUSES.iter().position(|s| *s == c.status).unwrap_or(0);
        for pair in sorted.windows(2) {
            let tuple = |c: &Card| (column(c), c.rank.encode_utf16().collect::<Vec<_>>(), c.created.clone(), c.key.encode_utf16().collect::<Vec<_>>());
            prop_assert!(tuple(&pair[0]) <= tuple(&pair[1]), "{:?} before {:?}", pair[0].key, pair[1].key);
        }
    }

    #[test]
    fn the_comparator_is_a_consistent_total_order(cards in cards()) {
        let cfg = config();
        let cmp = compare_cards(&cfg);
        for a in &cards {
            prop_assert_eq!(cmp(a, a), Ordering::Equal);
            for b in &cards {
                prop_assert_eq!(cmp(a, b), cmp(b, a).reverse());
                for c in &cards {
                    if cmp(a, b).is_le() && cmp(b, c).is_le() { prop_assert!(cmp(a, c).is_le()); }
                }
            }
        }
    }

    #[test]
    fn the_sort_is_stable_for_cards_the_comparator_cannot_tell_apart(count in 2usize..8) {
        // Same column, rank, created and key: only the input order separates them.
        let list: Vec<Card> = (0..count).map(|i| { let mut c = base_card("OP-1"); c.title = format!("copy {i}"); c }).collect();
        let sorted = sort_cards(&list, &config());
        let titles: Vec<&str> = sorted.iter().map(|c| c.title.as_str()).collect();
        let expected: Vec<String> = (0..count).map(|i| format!("copy {i}")).collect();
        prop_assert_eq!(titles, expected.iter().map(String::as_str).collect::<Vec<_>>());
    }

    #[test]
    fn grouping_puts_every_card_in_exactly_one_column_in_board_order(cards in cards()) {
        let cfg = config();
        let groups = group_by_column(&cards, &cfg);
        prop_assert_eq!(groups.iter().map(|g| g.column.id.as_str()).collect::<Vec<_>>(), cfg.columns.iter().map(|c| c.id.as_str()).collect::<Vec<_>>());
        let flat: Vec<&Card> = groups.iter().flat_map(|g| g.cards.iter()).collect();
        prop_assert_eq!(flat.len(), cards.len());
        prop_assert_eq!(flat.iter().map(|c| c.key.as_str()).collect::<HashSet<_>>().len(), cards.len());
        for g in &groups { prop_assert_eq!(keys(&g.cards), keys(&sort_cards(&g.cards, &cfg))); }
        prop_assert_eq!(keys(flat.into_iter()), keys(&sort_cards(&cards, &cfg)));
    }
}

// --- JavaScript string semantics --------------------------------------------------------------------------------------

fn any_text() -> impl Strategy<Value = String> {
    // Plain ASCII, accents, the BMP's top end, and the supplementary planes: where UTF-8 and UTF-16 order part ways.
    prop::collection::vec(
        prop_oneof![
            prop::char::range('a', 'e'),
            prop::char::range('\u{e0}', '\u{e5}'),
            prop::char::range('\u{d7f0}', '\u{d7ff}'),
            prop::char::range('\u{e000}', '\u{e003}'),
            prop::char::range('\u{fffd}', '\u{ffff}'),
            prop::char::range('\u{10000}', '\u{10003}'),
            prop::char::range('\u{1f600}', '\u{1f603}'),
        ],
        0..6,
    )
    .prop_map(|chars| chars.into_iter().collect())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn js_cmp_is_utf16_code_unit_order(a in any_text(), b in any_text()) {
        prop_assert_eq!(js_cmp(&a, &b), a.encode_utf16().cmp(b.encode_utf16()), "{:?} vs {:?}", a, b);
    }

    #[test]
    fn js_cmp_is_antisymmetric_and_transitive(a in any_text(), b in any_text(), c in any_text()) {
        prop_assert_eq!(js_cmp(&a, &b), js_cmp(&b, &a).reverse());
        if js_cmp(&a, &b).is_le() && js_cmp(&b, &c).is_le() { prop_assert!(js_cmp(&a, &c).is_le()); }
    }

    #[test]
    fn js_trim_is_idempotent_and_leaves_no_javascript_whitespace_at_the_ends(s in "[ a-z\u{a0}\u{feff}\u{2028}\u{85}\u{200b}\t\n]{0,12}") {
        let once = js_trim(&s);
        prop_assert_eq!(js_trim(once), once);
        prop_assert!(once.chars().next().is_none_or(|c| !is_js_whitespace(c)));
        prop_assert!(once.chars().next_back().is_none_or(|c| !is_js_whitespace(c)));
    }

    #[test]
    fn normalize_text_is_idempotent_lowercase_and_free_of_combining_accents(s in "\\PC{0,24}") {
        let once = normalize_text(&s);
        prop_assert_eq!(normalize_text(&once), once.clone());
        let has_mark = once.chars().any(|c| ('\u{300}'..='\u{36f}').contains(&c));
        prop_assert!(!has_mark);
        prop_assert_eq!(once.to_lowercase(), once.clone());
    }

    #[test]
    fn the_ascii_fast_path_of_normalize_text_agrees_with_the_full_pipeline(s in "[ -~]{0,30}") {
        use unicode_normalization::UnicodeNormalization;
        let slow: String = s.nfd().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect::<String>().to_lowercase();
        prop_assert_eq!(normalize_text(&s), slow);
    }
}

// --- dates ------------------------------------------------------------------------------------------------------------

fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let d = CivilDate::from_epoch_days(days);
    let year = if (0..=9999).contains(&d.year) {
        format!("{:04}", d.year)
    } else {
        format!("{}{:06}", if d.year < 0 { '-' } else { '+' }, d.year.abs())
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        d.month,
        d.day,
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1500))]

    #[test]
    fn civil_dates_round_trip_and_step_one_day_at_a_time(days in -1_000_000i64..1_000_000) {
        let d = CivilDate::from_epoch_days(days);
        prop_assert_eq!(d.to_epoch_days(), days);
        prop_assert!((1..=12).contains(&d.month) && (1..=31).contains(&d.day));
        let next = CivilDate::from_epoch_days(days + 1);
        let same_month = next.year == d.year && next.month == d.month;
        let steps_right = if same_month { next.day == d.day + 1 } else { next.day == 1 };
        prop_assert!(steps_right);
        prop_assert_eq!(d.add_days(7).add_days(-7), d);
    }

    #[test]
    fn a_formatted_instant_parses_back_to_itself(ms in -62_135_596_800_000i64..253_402_300_799_999) {
        prop_assert_eq!(parse_timestamp_ms(&iso(ms)), Some(ms), "{}", iso(ms));
    }

    #[test]
    fn expanded_years_round_trip_across_the_whole_representable_range(ms in -8_640_000_000_000_000i64..=8_640_000_000_000_000) {
        prop_assert_eq!(parse_timestamp_ms(&iso(ms)), Some(ms), "{}", iso(ms));
    }

    #[test]
    fn parsing_text_that_is_not_a_timestamp_never_panics(s in "\\PC{0,40}") {
        let _ = parse_timestamp_ms(&s);
    }

    #[test]
    fn due_states_never_go_backwards_as_the_due_date_moves_later(offset in -400i64..400, today in -20_000i64..40_000) {
        let cfg = config();
        let now = Now { epoch_ms: today * 86_400_000, local_date: CivilDate::from_epoch_days(today) };
        let state_for = |delta: i64, status: &str| {
            let mut c = base_card("OP-1");
            c.status = status.into();
            c.due = Some(local_date(CivilDate::from_epoch_days(today + offset + delta)));
            due_state(&c, &cfg, &now)
        };
        let rank = |s: Option<DueState>| match s.unwrap() { DueState::Overdue => 0, DueState::Soon => 1, DueState::Later => 2 };
        prop_assert!(rank(state_for(0, "todo")) <= rank(state_for(1, "todo")));
        prop_assert_eq!(state_for(0, "done"), Some(DueState::Later), "a done card is never overdue");
        let expected = if offset < 0 { DueState::Overdue } else if offset <= 2 { DueState::Soon } else { DueState::Later };
        prop_assert_eq!(state_for(0, "todo"), Some(expected));
    }

    #[test]
    fn archiving_grows_with_time_and_shrinks_with_the_configured_days(
        ago_days in 0i64..120, extra_ms in 0i64..86_400_000, days in 1u32..90, later in 0i64..10_000_000_000)
    {
        let mut done = base_card("OP-1");
        done.status = "done".into();
        let now_ms = 1_791_979_200_000;
        done.resolved = Some(iso(now_ms - ago_days * 86_400_000 - extra_ms));
        let at = |config_days: u32, shift: i64| {
            let cfg = BoardConfig { hide_done_after_days: config_days, ..config() };
            is_archived_done(&done, &cfg, &Now { epoch_ms: now_ms + shift, local_date: CivilDate::new(1970, 1, 1) })
        };
        if at(days, 0) { prop_assert!(at(days, later), "archived stays archived as time passes"); }
        if at(days + 1, 0) { prop_assert!(at(days, 0), "a shorter limit archives at least as much"); }
        prop_assert!(!at(0, 0), "0 days means never");
        let mut todo = done.clone();
        todo.status = "todo".into();
        let cfg = config();
        let never = is_archived_done(&todo, &cfg, &Now { epoch_ms: now_ms + later, local_date: CivilDate::new(1970, 1, 1) });
        prop_assert!(!never, "only done cards are archived");
    }
}

// --- rank_for_placement ----------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Op {
    card: usize,
    column: usize,
    where_: u8,
    reference: usize,
}

fn ops() -> impl Strategy<Value = Vec<Op>> {
    prop::collection::vec(
        (0usize..64, 0usize..4, 0u8..3, 0usize..64).prop_map(|(card, column, where_, reference)| Op {
            card,
            column,
            where_,
            reference,
        }),
        0..40,
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(150))]

    /// A card moved anywhere lands exactly there, for random sequences of moves (checked against a plain list model).
    #[test]
    fn a_moved_card_lands_exactly_where_it_was_asked_to(size in 1usize..12, ops in ops()) {
        let cfg = config();
        let ranks = spread_ranks(size);
        let mut cards: Vec<Card> = (0..size)
            .map(|i| { let mut c = base_card(&format!("OP-{}", i + 1)); c.rank = ranks[i].clone(); c })
            .collect();
        let mut model: Vec<Vec<String>> = vec![cards.iter().map(|c| c.key.clone()).collect(), vec![], vec![], vec![]];

        for op in ops {
            let moving = cards[op.card % size].key.clone();
            let others: Vec<String> = model[op.column].iter().filter(|k| **k != moving).cloned().collect();
            let anchor = if others.is_empty() || op.where_ == 0 { None } else { Some(others[op.reference % others.len()].clone()) };
            let placement = match (&anchor, op.where_) {
                (Some(a), 1) => Placement { before: Some(a.clone()), after: None },
                (Some(a), 2) => Placement { after: Some(a.clone()), before: None },
                _ => Placement::default(),
            };
            let status = STATUSES[op.column];
            let rank = rank_for_placement(&cards, &cfg, &moving, status, &placement).unwrap();
            prop_assert!(is_valid_rank(&rank), "{rank:?} is not a valid rank");
            let card = cards.iter_mut().find(|c| c.key == moving).unwrap();
            card.status = status.into();
            card.rank = rank;

            for list in &mut model { list.retain(|k| *k != moving); }
            let mut target = others;
            let at = match (&anchor, op.where_) {
                (None, _) => target.len(),
                (Some(a), 1) => target.iter().position(|k| k == a).unwrap(),
                (Some(a), _) => target.iter().position(|k| k == a).unwrap() + 1,
            };
            target.insert(at, moving);
            model[op.column] = target;

            for (column, expected) in model.iter().enumerate() {
                let inside: Vec<&Card> = cards.iter().filter(|c| c.status == STATUSES[column]).collect();
                prop_assert_eq!(keys(sort_cards(&inside, &cfg).into_iter()), expected.clone());
            }
        }
    }

    #[test]
    fn equal_ranks_around_the_anchor_never_make_it_fail(size in 2usize..8, pick in 0usize..8) {
        let list: Vec<Card> = (0..size).map(|i| base_card(&format!("OP-{}", i + 1))).collect(); // all rank "V"
        let target = &list[pick % size].key;
        let placement = Placement { before: Some(target.clone()), after: None };
        let rank = rank_for_placement(&list, &config(), "OP-999", "todo", &placement).unwrap();
        prop_assert!(is_valid_rank(&rank));
    }
}
