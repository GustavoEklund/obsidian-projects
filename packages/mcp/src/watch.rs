//! Following cards while an agent works on them: the [`Watcher`], and the `oprojects-mcp watch` command that wraps it.
//!
//! An agent that took a card wants to hear when someone comments on it, changes it, or finishes it, whether it is busy
//! on something else or waiting for a prompt. The command is made for the `Monitor` tool of Claude Code: every line on
//! stdout is one update, a line wakes an idle session and reaches a busy one, and the command exits by itself when every
//! card it follows is done. Nothing is kept anywhere: the command *is* the subscription, so it ends with the session that
//! started it and there is nothing to clean up.
//!
//! How a card is followed:
//!
//! - **The note is read, not watched.** A few notes read twice a second cost nothing, and a poll has none of the platform
//!   quirks a file-system watcher has (see DESIGN.md). The first read is the baseline.
//! - **A quiet window.** The plugin saves while a person types, so an edit arrives as a burst. A change is told only
//!   after the note has stayed the same for `settle` (3 s by default), as one line comparing the baseline with the end of
//!   the burst: a description written in forty saves is one line, and an edit that was undone is none.
//! - **What counts** is decided by [`crate::activity`]: comments, the column, the fields, the description. The agent's
//!   own comments do not come back, but a field it changed itself does (a note does not say who wrote it), so the
//!   instructions tell the agent to ignore those.
//! - **A card that is done** gets its last line and is dropped. So does one whose note is gone.
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::activity::{already_done_line, changes, describe, removed_line};
use crate::api::Board;
use crate::card::parse_card;
use crate::config::{find_vault_root, is_done_status, load_board_config};
use crate::error::{Error, Result};
use crate::service::{CardService, ServiceOptions};
use crate::storage::{FsStorage, Storage};
use crate::types::{BoardConfig, Card};

/// How often the notes are read.
pub const POLL: Duration = Duration::from_millis(500);
/// How long a note must stay the same before what changed is told.
pub const SETTLE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateKind {
    Changed,
    /// The card is done: the last thing told about it.
    Done,
    /// The note is gone: the last thing told about it.
    Removed,
}

impl UpdateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Changed => "changed",
            Self::Done => "done",
            Self::Removed => "removed",
        }
    }
}

/// One thing to tell the agent: a single line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    pub key: String,
    pub kind: UpdateKind,
    pub line: String,
}

/// What [`Watcher::add`] found.
#[derive(Debug, Clone, PartialEq)]
pub enum Added {
    /// The card is followed from now on.
    Following(Card),
    /// The card was already in a done column, so there is nothing to follow.
    AlreadyDone(Card),
}

struct Tracked {
    key: String,
    path: String,
    /// What the agent was last told, or saw when it started.
    baseline: Card,
    /// The newest state seen since the baseline, while a burst of changes is settling.
    latest: Option<Card>,
    /// When `latest` last changed.
    changed_at: Option<Instant>,
    /// Since when the note has not been where it was.
    missing_since: Option<Instant>,
}

/// Follows cards of one vault. Time is passed in, so a test drives it without waiting.
pub struct Watcher<S: Storage + Clone> {
    storage: S,
    service: CardService<S>,
    config: BoardConfig,
    author: String,
    settle: Duration,
    tracked: Vec<Tracked>,
}

impl<S: Storage + Clone> Watcher<S> {
    /// `author` is who the agent's comments are signed by: they are not told back to it.
    pub fn new(storage: S, config: BoardConfig, author: &str, settle: Duration) -> Self {
        let service = CardService::new(storage.clone(), config.clone(), ServiceOptions::default());
        Self { storage, service, config, author: author.to_string(), settle, tracked: Vec::new() }
    }

    /// Starts following a card (`OP-12`, or just `12`). Following one that is already followed changes nothing.
    pub fn add(&mut self, input: &str) -> Result<Added> {
        let key = self.service.resolve_key(input)?;
        let card = self.service.get(&key)?;
        if is_done_status(&self.config, &card.status) {
            return Ok(Added::AlreadyDone(card));
        }
        if !self.tracked.iter().any(|t| t.key == key) {
            self.tracked.push(Tracked {
                key,
                path: card.path.clone(),
                baseline: card.clone(),
                latest: None,
                changed_at: None,
                missing_since: None,
            });
        }
        Ok(Added::Following(card))
    }

    /// No card is followed.
    pub fn is_empty(&self) -> bool {
        self.tracked.is_empty()
    }

    /// Reads the followed notes and returns what is to be told now. A card that is done or gone is dropped after its
    /// last update.
    pub fn poll(&mut self, now: Instant) -> Vec<Update> {
        let Self { storage, service, config, author, settle, tracked } = self;
        let mut updates = Vec::new();
        tracked.retain_mut(|card| match step(card, storage, service, config, author, *settle, now) {
            Some(update) => {
                let last = update.kind != UpdateKind::Changed;
                updates.push(update);
                !last
            }
            None => true,
        });
        updates
    }
}

/// Looks at one card. `Some` when there is something to tell about it.
fn step<S: Storage + Clone>(
    card: &mut Tracked,
    storage: &S,
    service: &CardService<S>,
    config: &BoardConfig,
    author: &str,
    settle: Duration,
    now: Instant,
) -> Option<Update> {
    match storage.read(&card.path) {
        Ok(content) => {
            card.missing_since = None;
            // A note that cannot be read as this card right now (half-edited by hand) says nothing: look again later.
            if let Some(current) = parse_card(&card.path, &content).filter(|c| c.key == card.key) {
                observe(card, current, now);
            }
        }
        Err(Error::NotFound(_)) => {
            let since = *card.missing_since.get_or_insert(now);
            if now.duration_since(since) >= settle {
                // Moved or renamed notes are found by their key; a note that is nowhere is a deleted card.
                match service.get(&card.key) {
                    Ok(current) => {
                        card.path = current.path.clone();
                        card.missing_since = None;
                        observe(card, current, now);
                    }
                    Err(Error::NotFound(_)) => {
                        return Some(Update {
                            key: card.key.clone(),
                            kind: UpdateKind::Removed,
                            line: removed_line(&card.key),
                        });
                    }
                    Err(_) => {}
                }
            }
        }
        Err(_) => {}
    }

    let (changed_at, latest) = (card.changed_at?, card.latest.as_ref()?);
    if now.duration_since(changed_at) < settle {
        return None;
    }
    let found = changes(&card.baseline, latest, config, author);
    let line = describe(latest, &found);
    let finished = found.iter().any(|c| matches!(c, crate::activity::Change::Done { .. }));
    card.baseline = card.latest.take()?;
    card.changed_at = None;
    if line.is_empty() {
        return None;
    }
    let kind = if finished { UpdateKind::Done } else { UpdateKind::Changed };
    Some(Update { key: card.key.clone(), kind, line })
}

/// Notes `current` as the newest state, restarting the quiet window when it is not what was last seen.
fn observe(card: &mut Tracked, current: Card, now: Instant) {
    let last = card.latest.as_ref().unwrap_or(&card.baseline);
    if current != *last {
        card.latest = Some(current);
        card.changed_at = Some(now);
    }
}

// --- the command ----------------------------------------------------------------------------------------------------

/// `text` as one word for a POSIX shell: left alone when it holds only characters a shell reads as themselves, else in
/// single quotes.
pub fn shell_word(text: &str) -> String {
    let plain = !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+' | ':' | '@' | ','));
    if plain { text.to_string() } else { format!("'{}'", text.replace('\'', "'\\''")) }
}

/// The command line that follows cards of `vault` for `author`, up to where the card keys go: what the agent is told to
/// run.
pub fn command_line(program: &str, vault: &Path, author: &str) -> String {
    format!(
        "{} watch --vault {} --author {}",
        shell_word(program),
        shell_word(&vault.display().to_string()),
        shell_word(author)
    )
}

/// What `oprojects-mcp watch` was asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchArgs {
    /// Card keys, as typed (`OP-12` or `12`).
    pub keys: Vec<String>,
    pub vault: Option<String>,
    /// Who the agent's comments are signed by.
    pub author: String,
    pub settle: Duration,
}

/// Follows the cards until every one is done or gone, printing one line per update on `out` (flushed at once: a line that
/// waits in a buffer is an update that does not arrive). What is not an update goes to `err`. A closed `out` ends the
/// command quietly: whoever was reading is gone.
pub fn run(args: &WatchArgs, cwd: &Path, out: &mut dyn Write, err: &mut dyn Write) -> Result<()> {
    let root = find_vault_root(cwd, args.vault.as_deref())?;
    let config = load_board_config(&root);
    let mut watcher = Watcher::new(Arc::new(FsStorage::new(&root)), config.clone(), &args.author, args.settle);

    let mut following = Vec::new();
    for key in &args.keys {
        match watcher.add(key)? {
            Added::Following(card) => following.push(card.key),
            Added::AlreadyDone(card) => {
                if emit(out, &already_done_line(&card, &config)).is_err() {
                    return Ok(());
                }
            }
        }
    }
    if watcher.is_empty() {
        return Ok(());
    }
    let _ = writeln!(
        err,
        "oprojects-mcp: following {}: one line per update, and it ends when every card is done",
        following.join(", ")
    );
    while !watcher.is_empty() {
        std::thread::sleep(POLL);
        for update in watcher.poll(Instant::now()) {
            if emit(out, &update.line).is_err() {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn emit(out: &mut dyn Write, line: &str) -> std::io::Result<()> {
    writeln!(out, "{line}")?;
    out.flush()
}
