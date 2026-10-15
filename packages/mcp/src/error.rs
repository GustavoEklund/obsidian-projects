//! Errors shared by every module. The messages are written for the person (or agent) who reads them, so they say
//! what is wrong and what would be valid, like the TypeScript core's `ValidationError` and `NotFoundError`.
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The caller asked for something that is not valid: a bad column, a bad date, an unknown field value.
    #[error("{0}")]
    Validation(String),
    /// A card, comment or note that does not exist.
    #[error("{0} not found")]
    NotFound(String),
    /// A create raced with another writer that took the same path.
    #[error("File already exists: {0}")]
    FileExists(String),
    /// The board configuration cannot be used.
    #[error("{0}")]
    Config(String),
    /// No Obsidian vault at or above the starting folder.
    #[error("{0}")]
    VaultNotFound(String),
    /// A note could not be parsed or rewritten safely, for example broken frontmatter that must not be overwritten.
    #[error("{0}")]
    Format(String),
    #[error("I/O error on {path}: {source}")]
    Io { path: PathBuf, source: std::io::Error },
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io { path: path.into(), source }
    }
}
