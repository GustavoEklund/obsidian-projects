//! A vault of 5,000 realistic notes through the whole stack: how long the first load takes, how much memory the index
//! costs, and how long the questions an agent asks take once it is loaded. The bounds are loose (a busy CI machine is
//! slow, and this is a debug build); `examples/index_rss.rs` measures the release build for real. This is the only test
//! in this file because it measures the memory of the whole process.
mod common;

use common::vaults::{PATIENCE, rss_mb, temp_vault, write_vault_cards};
use oprojects_mcp::api::{Board, CardQuery};
use oprojects_mcp::vault::{VaultOptions, open_vault};
use std::time::Instant;

#[test]
fn five_thousand_cards_load_in_seconds_and_answer_in_milliseconds() {
    let dir = temp_vault();
    write_vault_cards(dir.path(), 5000);
    let before = rss_mb();

    let began = Instant::now();
    let board = open_vault(dir.path(), VaultOptions { watch: false, ..VaultOptions::default() }).unwrap();
    let opened = began.elapsed();
    let index = board.index().unwrap();
    assert!(index.wait_until_loaded(PATIENCE));
    let loaded = began.elapsed();
    assert_eq!(index.len(), 5000);
    eprintln!("open_vault returned in {opened:?}; the first load of 5,000 notes took {loaded:?}");
    assert!(opened.as_millis() < 1000, "open_vault must not wait for the load: {opened:?}");
    assert!(loaded.as_secs() < 20, "loading 5,000 notes took {loaded:?}");

    if let (Some(before), Some(after)) = (before, rss_mb()) {
        eprintln!("resident memory grew by {:.1} MB (a debug build)", after - before);
        assert!(after - before < 80.0, "the index of 5,000 cards grew the process by {:.1} MB", after - before);
    }

    let time = |label: &str, work: &dyn Fn() -> usize| {
        let began = Instant::now();
        let n = work();
        eprintln!("{label}: {n} cards in {:?}", began.elapsed());
        began.elapsed()
    };
    let list = time("list", &|| board.list().unwrap().len());
    let by_status = time("find by status", &|| {
        board.find(&CardQuery { status: vec!["doing".into()], ..CardQuery::default() }).unwrap().len()
    });
    let by_text = time("find by text", &|| {
        board.find(&CardQuery { text: Some("redirect gateway".into()), ..CardQuery::default() }).unwrap().len()
    });
    let one = time("get one", &|| usize::from(board.get("OP-2500").is_ok()));
    assert!(list.as_millis() < 500, "list took {list:?}");
    assert!(by_status.as_millis() < 500, "find by status took {by_status:?}");
    assert!(by_text.as_secs() < 5, "find by text took {by_text:?}");
    assert!(one.as_millis() < 200, "get took {one:?}");
}
