//! An index owns a worker thread and a watcher; dropping it must give both back. This is the only test in this file
//! because it counts the threads of the whole process, which other tests running beside it would disturb.
#![cfg(target_os = "linux")]
mod common;

use common::vaults::{PATIENCE, eventually, temp_vault, thread_count, write_vault_cards};
use oprojects_mcp::index::{CardIndex, IndexOptions};
use oprojects_mcp::storage::FsStorage;
use oprojects_mcp::types::BoardConfig;
use oprojects_mcp::vault::{VaultOptions, open_vault};
use std::sync::Arc;
use std::time::Duration;

#[test]
fn dropping_an_index_or_a_vault_board_stops_every_thread_it_started() {
    let dir = temp_vault();
    write_vault_cards(dir.path(), 300);
    let baseline = thread_count().unwrap();

    for round in 0..3 {
        let index = CardIndex::start(
            Arc::new(FsStorage::new(dir.path())),
            BoardConfig::default(),
            IndexOptions { watch_vault_root: Some(dir.path().to_path_buf()), ..IndexOptions::default() },
        );
        assert!(index.wait_until_loaded(PATIENCE));
        assert!(thread_count().unwrap() > baseline, "round {round}: the index should have a thread of its own");
        drop(index);
        assert!(
            eventually(Duration::from_secs(10), || thread_count().unwrap() == baseline),
            "round {round}: {} threads left over after dropping the index (baseline {baseline})",
            thread_count().unwrap() - baseline
        );
    }

    let board = open_vault(dir.path(), VaultOptions::default()).unwrap();
    assert!(board.index().unwrap().wait_until_loaded(PATIENCE));
    drop(board);
    assert!(
        eventually(Duration::from_secs(10), || thread_count().unwrap() == baseline),
        "{} threads left over after dropping the vault board",
        thread_count().unwrap() - baseline
    );
}
