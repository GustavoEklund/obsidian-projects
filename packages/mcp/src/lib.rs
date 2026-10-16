//! MCP server for Obsidian Projects.
//!
//! The card logic is a port of `packages/core` (TypeScript), which stays the reference implementation: the same
//! notes are read and written by the Obsidian plugin, the CLI and this server, so the three must agree byte for byte
//! on every format. `tests/fixtures` holds a corpus generated from the TypeScript core that this crate is tested
//! against, and CI fails when the corpus is stale.
pub mod api;
pub mod args;
pub mod body;
pub mod card;
pub mod cli;
pub mod config;
pub mod due;
pub mod error;
pub mod format;
pub mod frontmatter;
pub mod http;
pub mod index;
pub mod jscompat;
pub mod ops;
pub mod query;
pub mod rank;
pub mod server;
pub mod service;
pub mod storage;
pub mod token;
pub mod tools;
pub mod types;
pub mod vault;

pub use error::{Error, Result};
