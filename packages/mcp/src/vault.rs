//! Opening a vault: the composition root that turns a folder on disk into a [`Board`].
//!
//! ```no_run
//! use oprojects_mcp::vault::{VaultOptions, open_vault};
//! # fn main() -> oprojects_mcp::Result<()> {
//! // Read the local time zone first thing, while the process still has a single thread (see `local_utc_offset_minutes`);
//! // `open_vault` does it for you when `utc_offset_minutes` is `None`, as long as it is called before anything spawns.
//! let board = open_vault(std::path::Path::new("/home/me/Vault"), VaultOptions::default())?;
//! // `board` implements `oprojects_mcp::api::Board`: hand it to the tools.
//! # drop(board);
//! # Ok(()) }
//! ```
//!
//! The signature is stable on purpose: `open_vault(root: &Path, options: VaultOptions) -> Result<Arc<VaultBoard>>`.
//! The root is the vault folder itself (the one with `.obsidian` in it): find it with
//! [`find_vault_root`](crate::config::find_vault_root).
//!
//! What it does: loads the board configuration (tolerantly: a missing or hand-edited `data.json` falls back to the
//! defaults), builds the file storage, starts the [`CardIndex`](crate::index::CardIndex) (in the background, watching the
//! cards folder), and wraps it all in a [`CardService`] that takes the cards from the index and tells it about every
//! write. Dropping the last `Arc<VaultBoard>` stops the index's threads.
use crate::api::{Board, CardQuery, CommentInput};
use crate::config::load_board_config;
use crate::error::{Error, Result};
use crate::index::{CardIndex, IndexOptions};
use crate::service::{CardService, Clock, IdGenerator, ServiceOptions, local_utc_offset_minutes};
use crate::storage::FsStorage;
use crate::types::{BoardConfig, Card, CardPatch, NewCardInput, Placement};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct VaultOptions {
    /// Keep the cards in an in-memory index. `false` scans the vault on every list, which is only for tiny vaults and
    /// tests.
    pub use_index: bool,
    /// Tuning of the index. `watch_vault_root` is filled in by [`open_vault`] unless `watch` is `false`.
    pub index: IndexOptions,
    /// Watch the cards folder for changes made by others. `false` relies on the periodic reconciliation alone.
    pub watch: bool,
    /// The local time zone's offset in minutes east of UTC. `None` reads it (see [`local_utc_offset_minutes`]).
    pub utc_offset_minutes: Option<i32>,
    /// Injectable clock (tests).
    pub clock: Option<Clock>,
    /// Injectable comment id generator (tests).
    pub new_id: Option<IdGenerator>,
}

impl Default for VaultOptions {
    fn default() -> Self {
        Self {
            use_index: true,
            index: IndexOptions::default(),
            watch: true,
            utc_offset_minutes: None,
            clock: None,
            new_id: None,
        }
    }
}

/// A vault's cards: the service over the files, with the index that makes reads cheap.
pub struct VaultBoard {
    root: PathBuf,
    service: CardService<Arc<FsStorage>>,
    index: Option<Arc<CardIndex>>,
}

impl VaultBoard {
    /// The vault's folder.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The in-memory index, when there is one.
    pub fn index(&self) -> Option<&Arc<CardIndex>> {
        self.index.as_ref()
    }

    /// The service itself, for callers that need more than [`Board`] offers.
    pub fn service(&self) -> &CardService<Arc<FsStorage>> {
        &self.service
    }
}

pub fn open_vault(root: &Path, options: VaultOptions) -> Result<Arc<VaultBoard>> {
    if !root.is_dir() {
        return Err(Error::VaultNotFound(format!("{} is not a folder", root.display())));
    }
    // Before any thread exists: the time zone cannot be read soundly afterwards.
    let utc_offset_minutes = options.utc_offset_minutes.unwrap_or_else(local_utc_offset_minutes);

    let config: BoardConfig = load_board_config(root);
    let storage = Arc::new(FsStorage::new(root));

    let index = options.use_index.then(|| {
        let mut index_options = options.index.clone();
        if options.watch {
            index_options.watch_vault_root = Some(storage.root().to_path_buf());
        }
        CardIndex::start(Arc::clone(&storage), config.clone(), index_options)
    });

    let mut service_options = ServiceOptions { utc_offset_minutes, ..ServiceOptions::default() };
    if let Some(clock) = options.clock {
        service_options.clock = clock;
    }
    if let Some(new_id) = options.new_id {
        service_options.new_id = new_id;
    }
    service_options.source = index.as_ref().map(|i| Arc::clone(i) as Arc<dyn crate::service::CardSource>);

    Ok(Arc::new(VaultBoard {
        root: storage.root().to_path_buf(),
        service: CardService::new(storage, config, service_options),
        index,
    }))
}

impl Board for VaultBoard {
    fn config(&self) -> &BoardConfig {
        self.service.config()
    }

    fn list(&self) -> Result<Vec<Arc<Card>>> {
        self.service.list()
    }

    fn find(&self, query: &CardQuery) -> Result<Vec<Arc<Card>>> {
        self.service.find(query)
    }

    fn get(&self, key: &str) -> Result<Card> {
        self.service.get(key)
    }

    fn create(&self, input: NewCardInput) -> Result<Card> {
        self.service.create(input)
    }

    fn update(&self, key: &str, patch: CardPatch) -> Result<Card> {
        self.service.update(key, patch)
    }

    fn move_card(&self, key: &str, column: &str, placement: Placement) -> Result<Card> {
        self.service.move_card(key, column, placement)
    }

    fn remove(&self, key: &str) -> Result<Card> {
        self.service.remove(key)
    }

    fn add_comment(&self, key: &str, comment: CommentInput) -> Result<Card> {
        self.service.add_comment(key, comment)
    }

    fn edit_comment(&self, key: &str, comment_id: &str, text: &str) -> Result<Card> {
        self.service.edit_comment(key, comment_id, text)
    }

    fn remove_comment(&self, key: &str, comment_id: &str) -> Result<Card> {
        self.service.remove_comment(key, comment_id)
    }

    fn resolve_key(&self, input: &str) -> Result<String> {
        self.service.resolve_key(input)
    }

    fn today(&self) -> String {
        self.service.today()
    }
}
