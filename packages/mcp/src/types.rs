//! The data model. It mirrors `packages/core/src/types.ts` and `config.ts`, which stay the reference: field names, the
//! order of the enums and the defaults must not drift (the conformance corpus under `tests/fixtures` checks it).
use serde::{Deserialize, Serialize};

pub const PRIORITIES: [Priority; 5] =
    [Priority::Highest, Priority::High, Priority::Medium, Priority::Low, Priority::Lowest];
pub const CARD_TYPES: [CardType; 4] = [CardType::Task, CardType::Story, CardType::Bug, CardType::Epic];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Highest,
    High,
    Medium,
    Low,
    Lowest,
}

impl Priority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Highest => "highest",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
            Self::Lowest => "lowest",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        PRIORITIES.into_iter().find(|p| p.as_str() == text)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CardType {
    Task,
    Story,
    Bug,
    Epic,
}

impl CardType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Task => "task",
            Self::Story => "story",
            Self::Bug => "bug",
            Self::Epic => "epic",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        CARD_TYPES.into_iter().find(|t| t.as_str() == text)
    }
}

/// Checklist progress counted from the description's `- [ ]` / `- [x]` items.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checklist {
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comment {
    /// Stable within the card; used to edit and delete.
    pub id: String,
    pub author: String,
    /// ISO timestamp. Empty when a hand-written comment has none.
    pub at: String,
    /// Markdown.
    pub text: String,
}

/// A card as read from a note. `body` is the description only; the comments section is parsed into `comments`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Card {
    pub key: String,
    /// Vault-relative path, forward slashes.
    pub path: String,
    pub title: String,
    /// Column id (see `BoardConfig::columns`).
    pub status: String,
    #[serde(rename = "type")]
    pub card_type: CardType,
    pub priority: Priority,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    pub labels: Vec<String>,
    /// `YYYY-MM-DD`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate: Option<f64>,
    /// Key of the parent card (usually an epic).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Fractional-index string; ascending order is top to bottom inside a column.
    pub rank: String,
    /// ISO timestamps.
    pub created: String,
    pub updated: String,
    /// Set while the card sits in a done column.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved: Option<String>,
    pub body: String,
    pub checklist: Checklist,
    /// Oldest first.
    pub comments: Vec<Comment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Column {
    /// Stable id stored in each card's `status`.
    pub id: String,
    /// Display name; free to rename.
    pub name: String,
    /// Cards here are "resolved".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
    /// Work-in-progress limit; `None` or 0 means unlimited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wip: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardConfig {
    /// Vault-relative folder that holds the card notes.
    pub folder: String,
    /// Project key; cards are `PREFIX-1`, `PREFIX-2`, ...
    pub prefix: String,
    pub columns: Vec<Column>,
    /// Hide done cards resolved more than this many days ago (0 means never).
    #[serde(rename = "hideDoneAfterDays")]
    pub hide_done_after_days: u32,
    /// Who "I" am, for `me` filters.
    pub me: String,
    pub members: Vec<String>,
}

impl Default for BoardConfig {
    fn default() -> Self {
        let column = |id: &str, name: &str, done: bool| Column { id: id.into(), name: name.into(), done, wip: None };
        Self {
            folder: "Cards".into(),
            prefix: "OP".into(),
            columns: vec![
                column("todo", "To Do", false),
                column("doing", "In Progress", false),
                column("review", "Review", false),
                column("done", "Done", true),
            ],
            hide_done_after_days: 14,
            me: String::new(),
            members: Vec::new(),
        }
    }
}

/// Where to drop a card inside a column. Neither means the bottom.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Placement {
    pub before: Option<String>,
    pub after: Option<String>,
}
