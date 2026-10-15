//! What each tool does, apart from MCP: the argument types (their doc comments become the schema every agent reads, so
//! they are terse on purpose) and one function per tool that takes a [`Board`] and returns the text to show. Keeping
//! this separate from `tools.rs`, which only registers these with the protocol, lets every behavior be tested against a
//! plain fake board.
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rmcp::schemars;
use serde::{Deserialize, Deserializer};

use crate::api::{Board, CardQuery, CommentInput};
use crate::due::{parse_civil_date, parse_due};
use crate::error::{Error, Result};
use crate::format::{self, DEFAULT_LIMIT, MAX_LIMIT};
use crate::query::{CivilDate, Now};
use crate::types::{Card, CardPatch, CardType, NewCardInput, Placement, Priority};

// --- argument helpers ---------------------------------------------------------------------------------------------

/// `["a", "b"]`, or just `"a"`: models sometimes pass a single value where a list is asked for.
fn one_or_many<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        Many(Vec<String>),
        One(String),
    }
    Ok(match Option::<OneOrMany>::deserialize(deserializer)? {
        Some(OneOrMany::Many(many)) => many,
        Some(OneOrMany::One(one)) => vec![one],
        None => Vec::new(),
    })
}

/// Tells an absent field (`None`: leave it alone) from an explicit `null` (`Some(None)`: clear it).
fn clearable<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

// `type` as it appears in tool arguments. Not a doc comment: those become the schema's description, which the model
// reads, and the variants themselves already say what is valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TypeArg {
    Task,
    Story,
    Bug,
    Epic,
}

impl From<TypeArg> for CardType {
    fn from(value: TypeArg) -> Self {
        match value {
            TypeArg::Task => Self::Task,
            TypeArg::Story => Self::Story,
            TypeArg::Bug => Self::Bug,
            TypeArg::Epic => Self::Epic,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PriorityArg {
    Highest,
    High,
    Medium,
    Low,
    Lowest,
}

impl From<PriorityArg> for Priority {
    fn from(value: PriorityArg) -> Self {
        match value {
            PriorityArg::Highest => Self::Highest,
            PriorityArg::High => Self::High,
            PriorityArg::Medium => Self::Medium,
            PriorityArg::Low => Self::Low,
            PriorityArg::Lowest => Self::Lowest,
        }
    }
}

// --- arguments ----------------------------------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListCards {
    /// Column ids or names.
    #[serde(default, deserialize_with = "one_or_many")]
    #[schemars(with = "Vec<String>")]
    pub status: Vec<String>,
    #[serde(default, rename = "type")]
    pub card_type: Vec<TypeArg>,
    #[serde(default)]
    pub priority: Vec<PriorityArg>,
    /// Names, `me`, or `none` for unassigned.
    #[serde(default, deserialize_with = "one_or_many")]
    #[schemars(with = "Vec<String>")]
    pub assignee: Vec<String>,
    #[serde(default, deserialize_with = "one_or_many")]
    #[schemars(with = "Vec<String>")]
    pub labels: Vec<String>,
    /// Parent (epic) key.
    pub parent: Option<String>,
    /// Words to find in title, description, labels and comments, ignoring case and accents.
    pub text: Option<String>,
    /// Include done cards older than the archive limit.
    #[serde(default)]
    pub include_archived: bool,
    /// Most cards to return. Default 50, max 200.
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct KeyArgs {
    /// Card key: `OP-12`, or just `12`.
    pub key: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateCard {
    pub title: String,
    /// Column id or name. Default: the first column.
    pub status: Option<String>,
    #[serde(rename = "type")]
    pub card_type: Option<TypeArg>,
    pub priority: Option<PriorityArg>,
    pub assignee: Option<String>,
    pub labels: Option<Vec<String>>,
    /// `YYYY-MM-DD`, `today`, `tomorrow`, `+3d` or `+2w`.
    pub due: Option<String>,
    pub estimate: Option<f64>,
    /// Parent (epic) key.
    pub parent: Option<String>,
    /// Description, in Markdown. `- [ ]` makes a checklist.
    pub body: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateCard {
    pub key: String,
    pub title: Option<String>,
    #[serde(rename = "type")]
    pub card_type: Option<TypeArg>,
    pub priority: Option<PriorityArg>,
    /// null removes the assignee.
    #[serde(default, deserialize_with = "clearable")]
    #[schemars(with = "Option<String>")]
    pub assignee: Option<Option<String>>,
    /// Replaces all labels.
    pub labels: Option<Vec<String>>,
    /// `YYYY-MM-DD`, `today`, `tomorrow`, `+3d` or `+2w`; null clears.
    #[serde(default, deserialize_with = "clearable")]
    #[schemars(with = "Option<String>")]
    pub due: Option<Option<String>>,
    /// null clears.
    #[serde(default, deserialize_with = "clearable")]
    #[schemars(with = "Option<f64>")]
    pub estimate: Option<Option<f64>>,
    /// Parent (epic) key; null removes it.
    #[serde(default, deserialize_with = "clearable")]
    #[schemars(with = "Option<String>")]
    pub parent: Option<Option<String>>,
    /// Replaces the description; comments are kept.
    pub body: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MoveCard {
    pub key: String,
    /// Column id or name.
    pub column: String,
    /// Place above this card.
    pub before: Option<String>,
    /// Place below this card.
    pub after: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AddComment {
    pub key: String,
    /// Markdown.
    pub text: String,
    /// Default: the author this server was started with.
    pub author: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EditComment {
    pub key: String,
    /// Id shown by get_card.
    pub comment_id: String,
    /// The new text.
    pub text: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteComment {
    pub key: String,
    /// Id shown by get_card.
    pub comment_id: String,
}

// --- the tools ----------------------------------------------------------------------------------------------------

/// The clock for rules that depend on "now": the instant, and today's date where the user is.
fn now_for(board: &dyn Board) -> Now {
    let epoch_ms =
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
    let today =
        parse_civil_date(&board.today()).unwrap_or_else(|| CivilDate::from_epoch_days(epoch_ms.div_euclid(86_400_000)));
    Now { epoch_ms, local_date: today }
}

fn today_of(board: &dyn Board) -> CivilDate {
    now_for(board).local_date
}

fn line(board: &dyn Board, card: &Card) -> String {
    format::card_line(card, board.config(), &now_for(board))
}

fn none_if_blank(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

pub fn list_cards(board: &dyn Board, args: ListCards) -> Result<String> {
    let limit = args.limit.map_or(DEFAULT_LIMIT, |l| l as usize).clamp(1, MAX_LIMIT);
    let query = CardQuery {
        text: none_if_blank(args.text),
        status: args.status,
        card_type: args.card_type.into_iter().map(Into::into).collect(),
        priority: args.priority.into_iter().map(Into::into).collect(),
        assignee: args.assignee,
        labels: args.labels,
        parent: none_if_blank(args.parent),
        include_archived: args.include_archived,
    };
    let found = board.find(&query)?;
    let shown = &found[..found.len().min(limit)];
    Ok(format::card_list(shown, found.len(), board.config(), &now_for(board)))
}

pub fn get_card(board: &dyn Board, args: KeyArgs) -> Result<String> {
    let card = board.get(&args.key)?;
    Ok(format::card_block(&card, board.config(), &now_for(board)))
}

pub fn create_card(board: &dyn Board, args: CreateCard) -> Result<String> {
    let due = args.due.map(|d| parse_due(&d, today_of(board))).transpose()?;
    let card = board.create(NewCardInput {
        title: args.title,
        status: none_if_blank(args.status),
        card_type: args.card_type.map(Into::into),
        priority: args.priority.map(Into::into),
        assignee: none_if_blank(args.assignee),
        labels: args.labels,
        due,
        estimate: args.estimate,
        parent: none_if_blank(args.parent),
        body: args.body,
        rank: None,
    })?;
    Ok(format!("Created: {}", line(board, &card)))
}

pub fn update_card(board: &dyn Board, args: UpdateCard) -> Result<String> {
    let due = match args.due {
        Some(Some(text)) => Some(Some(parse_due(&text, today_of(board))?)),
        Some(None) => Some(None),
        None => None,
    };
    let patch = CardPatch {
        title: args.title,
        status: None,
        card_type: args.card_type.map(Into::into),
        priority: args.priority.map(Into::into),
        assignee: args.assignee,
        labels: args.labels,
        due,
        estimate: args.estimate,
        parent: args.parent,
        rank: None,
        body: args.body,
    };
    let touches_nothing = patch.title.is_none()
        && patch.card_type.is_none()
        && patch.priority.is_none()
        && patch.assignee.is_none()
        && patch.labels.is_none()
        && patch.due.is_none()
        && patch.estimate.is_none()
        && patch.parent.is_none()
        && patch.body.is_none();
    if touches_nothing {
        return Err(Error::validation(
            "Nothing to change: give at least one field besides key (to change the column use move_card)",
        ));
    }
    let card = board.update(&args.key, patch)?;
    Ok(format!("Updated: {}", line(board, &card)))
}

pub fn move_card(board: &dyn Board, args: MoveCard) -> Result<String> {
    let placement = Placement { before: none_if_blank(args.before), after: none_if_blank(args.after) };
    let card = board.move_card(&args.key, &args.column, placement)?;
    Ok(format!("Moved: {}", line(board, &card)))
}

pub fn delete_card(board: &dyn Board, args: KeyArgs) -> Result<String> {
    let card = board.remove(&args.key)?;
    Ok(format!(
        "Deleted {} (\"{}\"). The note was moved to the vault's .trash, where it can be restored from.",
        card.key,
        card.title.replace('"', "'")
    ))
}

pub fn add_comment(board: &dyn Board, args: AddComment, default_author: &str) -> Result<String> {
    let author = none_if_blank(args.author).unwrap_or_else(|| default_author.to_string());
    let card = board.add_comment(&args.key, CommentInput { text: args.text, author: Some(author) })?;
    let id = card.comments.last().map_or("?", |c| c.id.as_str());
    Ok(format!("Added comment {id} to {} ({} in all).", card.key, card.comments.len()))
}

pub fn edit_comment(board: &dyn Board, args: EditComment) -> Result<String> {
    let card = board.edit_comment(&args.key, &args.comment_id, &args.text)?;
    Ok(format!("Edited comment {} of {}.", args.comment_id, card.key))
}

pub fn delete_comment(board: &dyn Board, args: DeleteComment) -> Result<String> {
    let card = board.remove_comment(&args.key, &args.comment_id)?;
    Ok(format!("Deleted comment {} from {} ({} left).", args.comment_id, card.key, card.comments.len()))
}

pub fn board_summary(board: &dyn Board) -> Result<String> {
    let everything: Vec<Arc<Card>> = board.find(&CardQuery { include_archived: true, ..CardQuery::default() })?;
    let visible: Vec<Arc<Card>> = board.find(&CardQuery::default())?;
    let hidden = everything.len().saturating_sub(visible.len());
    Ok(format::board_summary(board.config(), &visible, hidden, &now_for(board)))
}
