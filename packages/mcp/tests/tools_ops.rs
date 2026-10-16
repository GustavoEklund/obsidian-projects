//! What each tool does, against a fake board: arguments in (as JSON, the way a client sends them), text out, and the
//! calls the board received. The protocol itself is tested in `tools_protocol.rs`.
mod common;

use common::fake_board::{FakeBoard, card};
use oprojects_mcp::api::Board;
use oprojects_mcp::error::Error;
use oprojects_mcp::ops::{
    self, AddComment, CreateCard, DeleteComment, EditComment, KeyArgs, ListCards, MoveCard, UpdateCard,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn args<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn rejected<T: DeserializeOwned>(value: Value) -> String {
    match serde_json::from_value::<T>(value) {
        Ok(_) => panic!("the arguments should have been rejected"),
        Err(error) => error.to_string(),
    }
}

fn many_cards(count: u32) -> std::sync::Arc<FakeBoard> {
    FakeBoard::new((1..=count).map(|n| card(n, "todo", &format!("Card {n}"))).collect())
}

// --- list_cards ----------------------------------------------------------------------------------------------------

#[test]
fn listing_without_filters_shows_every_card_in_board_order() {
    let board = FakeBoard::sample();
    let text = ops::list_cards(board.as_ref(), args(json!({}))).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "3 of 3 cards");
    assert_eq!(lines.len(), 4);
    assert!(
        lines[1].starts_with(r#"OP-1 [todo] medium task "Write the docs" @Ana due:2026-10-01(overdue) labels:docs"#),
        "{}",
        lines[1]
    );
    assert!(lines[2].starts_with(r#"OP-2 [doing] high bug "Fix the login redirect""#));
    assert!(lines[2].ends_with("comments:1"));
    assert!(lines[3].starts_with(r#"OP-3 [done]"#));
}

#[test]
fn a_column_can_be_named_by_display_name_or_id_and_one_value_may_replace_a_list() {
    let board = FakeBoard::sample();
    for status in [json!("In Progress"), json!(["in progress"]), json!("doing"), json!(["doing"])] {
        let text = ops::list_cards(board.as_ref(), args(json!({ "status": status }))).unwrap();
        assert!(text.starts_with("1 of 1 card\nOP-2 [doing]"), "{text}");
    }
    let both = ops::list_cards(board.as_ref(), args(json!({ "status": ["todo", "done"] }))).unwrap();
    assert!(both.starts_with("2 of 2 cards"));
}

#[test]
fn me_and_none_are_passed_to_the_board_to_resolve() {
    let board = FakeBoard::sample();
    let mine = ops::list_cards(board.as_ref(), args(json!({ "assignee": "me" }))).unwrap();
    assert!(mine.starts_with("1 of 1 card\nOP-1"));
    let nobody = ops::list_cards(board.as_ref(), args(json!({ "assignee": ["none"] }))).unwrap();
    assert!(nobody.starts_with("2 of 2 cards\nOP-2"));
    let query = board.last_query.lock().unwrap().clone().unwrap();
    assert_eq!(query.assignee, vec!["none".to_string()]);
}

#[test]
fn every_filter_reaches_the_board_and_blank_text_is_ignored() {
    let board = FakeBoard::sample();
    ops::list_cards(
        board.as_ref(),
        args(json!({
            "status": "doing", "type": ["bug", "epic"], "priority": ["high"], "assignee": ["Ana"],
            "labels": "docs", "parent": "OP-9", "text": "login", "include_archived": true
        })),
    )
    .unwrap();
    let query = board.last_query.lock().unwrap().clone().unwrap();
    assert_eq!(query.status, vec!["doing"]);
    assert_eq!(query.card_type.len(), 2);
    assert_eq!(query.priority.len(), 1);
    assert_eq!(query.assignee, vec!["Ana"]);
    assert_eq!(query.labels, vec!["docs"]);
    assert_eq!(query.parent.as_deref(), Some("OP-9"));
    assert_eq!(query.text.as_deref(), Some("login"));
    assert!(query.include_archived);

    ops::list_cards(board.as_ref(), args(json!({ "text": "   ", "parent": "" }))).unwrap();
    let query = board.last_query.lock().unwrap().clone().unwrap();
    assert_eq!((query.text, query.parent, query.include_archived), (None, None, false));
}

#[test]
fn text_search_goes_through_to_the_filter() {
    let board = FakeBoard::sample();
    let found = ops::list_cards(board.as_ref(), args(json!({ "text": "LOGIN" }))).unwrap();
    assert!(found.starts_with("1 of 1 card\nOP-2"));
    assert_eq!(
        ops::list_cards(board.as_ref(), args(json!({ "text": "nothing like this" }))).unwrap(),
        "No cards match."
    );
}

#[test]
fn the_default_limit_is_fifty_and_the_header_says_what_is_missing() {
    let board = many_cards(120);
    let text = ops::list_cards(board.as_ref(), args(json!({}))).unwrap();
    assert!(text.starts_with("50 of 120 cards (70 more not shown: narrow the filters, or raise limit up to 200)\n"));
    assert_eq!(text.lines().count(), 51);
}

#[test]
fn the_limit_is_clamped_between_one_and_two_hundred() {
    let board = many_cards(250);
    assert_eq!(ops::list_cards(board.as_ref(), args(json!({ "limit": 5 }))).unwrap().lines().count(), 6);
    assert_eq!(ops::list_cards(board.as_ref(), args(json!({ "limit": 0 }))).unwrap().lines().count(), 2);
    assert_eq!(ops::list_cards(board.as_ref(), args(json!({ "limit": 1000 }))).unwrap().lines().count(), 201);
    assert_eq!(ops::list_cards(board.as_ref(), args(json!({ "limit": 200 }))).unwrap().lines().count(), 201);
    let all = ops::list_cards(board.as_ref(), args(json!({ "limit": 200 }))).unwrap();
    assert!(all.starts_with("200 of 250 cards (50 more not shown"));
}

#[test]
fn an_unknown_column_is_an_error_that_lists_the_valid_ones() {
    let board = FakeBoard::sample();
    let error = ops::list_cards(board.as_ref(), args(json!({ "status": "limbo" }))).unwrap_err();
    assert!(matches!(error, Error::Validation(_)));
    let message = error.to_string();
    assert!(message.contains("Unknown column \"limbo\""), "{message}");
    assert!(message.contains("doing (\"In Progress\")"), "{message}");
}

#[test]
fn misspelled_or_invalid_arguments_are_rejected_with_a_message_the_model_can_use() {
    assert!(rejected::<ListCards>(json!({ "asignee": "x" })).contains("unknown field `asignee`"));
    assert!(rejected::<ListCards>(json!({ "type": ["tsak"] })).contains("unknown variant `tsak`"));
    assert!(rejected::<ListCards>(json!({ "priority": ["urgent"] })).contains("unknown variant `urgent`"));
    assert!(rejected::<ListCards>(json!({ "limit": -1 })).contains("invalid value"));
    assert!(rejected::<ListCards>(json!({ "include_archived": "yes" })).contains("invalid type"));
}

// --- get_card ------------------------------------------------------------------------------------------------------

#[test]
fn a_card_in_full_has_its_description_and_comments_with_ids() {
    let board = FakeBoard::sample();
    let text = ops::get_card(board.as_ref(), args(json!({ "key": "OP-2" }))).unwrap();
    assert!(text.starts_with("OP-2 [doing] \"Fix the login redirect\"\ntype: bug | priority: high"));
    assert!(text.contains("description:\nThe user lands on the home page."));
    assert!(text.contains("comments (1):\n- c1 (Bruno, 2026-10-02T10:00:00.000Z): Seen in Safari."));
}

#[test]
fn a_card_can_be_asked_for_by_number() {
    let board = FakeBoard::sample();
    assert!(ops::get_card(board.as_ref(), args(json!({ "key": "3" }))).unwrap().starts_with("OP-3 [done]"));
    assert!(board.call_log().contains(&"get 3".to_string()));
}

#[test]
fn a_missing_card_is_an_error_naming_it() {
    let board = FakeBoard::sample();
    let error = ops::get_card(board.as_ref(), args(json!({ "key": "OP-99" }))).unwrap_err();
    assert!(matches!(error, Error::NotFound(_)));
    assert_eq!(error.to_string(), "Card OP-99 not found");
    assert!(ops::get_card(board.as_ref(), args(json!({ "key": "nonsense" }))).is_err());
}

#[test]
fn the_key_is_required() {
    assert!(rejected::<KeyArgs>(json!({})).contains("missing field `key`"));
}

// --- create_card ---------------------------------------------------------------------------------------------------

#[test]
fn creating_a_card_with_only_a_title_uses_the_defaults() {
    let board = FakeBoard::sample();
    let text = ops::create_card(board.as_ref(), args(json!({ "title": "  Brand new  " }))).unwrap();
    assert_eq!(text, r#"Created: OP-4 [todo] medium task "Brand new""#);
    let input = board.last_new_card.lock().unwrap().clone().unwrap();
    assert_eq!((input.status, input.card_type, input.priority, input.due), (None, None, None, None));
    assert_eq!(board.cards().len(), 4);
}

#[test]
fn creating_a_card_with_every_field() {
    let board = FakeBoard::sample();
    let text = ops::create_card(
        board.as_ref(),
        args(json!({
            "title": "Everything", "status": "In Progress", "type": "story", "priority": "highest", "assignee": "Bruno",
            "labels": ["a", "b"], "due": "2026-12-24", "estimate": 2.5, "parent": "OP-1", "body": "Details\n\n- [ ] one"
        })),
    )
    .unwrap();
    assert_eq!(
        text,
        r#"Created: OP-4 [doing] highest story "Everything" @Bruno due:2026-12-24 est:2.5 labels:a,b parent:OP-1"#
    );
}

#[test]
fn relative_due_dates_are_resolved_against_the_boards_today() {
    let board = FakeBoard::sample();
    for (due, expected) in
        [("today", "2026-10-14"), ("tomorrow", "2026-10-15"), ("+3d", "2026-10-17"), ("+2w", "2026-10-28")]
    {
        ops::create_card(board.as_ref(), args(json!({ "title": "x", "due": due }))).unwrap();
        let input = board.last_new_card.lock().unwrap().clone().unwrap();
        assert_eq!(input.due.as_deref(), Some(expected), "{due}");
    }
    *board.today.lock().unwrap() = "2028-02-28".into();
    ops::create_card(board.as_ref(), args(json!({ "title": "x", "due": "tomorrow" }))).unwrap();
    assert_eq!(board.last_new_card.lock().unwrap().clone().unwrap().due.as_deref(), Some("2028-02-29"));
}

#[test]
fn an_invalid_due_date_creates_nothing_and_says_what_is_valid() {
    let board = FakeBoard::sample();
    let error = ops::create_card(board.as_ref(), args(json!({ "title": "x", "due": "soonish" }))).unwrap_err();
    assert_eq!(error.to_string(), "Invalid date \"soonish\" (use YYYY-MM-DD, today, tomorrow, +3d, +2w)");
    assert_eq!(board.cards().len(), 3);
    assert!(!board.call_log().iter().any(|c| c == "create"));
}

#[test]
fn blank_optional_strings_count_as_absent() {
    let board = FakeBoard::sample();
    ops::create_card(board.as_ref(), args(json!({ "title": "x", "status": " ", "assignee": "", "parent": "  " })))
        .unwrap();
    let input = board.last_new_card.lock().unwrap().clone().unwrap();
    assert_eq!((input.status, input.assignee, input.parent), (None, None, None));
}

#[test]
fn creating_needs_a_title_and_refuses_unknown_columns() {
    assert!(rejected::<CreateCard>(json!({})).contains("missing field `title`"));
    assert!(rejected::<CreateCard>(json!({ "title": "x", "rank": "A" })).contains("unknown field `rank`"));
    let board = FakeBoard::sample();
    let error = ops::create_card(board.as_ref(), args(json!({ "title": "x", "status": "limbo" }))).unwrap_err();
    assert!(error.to_string().contains("Unknown column"));
}

// --- update_card ---------------------------------------------------------------------------------------------------

fn patch_of(board: &FakeBoard) -> oprojects_mcp::types::CardPatch {
    board.last_patch.lock().unwrap().clone().expect("the board was asked to update")
}

#[test]
fn an_absent_field_is_left_alone_and_null_clears_it() {
    let board = FakeBoard::sample();
    ops::update_card(
        board.as_ref(),
        args(json!({ "key": "1", "assignee": null, "due": null, "estimate": null, "parent": null })),
    )
    .unwrap();
    let patch = patch_of(&board);
    assert_eq!(patch.assignee, Some(None));
    assert_eq!(patch.due, Some(None));
    assert_eq!(patch.estimate, Some(None));
    assert_eq!(patch.parent, Some(None));
    assert_eq!(
        (patch.title, patch.card_type, patch.priority, patch.labels, patch.body),
        (None, None, None, None, None)
    );
    assert_eq!(board.get("OP-1").unwrap().assignee, None, "the clear went through to the card");
}

#[test]
fn a_value_replaces_the_field() {
    let board = FakeBoard::sample();
    ops::update_card(
        board.as_ref(),
        args(json!({
            "key": "OP-3", "title": "New title", "type": "epic", "priority": "low", "assignee": "Bruno",
            "labels": ["x"], "due": "+1d", "estimate": 5, "parent": "OP-1", "body": "New text"
        })),
    )
    .unwrap();
    let patch = patch_of(&board);
    assert_eq!(patch.assignee, Some(Some("Bruno".into())));
    assert_eq!(patch.due, Some(Some("2026-10-15".into())));
    assert_eq!(patch.estimate, Some(Some(5.0)));
    assert_eq!(patch.parent, Some(Some("OP-1".into())));
    assert_eq!(patch.labels, Some(vec!["x".to_string()]));
    assert_eq!(patch.body.as_deref(), Some("New text"));
    assert_eq!(patch.status, None, "the column is never changed by update_card");
}

#[test]
fn empty_labels_and_an_empty_body_are_real_changes_not_omissions() {
    let board = FakeBoard::sample();
    ops::update_card(board.as_ref(), args(json!({ "key": "1", "labels": [], "body": "" }))).unwrap();
    let patch = patch_of(&board);
    assert_eq!(patch.labels, Some(vec![]));
    assert_eq!(patch.body.as_deref(), Some(""));
}

#[test]
fn updating_nothing_is_an_error_that_points_at_move_card() {
    let board = FakeBoard::sample();
    let error = ops::update_card(board.as_ref(), args(json!({ "key": "1" }))).unwrap_err();
    assert!(matches!(error, Error::Validation(_)));
    assert!(error.to_string().contains("Nothing to change"));
    assert!(error.to_string().contains("move_card"));
    assert!(!board.call_log().iter().any(|c| c.starts_with("update")));
}

#[test]
fn the_column_cannot_be_set_through_update_card() {
    assert!(rejected::<UpdateCard>(json!({ "key": "1", "status": "done" })).contains("unknown field `status`"));
}

#[test]
fn an_invalid_due_date_changes_nothing() {
    let board = FakeBoard::sample();
    let error =
        ops::update_card(board.as_ref(), args(json!({ "key": "1", "title": "x", "due": "never" }))).unwrap_err();
    assert!(error.to_string().starts_with("Invalid date \"never\""));
    assert!(!board.call_log().iter().any(|c| c.starts_with("update")));
    assert_eq!(board.get("OP-1").unwrap().title, "Write the docs");
}

#[test]
fn the_confirmation_shows_the_card_as_it_is_now() {
    let board = FakeBoard::sample();
    let text = ops::update_card(board.as_ref(), args(json!({ "key": "2", "priority": "lowest", "title": "Renamed" })))
        .unwrap();
    assert!(text.starts_with(r#"Updated: OP-2 [doing] lowest bug "Renamed""#), "{text}");
}

// --- move_card -----------------------------------------------------------------------------------------------------

#[test]
fn moving_a_card_to_a_column_by_name() {
    let board = FakeBoard::sample();
    let text = ops::move_card(board.as_ref(), args(json!({ "key": "1", "column": "Done" }))).unwrap();
    assert!(text.starts_with(r#"Moved: OP-1 [done]"#), "{text}");
    assert_eq!(board.get("OP-1").unwrap().status, "done");
}

#[test]
fn before_and_after_reach_the_board_and_blank_ones_do_not() {
    let board = FakeBoard::sample();
    ops::move_card(board.as_ref(), args(json!({ "key": "1", "column": "doing", "before": "OP-2" }))).unwrap();
    let placement = board.last_placement.lock().unwrap().clone().unwrap();
    assert_eq!((placement.before.as_deref(), placement.after), (Some("OP-2"), None));
    ops::move_card(board.as_ref(), args(json!({ "key": "1", "column": "doing", "after": "OP-2", "before": " " })))
        .unwrap();
    let placement = board.last_placement.lock().unwrap().clone().unwrap();
    assert_eq!((placement.before, placement.after.as_deref()), (None, Some("OP-2")));
}

#[test]
fn moving_to_an_unknown_column_or_an_unknown_card_fails_clearly() {
    let board = FakeBoard::sample();
    assert!(
        ops::move_card(board.as_ref(), args(json!({ "key": "1", "column": "limbo" })))
            .unwrap_err()
            .to_string()
            .contains("Unknown column")
    );
    assert_eq!(
        ops::move_card(board.as_ref(), args(json!({ "key": "42", "column": "done" }))).unwrap_err().to_string(),
        "Card OP-42 not found"
    );
    assert!(rejected::<MoveCard>(json!({ "key": "1" })).contains("missing field `column`"));
}

// --- delete_card ---------------------------------------------------------------------------------------------------

#[test]
fn deleting_says_where_the_note_went() {
    let board = FakeBoard::sample();
    let text = ops::delete_card(board.as_ref(), args(json!({ "key": "OP-3" }))).unwrap();
    assert_eq!(
        text,
        "Deleted OP-3 (\"Ship it\"). The note was moved to the vault's .trash, where it can be restored from."
    );
    assert_eq!(board.cards().len(), 2);
}

#[test]
fn a_quote_in_the_title_does_not_break_the_sentence() {
    let board = FakeBoard::new(vec![card(1, "todo", "Say \"hi\"")]);
    assert!(
        ops::delete_card(board.as_ref(), args(json!({ "key": "1" })))
            .unwrap()
            .starts_with("Deleted OP-1 (\"Say 'hi'\").")
    );
}

#[test]
fn deleting_a_missing_card_is_an_error() {
    let board = FakeBoard::sample();
    assert_eq!(
        ops::delete_card(board.as_ref(), args(json!({ "key": "OP-77" }))).unwrap_err().to_string(),
        "Card OP-77 not found"
    );
}

// --- comments ------------------------------------------------------------------------------------------------------

#[test]
fn a_comment_without_an_author_is_signed_by_the_server_author() {
    let board = FakeBoard::sample();
    let text = ops::add_comment(board.as_ref(), args(json!({ "key": "2", "text": "On it." })), "Claude").unwrap();
    assert_eq!(text, "Added comment c2 to OP-2 (2 in all).");
    assert_eq!(board.last_comment.lock().unwrap().clone().unwrap().author.as_deref(), Some("Claude"));
    assert_eq!(board.get("OP-2").unwrap().comments[1].author, "Claude");
}

#[test]
fn a_named_author_wins_and_a_blank_one_does_not() {
    let board = FakeBoard::sample();
    ops::add_comment(board.as_ref(), args(json!({ "key": "2", "text": "x", "author": "Carla" })), "Claude").unwrap();
    assert_eq!(board.last_comment.lock().unwrap().clone().unwrap().author.as_deref(), Some("Carla"));
    ops::add_comment(board.as_ref(), args(json!({ "key": "2", "text": "x", "author": "  " })), "Claude").unwrap();
    assert_eq!(board.last_comment.lock().unwrap().clone().unwrap().author.as_deref(), Some("Claude"));
}

#[test]
fn an_empty_comment_or_a_missing_card_is_an_error() {
    let board = FakeBoard::sample();
    assert!(ops::add_comment(board.as_ref(), args(json!({ "key": "2", "text": "  " })), "Claude").is_err());
    assert_eq!(
        ops::add_comment(board.as_ref(), args(json!({ "key": "9", "text": "hi" })), "Claude").unwrap_err().to_string(),
        "Card OP-9 not found"
    );
    assert!(rejected::<AddComment>(json!({ "key": "1" })).contains("missing field `text`"));
}

#[test]
fn editing_and_deleting_a_comment_by_id() {
    let board = FakeBoard::sample();
    assert_eq!(
        ops::edit_comment(board.as_ref(), args(json!({ "key": "2", "comment_id": "c1", "text": "Fixed it." })))
            .unwrap(),
        "Edited comment c1 of OP-2."
    );
    assert_eq!(board.get("OP-2").unwrap().comments[0].text, "Fixed it.");
    assert_eq!(
        ops::delete_comment(board.as_ref(), args(json!({ "key": "2", "comment_id": "c1" }))).unwrap(),
        "Deleted comment c1 from OP-2 (0 left)."
    );
    assert!(board.get("OP-2").unwrap().comments.is_empty());
}

#[test]
fn an_unknown_comment_id_is_an_error() {
    let board = FakeBoard::sample();
    assert_eq!(
        ops::edit_comment(board.as_ref(), args(json!({ "key": "2", "comment_id": "zzz", "text": "x" })))
            .unwrap_err()
            .to_string(),
        "Comment zzz not found"
    );
    assert!(ops::delete_comment(board.as_ref(), args(json!({ "key": "2", "comment_id": "zzz" }))).is_err());
    assert!(rejected::<EditComment>(json!({ "key": "2", "text": "x" })).contains("missing field `comment_id`"));
    assert!(rejected::<DeleteComment>(json!({ "key": "2", "id": "c1" })).contains("unknown field `id`"));
}

// --- board_summary -------------------------------------------------------------------------------------------------

#[test]
fn the_summary_counts_columns_and_flags() {
    let board = FakeBoard::sample();
    let expected = "\
Board OP (folder Cards): 3 cards, 1 overdue, 2 unassigned. Me: Ana
todo \"To Do\": 1
doing \"In Progress\": 1, WIP limit 2
review \"Review\": 0
done \"Done\": 1 (done column)";
    assert_eq!(ops::board_summary(board.as_ref()).unwrap(), expected);
}

#[test]
fn the_summary_reports_old_done_cards_that_are_hidden() {
    let mut old = card(9, "done", "Ancient");
    old.resolved = Some("2026-01-01T00:00:00.000Z".into());
    let board = FakeBoard::new(vec![card(1, "todo", "Fresh"), old]);
    let text = ops::board_summary(board.as_ref()).unwrap();
    assert!(text.contains("1 card, 0 overdue"), "{text}");
    assert!(
        text.ends_with(
            "Hidden: 1 done card resolved more than 14 days ago (list_cards with include_archived shows them)."
        ),
        "{text}"
    );
}

// --- errors from the board -----------------------------------------------------------------------------------------

#[test]
fn whatever_the_board_fails_with_is_the_message_the_model_gets() {
    let board = FakeBoard::sample();
    *board.fail_next.lock().unwrap() = Some(Error::Format("Frontmatter of OP-1 is not valid YAML".into()));
    assert_eq!(
        ops::get_card(board.as_ref(), args(json!({ "key": "1" }))).unwrap_err().to_string(),
        "Frontmatter of OP-1 is not valid YAML"
    );
    *board.fail_next.lock().unwrap() = Some(Error::FileExists("Cards/OP-5.md".into()));
    assert_eq!(
        ops::list_cards(board.as_ref(), args(json!({}))).unwrap_err().to_string(),
        "File already exists: Cards/OP-5.md"
    );
}

// --- `me` as an assignee --------------------------------------------------------------------------------------------

#[test]
fn me_as_an_assignee_is_the_board_user_when_creating_and_when_updating() {
    // Found by using the installed server: `assignee: "me"` was stored as the word "me" while the same word in a filter
    // meant the user, and the server instructions promise that "me" means the user.
    let board = FakeBoard::sample();
    for spelling in ["me", "ME", " Me "] {
        ops::create_card(board.as_ref(), args(json!({ "title": "x", "assignee": spelling }))).unwrap();
        let input = board.last_new_card.lock().unwrap().clone().unwrap();
        assert_eq!(input.assignee.as_deref(), Some("Ana"), "{spelling:?} when creating");
        ops::update_card(board.as_ref(), args(json!({ "key": "OP-1", "assignee": spelling }))).unwrap();
        assert_eq!(patch_of(&board).assignee, Some(Some("Ana".into())), "{spelling:?} when updating");
    }
}

#[test]
fn a_name_that_merely_contains_me_is_left_alone_and_null_still_clears() {
    let board = FakeBoard::sample();
    for name in ["Mel", "Meme", "me too", "Someone"] {
        ops::update_card(board.as_ref(), args(json!({ "key": "OP-1", "assignee": name }))).unwrap();
        assert_eq!(patch_of(&board).assignee, Some(Some(name.to_string())), "{name}");
    }
    ops::update_card(board.as_ref(), args(json!({ "key": "OP-1", "assignee": null }))).unwrap();
    assert_eq!(patch_of(&board).assignee, Some(None));
}

#[test]
fn without_a_configured_user_me_stays_as_written_like_in_the_cli() {
    let config = oprojects_mcp::types::BoardConfig { me: String::new(), ..common::fake_board::config() };
    let board = FakeBoard::with_config(vec![card(1, "todo", "One")], config);
    ops::create_card(board.as_ref(), args(json!({ "title": "x", "assignee": "me" }))).unwrap();
    assert_eq!(board.last_new_card.lock().unwrap().clone().unwrap().assignee.as_deref(), Some("me"));
}
