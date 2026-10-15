//! MCP server for Obsidian Projects.
//!
//! The card logic is a port of `packages/core` (TypeScript), which stays the reference implementation: the same
//! notes are read and written by the Obsidian plugin, the CLI and this server, so the three must agree byte for byte
//! on every format. `tests/fixtures` holds a corpus generated from the TypeScript core that this crate is tested
//! against, and CI fails when the corpus is stale.
pub mod error;
pub mod types;

pub use error::{Error, Result};
