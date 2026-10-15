//! The contract between the MCP tools and the card logic.
//!
//! `service::CardService` (the port of the TypeScript `CardService`) implements [`Board`]; the tools only know this
//! trait, so they are tested against a fake board and the service is tested without any MCP in sight.
//!
//! The trait is synchronous: every operation is a few milliseconds of file I/O or a lookup in memory. The server runs
//! them off the protocol thread (`spawn_blocking`) so a slow disk never stalls the connection.
//!
//! Lists hand out `Arc<Card>`: the index keeps one copy of each card and a call that returns 200 of them clones 200
//! pointers instead of 200 notes.
use std::sync::Arc;

use crate::error::Result;
use crate::types::{BoardConfig, Card, CardPatch, CardType, NewCardInput, Placement, Priority};

/// What a caller (a tool argument) can ask for. Friendly forms are accepted and resolved by [`Board::find`]: column
/// names as well as ids, `me`, `none`, bare card numbers. Mirrors `CardQuery` in `packages/core/src/service.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CardQuery {
    pub text: Option<String>,
    pub status: Vec<String>,
    pub card_type: Vec<CardType>,
    pub priority: Vec<Priority>,
    /// Names; `none` means unassigned; `me` means the board's configured user.
    pub assignee: Vec<String>,
    pub labels: Vec<String>,
    pub parent: Option<String>,
    /// Include done cards older than the board's archive limit (hidden by default).
    pub include_archived: bool,
}

/// A comment to add. `author` falls back to the board's configured user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentInput {
    pub text: String,
    pub author: Option<String>,
}

/// Everything the server can do to the cards of one vault.
pub trait Board: Send + Sync {
    fn config(&self) -> &BoardConfig;

    /// Every card in board order (column order, then rank), from the index when there is one.
    fn list(&self) -> Result<Vec<Arc<Card>>>;

    /// The cards matching `query`, in board order. Old done cards are left out unless `include_archived`.
    fn find(&self, query: &CardQuery) -> Result<Vec<Arc<Card>>>;

    /// One card, read from its note (never from the index): always fresh. Accepts `OP-12`, `op-12` or `12`.
    fn get(&self, key: &str) -> Result<Card>;

    fn create(&self, input: NewCardInput) -> Result<Card>;

    fn update(&self, key: &str, patch: CardPatch) -> Result<Card>;

    /// Moves a card to a column (an id or a display name), optionally before or after another card.
    fn move_card(&self, key: &str, column: &str, placement: Placement) -> Result<Card>;

    /// Moves the note to the vault's `.trash` and returns the card as it was.
    fn remove(&self, key: &str) -> Result<Card>;

    fn add_comment(&self, key: &str, comment: CommentInput) -> Result<Card>;

    fn edit_comment(&self, key: &str, comment_id: &str, text: &str) -> Result<Card>;

    fn remove_comment(&self, key: &str, comment_id: &str) -> Result<Card>;

    /// `12` becomes `OP-12` with the board's prefix; a full key is upper-cased and validated.
    fn resolve_key(&self, input: &str) -> Result<String>;

    /// Today's date (`YYYY-MM-DD`) in the user's local time, for relative due dates such as `+3d`.
    fn today(&self) -> String;
}
