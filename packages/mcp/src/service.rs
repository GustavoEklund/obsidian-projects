//! Everything you can do to cards, independent of where the notes live: a port of `CardService` in
//! `packages/core/src/service.ts`, which is the reference. The order in which things are validated, and the exact text
//! of every message, are the TypeScript's: an agent reads these messages and acts on them (they list what would be
//! valid), so a different wording is a different server.
//!
//! # Where the cards come from
//!
//! Without a [`CardSource`] every operation that needs the other cards (the next key, the rank of a move, a parent that
//! must exist, `list`, `find`) reads the whole vault, which is what the TypeScript does by default. With one (the
//! in-memory [`CardIndex`](crate::index::CardIndex)) those operations take the cards from memory, and the service tells
//! the source about its own writes ([`CardSource::refresh_path`]) so a caller always reads its own writes.
//! `get` and every write go to the note itself, never to the source: a single card is always fresh.
//!
//! # Time
//!
//! The clock is injectable (milliseconds since the epoch) and so is the comment id generator, which makes the service
//! deterministic in tests. Timestamps are `YYYY-MM-DDTHH:mm:ss.sssZ`. Rust cannot read the local time zone without
//! `unsafe` code, so the service is given the local offset it should write in comment titles and use for "today":
//! [`local_utc_offset_minutes`] reads it, and has limits worth knowing, documented there.
use crate::api::{Board, CardQuery, CommentInput};
use crate::body::{
    add_comment_to_body, clean_author, edit_comment_in_body, join_body, remove_comment_from_body, split_body,
};
use crate::card::{
    count_checklist, is_valid_date, is_valid_key, key_number, new_card_content, normalize_labels, parse_card,
};
use crate::config::{display_column, is_done_status, resolve_column};
use crate::error::{Error, Result};
use crate::frontmatter::{patch_frontmatter, split_frontmatter};
use crate::jscompat::{is_js_whitespace, iso_string, js_trim, js_trim_end, js_trim_start, number_to_js_string};
use crate::query::{
    CardFilter, Now, UNASSIGNED, filter_cards, is_archived_done, local_date, rank_for_placement, sort_cards,
};
use crate::storage::{Storage, modify_with};
use crate::types::{BoardConfig, CARD_TYPES, Card, CardPatch, CardType, NewCardInput, PRIORITIES, Placement, Priority};
use serde_json::{Number, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// How many consecutive keys `create` tries before giving up (the TypeScript's `MAX_KEY_ATTEMPTS`).
const MAX_KEY_ATTEMPTS: usize = 8;

/// Below this many notes a scan reads them on the calling thread: starting threads would cost more than it saves.
const PARALLEL_SCAN_FROM: usize = 64;

/// A source of the current cards other than scanning the storage, which is what makes reads cheap: the in-memory index.
pub trait CardSource: Send + Sync {
    /// Every card, as one consistent set, in any order.
    fn cards(&self) -> Vec<Arc<Card>>;
    /// The note at `path` was just written by the service: look at it again now, so the next read sees the write.
    fn refresh_path(&self, path: &str);
    /// The note at `path` was just removed by the service.
    fn forget_path(&self, path: &str);
}

/// Milliseconds since the Unix epoch.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
/// Makes comment ids. Ids only have to be unique within a card; the service asks again when one is taken.
pub type IdGenerator = Arc<dyn Fn() -> String + Send + Sync>;

pub struct ServiceOptions {
    pub clock: Clock,
    pub new_id: IdGenerator,
    /// Where `list`, `find` and the allocation of keys and ranks take the cards from. `None` scans the storage.
    pub source: Option<Arc<dyn CardSource>>,
    /// The local time zone's offset east of UTC, in minutes: what comment titles show and what "today" means.
    pub utc_offset_minutes: i32,
}

impl Default for ServiceOptions {
    fn default() -> Self {
        Self { clock: Arc::new(system_clock_ms), new_id: Arc::new(random_id), source: None, utc_offset_minutes: 0 }
    }
}

/// The system clock in milliseconds since the epoch.
pub fn system_clock_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Five random base-36 characters, like the TypeScript's default (`Math.random().toString(36)`).
pub fn random_id() -> String {
    use std::hash::{BuildHasher, Hasher, RandomState};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_i64(system_clock_ms());
    let mut n = hasher.finish();
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    (0..5)
        .map(|_| {
            let c = ALPHABET[(n % 36) as usize] as char;
            n /= 36;
            c
        })
        .collect()
}

/// The local time zone's offset east of UTC in minutes, or 0 (UTC) when it cannot be determined.
///
/// Reading the zone is only sound while the process has a single thread, so the `time` crate refuses once others
/// exist (and so does this function, falling back to UTC). Call it first thing in `main`, before the runtime or the
/// index start any thread. Limits: the offset is read once and kept, so a process that runs across a daylight saving
/// change keeps the old offset until it restarts. That only affects the time shown in a comment's title (the machine
/// readable timestamp is always UTC) and which date counts as "today" for an hour around midnight.
pub fn local_utc_offset_minutes() -> i32 {
    time::UtcOffset::current_local_offset().map_or(0, |offset| i32::from(offset.whole_minutes()))
}

/// `Invalid type "x" (task, story, bug, epic)` for a type that is not one of the four.
pub fn parse_card_type(text: &str) -> Result<CardType> {
    CardType::parse(text).ok_or_else(|| {
        let valid: Vec<&str> = CARD_TYPES.iter().map(|t| t.as_str()).collect();
        Error::validation(format!("Invalid type \"{text}\" ({})", valid.join(", ")))
    })
}

/// `Invalid priority "x" (highest, high, medium, low, lowest)` for a priority that is not one of the five.
pub fn parse_priority(text: &str) -> Result<Priority> {
    Priority::parse(text).ok_or_else(|| {
        let valid: Vec<&str> = PRIORITIES.iter().map(|p| p.as_str()).collect();
        Error::validation(format!("Invalid priority \"{text}\" ({})", valid.join(", ")))
    })
}

fn clean_text(text: &str) -> Result<String> {
    let mut t = text.replace("\r\n", "\n");
    t.truncate(js_trim_end(&t).len());
    // `^\s*\n`: the leading white space up to and including the last newline in it
    let leading = t.len() - js_trim_start(&t).len();
    if let Some(newline) = t[..leading].rfind('\n') {
        t.drain(..=newline);
    }
    if js_trim(&t).is_empty() {
        return Err(Error::validation("A comment cannot be empty"));
    }
    Ok(t)
}

fn clean_title(title: &str) -> Result<String> {
    let mut collapsed = String::with_capacity(title.len());
    let mut in_space = false;
    for c in title.chars() {
        if is_js_whitespace(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    match js_trim(&collapsed) {
        "" => Err(Error::validation("Title cannot be empty")),
        title => Ok(title.to_string()),
    }
}

fn check_estimate(n: f64) -> Result<()> {
    if !n.is_finite() || n < 0.0 {
        return Err(Error::validation(format!(
            "Invalid estimate \"{}\" (expected a number >= 0)",
            number_to_js_string(n)
        )));
    }
    Ok(())
}

fn text_value(s: &str) -> Value {
    Value::String(s.to_string())
}

fn number_value(n: f64) -> Value {
    Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// The frontmatter changes of an update, in the order the TypeScript's object gets its keys: a key that is set again
/// keeps its first position, and new keys are appended to the note in this order.
#[derive(Default)]
struct Changes(Vec<(String, Value)>);

impl Changes {
    fn set(&mut self, key: &str, value: Value) {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key.to_string(), value)),
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct CardService<S: Storage> {
    storage: S,
    config: BoardConfig,
    options: ServiceOptions,
    /// Creates run one after another, so parallel callers each see the cards the previous one wrote and get
    /// consecutive keys instead of colliding.
    creating: Mutex<()>,
}

impl<S: Storage> CardService<S> {
    pub fn new(storage: S, config: BoardConfig, options: ServiceOptions) -> Self {
        Self { storage, config, options, creating: Mutex::new(()) }
    }

    pub fn storage(&self) -> &S {
        &self.storage
    }

    fn now_ms(&self) -> i64 {
        (self.options.clock)()
    }

    fn now_iso(&self) -> String {
        iso_string(self.now_ms()).unwrap_or_default()
    }

    /// Reads every note of the cards folder. A note that cannot be read or is not a card is skipped: one bad note must
    /// not take the board down.
    pub fn scan(&self) -> Result<Vec<Arc<Card>>> {
        let paths = self.storage.list_markdown(&self.config.folder)?;
        let read = |path: &String| self.storage.read(path).ok().and_then(|content| parse_card(path, &content));
        let cards: Vec<Card> = if paths.len() < PARALLEL_SCAN_FROM {
            paths.iter().filter_map(read).collect()
        } else {
            let workers = std::thread::available_parallelism().map_or(2, usize::from).clamp(2, 8);
            let next = AtomicUsize::new(0);
            std::thread::scope(|scope| {
                let handles: Vec<_> = (0..workers)
                    .map(|_| {
                        scope.spawn(|| {
                            let mut found = Vec::new();
                            loop {
                                let i = next.fetch_add(1, Ordering::Relaxed);
                                let Some(path) = paths.get(i) else { break };
                                found.extend(read(path));
                            }
                            found
                        })
                    })
                    .collect();
                handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
            })
        };
        Ok(cards.into_iter().map(Arc::new).collect())
    }

    /// The cards the next key, the next rank and the parent checks look at: the source's, or a fresh scan.
    fn cards(&self) -> Result<Vec<Arc<Card>>> {
        match &self.options.source {
            Some(source) => Ok(source.cards()),
            None => self.scan(),
        }
    }

    /// Tells the source that the note at `path` was just written.
    fn wrote(&self, path: &str) {
        if let Some(source) = &self.options.source {
            source.refresh_path(path);
        }
    }

    pub fn check_status(&self, id_or_name: &str) -> Result<String> {
        match resolve_column(&self.config, id_or_name) {
            Some(column) => Ok(column.id.clone()),
            None => {
                let valid: Vec<&str> = self.config.columns.iter().map(|c| c.id.as_str()).collect();
                Err(Error::validation(format!("Unknown status \"{id_or_name}\" (valid: {})", valid.join(", "))))
            }
        }
    }

    /// Reads one card's note: `OP-12`, `op-12` and `12` all mean the same card.
    fn read_card(&self, input: &str) -> Result<Card> {
        let key = self.resolve_key(input)?;
        let direct = format!("{}/{key}.md", self.config.folder);
        if let Ok(content) = self.storage.read(&direct)
            && let Some(card) = parse_card(&direct, &content)
            && card.key == key
        {
            return Ok(card);
        }
        // The note is not where its key says (somebody renamed it): find it.
        let path = match &self.options.source {
            // Ask the index where it is, then read that note itself.
            Some(source) => source.cards().iter().find(|c| c.key == key).map(|c| c.path.clone()),
            None => self.scan()?.iter().find(|c| c.key == key).map(|c| c.path.clone()),
        };
        path.and_then(|p| self.storage.read(&p).ok().and_then(|content| parse_card(&p, &content)))
            .filter(|card| card.key == key)
            .ok_or_else(|| Error::NotFound(format!("Card {key}")))
    }

    fn create_now(&self, input: NewCardInput) -> Result<Card> {
        let title = clean_title(&input.title)?;
        let status = match &input.status {
            None => self.config.columns[0].id.clone(),
            Some(status) => self.check_status(status)?,
        };
        let card_type = input.card_type.unwrap_or(CardType::Task);
        let priority = input.priority.unwrap_or(Priority::Medium);
        if let Some(due) = &input.due
            && !is_valid_date(due)
        {
            return Err(Error::validation(format!("Invalid due date \"{due}\" (expected YYYY-MM-DD)")));
        }
        if let Some(estimate) = input.estimate {
            check_estimate(estimate)?;
        }

        let cards = self.cards()?;
        let mut parent = input.parent.clone();
        if let Some(requested) = input.parent.as_deref().filter(|p| !p.is_empty()) {
            let resolved = self.resolve_key(requested)?;
            if !cards.iter().any(|c| c.key == resolved) {
                return Err(Error::validation(format!("Parent card {resolved} does not exist")));
            }
            parent = Some(resolved);
        }

        let now_iso = self.now_iso();
        let rank = match &input.rank {
            Some(rank) => rank.clone(),
            None => rank_for_placement(&cards, &self.config, "", &status, &Placement::default())?,
        };
        let mut n = cards.iter().filter_map(|c| key_number(&c.key, &self.config.prefix)).fold(0.0_f64, f64::max) + 1.0;
        let body = input.body.clone().unwrap_or_default();

        for _ in 0..MAX_KEY_ATTEMPTS {
            let key = format!("{}-{}", self.config.prefix, number_to_js_string(n));
            let path = format!("{}/{key}.md", self.config.folder);
            let card = Card {
                key,
                path: path.clone(),
                title: title.clone(),
                status: status.clone(),
                card_type,
                priority,
                assignee: input.assignee.as_deref().map(js_trim).filter(|a| !a.is_empty()).map(str::to_string),
                labels: normalize_labels(input.labels.as_deref().unwrap_or(&[])),
                due: input.due.clone(),
                estimate: input.estimate,
                parent: parent.clone(),
                rank: rank.clone(),
                created: now_iso.clone(),
                updated: now_iso.clone(),
                resolved: is_done_status(&self.config, &status).then(|| now_iso.clone()),
                checklist: count_checklist(&body),
                body: body.clone(),
                comments: Vec::new(),
            };
            let content = new_card_content(&card, self.options.utc_offset_minutes)?;
            match self.storage.create(&path, &content) {
                Ok(()) => {
                    self.wrote(&path);
                    return parse_card(&path, &content)
                        .ok_or_else(|| Error::Format(format!("the note just written for {} is not a card", card.key)));
                }
                // someone (the plugin, the CLI, another server) took this number first
                Err(Error::FileExists(_)) => n += 1.0,
                Err(e) => return Err(e),
            }
        }
        Err(Error::Format(format!("Could not allocate a free key after {MAX_KEY_ATTEMPTS} attempts")))
    }

    /// Rewrites the description and comments of a card atomically, against the freshest content, touching nothing
    /// else but `updated`. `change` gets the note's body and returns the new one, or `None` when what it was asked to
    /// change is not there.
    fn mutate_body(
        &self,
        card: Card,
        change: impl FnOnce(&str) -> Option<String>,
        not_found: Option<String>,
    ) -> Result<Card> {
        let updated = text_value(&self.now_iso());
        let content = modify_with(&self.storage, &card.path, |current| {
            let next = change(split_frontmatter(current).body)
                .ok_or_else(|| Error::NotFound(not_found.unwrap_or_else(|| card.key.clone())))?;
            patch_frontmatter(current, &[("updated", updated)], Some(&next))
        })?;
        self.wrote(&card.path);
        Ok(parse_card(&card.path, &content).unwrap_or(card))
    }
}

impl<S: Storage> Board for CardService<S> {
    fn config(&self) -> &BoardConfig {
        &self.config
    }

    fn list(&self) -> Result<Vec<Arc<Card>>> {
        let cards = self.cards()?;
        Ok(sort_cards(&cards, &self.config))
    }

    fn find(&self, query: &CardQuery) -> Result<Vec<Arc<Card>>> {
        let mut filter = CardFilter::default();
        if let Some(text) = query.text.as_deref().filter(|t| !js_trim(t).is_empty()) {
            filter.text = Some(text.to_string());
        }
        for status in &query.status {
            filter.status.push(self.check_status(status)?);
        }
        filter.card_type.clone_from(&query.card_type);
        filter.priority.clone_from(&query.priority);
        filter.labels.clone_from(&query.labels);
        if let Some(parent) = query.parent.as_deref().filter(|p| !p.is_empty()) {
            filter.parent = Some(self.resolve_key(parent)?);
        }
        for assignee in &query.assignee {
            let v = js_trim(assignee);
            let lower = v.to_lowercase();
            filter.assignee.push(if lower == "none" || v == UNASSIGNED {
                UNASSIGNED.to_string()
            } else if lower != "me" {
                v.to_string()
            } else if self.config.me.is_empty() {
                return Err(Error::validation(
                    "\"me\" is not configured for this board (set \"My name\" in the plugin settings, or `me` in data.json)",
                ));
            } else {
                self.config.me.clone()
            });
        }

        let now = Now::from_utc_offset(self.now_ms(), self.options.utc_offset_minutes);
        // Board order whatever order the source comes in; old done cards stay out unless asked for.
        let cards: Vec<Arc<Card>> = sort_cards(&self.cards()?, &self.config)
            .into_iter()
            .filter(|c| query.include_archived || !is_archived_done(c, &self.config, &now))
            .collect();
        Ok(filter_cards(&cards, &filter, &self.config).into_iter().cloned().collect())
    }

    fn get(&self, key: &str) -> Result<Card> {
        self.read_card(key)
    }

    fn create(&self, input: NewCardInput) -> Result<Card> {
        let _one_at_a_time = locked(&self.creating);
        self.create_now(input)
    }

    fn update(&self, key: &str, patch: CardPatch) -> Result<Card> {
        let card = self.read_card(key)?;
        let mut changes = Changes::default();

        if let Some(title) = &patch.title {
            changes.set("title", text_value(&clean_title(title)?));
        }
        if let Some(card_type) = patch.card_type {
            changes.set("type", text_value(card_type.as_str()));
        }
        if let Some(priority) = patch.priority {
            changes.set("priority", text_value(priority.as_str()));
        }
        if let Some(assignee) = &patch.assignee {
            let trimmed = assignee.as_deref().map(js_trim).filter(|a| !a.is_empty());
            changes.set("assignee", trimmed.map_or(Value::Null, text_value));
        }
        if let Some(labels) = &patch.labels {
            let labels = normalize_labels(labels);
            changes.set(
                "labels",
                if labels.is_empty() {
                    Value::Null
                } else {
                    Value::Array(labels.iter().map(|l| text_value(l)).collect())
                },
            );
        }
        if let Some(due) = &patch.due {
            if let Some(due) = due
                && !is_valid_date(due)
            {
                return Err(Error::validation(format!("Invalid due date \"{due}\" (expected YYYY-MM-DD)")));
            }
            changes.set("due", due.as_deref().map_or(Value::Null, text_value));
        }
        if let Some(estimate) = patch.estimate {
            if let Some(n) = estimate {
                check_estimate(n)?;
            }
            changes.set("estimate", estimate.map_or(Value::Null, number_value));
        }
        let mut cards: Option<Vec<Arc<Card>>> = None;
        if let Some(parent) = &patch.parent {
            match parent {
                None => changes.set("parent", Value::Null),
                Some(parent) => {
                    let parent = self.resolve_key(parent)?;
                    if parent == card.key {
                        return Err(Error::validation("A card cannot be its own parent"));
                    }
                    let all = self.cards()?;
                    if !all.iter().any(|c| c.key == parent) {
                        return Err(Error::validation(format!("Parent card {parent} does not exist")));
                    }
                    cards = Some(all);
                    changes.set("parent", text_value(&parent));
                }
            }
        }

        let now_iso = self.now_iso();
        if let Some(requested) = &patch.status
            && *requested != card.status
        {
            let status = self.check_status(requested)?;
            changes.set("status", text_value(&status));
            let was_done = is_done_status(&self.config, &card.status);
            let is_done = is_done_status(&self.config, &status);
            if is_done && !was_done {
                changes.set("resolved", text_value(&now_iso));
            } else if !is_done && was_done {
                changes.set("resolved", Value::Null);
            }
            // Changing column without saying where: land at the bottom of the new column.
            if patch.rank.is_none()
                && display_column(&self.config, &status).id != display_column(&self.config, &card.status).id
            {
                let all = match cards.take() {
                    Some(all) => all,
                    None => self.cards()?,
                };
                changes.set(
                    "rank",
                    text_value(&rank_for_placement(&all, &self.config, &card.key, &status, &Placement::default())?),
                );
            }
        }
        if let Some(rank) = &patch.rank {
            changes.set("rank", text_value(rank));
        }
        changes.set("updated", text_value(&now_iso));

        let content = modify_with(&self.storage, &card.path, |current| {
            // `patch.body` is the description only: put the (current, on-disk) comments section back after it.
            let body = patch.body.as_ref().map(|description| {
                join_body(description, split_body(split_frontmatter(current).body).section.as_deref())
            });
            patch_frontmatter(current, &changes.0, body.as_deref())
        })?;
        self.wrote(&card.path);
        Ok(parse_card(&card.path, &content).unwrap_or(card))
    }

    fn move_card(&self, key: &str, column: &str, placement: Placement) -> Result<Card> {
        let card = self.read_card(key)?;
        let status = self.check_status(column)?;
        let rank = rank_for_placement(&self.cards()?, &self.config, &card.key, &status, &placement)?;
        self.update(&card.key, CardPatch { status: Some(status), rank: Some(rank), ..CardPatch::default() })
    }

    fn remove(&self, key: &str) -> Result<Card> {
        let card = self.read_card(key)?;
        self.storage.remove(&card.path)?;
        if let Some(source) = &self.options.source {
            source.forget_path(&card.path);
        }
        Ok(card)
    }

    fn add_comment(&self, key: &str, comment: CommentInput) -> Result<Card> {
        let text = clean_text(&comment.text)?;
        let author = match comment.author.as_deref().map(js_trim) {
            Some(author) if !author.is_empty() => author,
            _ => self.config.me.as_str(),
        };
        let author = clean_author(author);
        if author.is_empty() {
            return Err(Error::validation(
                "Who is commenting? Pass an author, or set \"My name\" in the board settings.",
            ));
        }
        let card = self.read_card(key)?;
        let taken: HashSet<&str> = card.comments.iter().map(|c| c.id.as_str()).collect();
        let mut id = (self.options.new_id)();
        while taken.contains(id.as_str()) {
            id = (self.options.new_id)();
        }
        let added = crate::types::Comment { id, author, at: self.now_iso(), text };
        let offset = self.options.utc_offset_minutes;
        self.mutate_body(card, |body| Some(add_comment_to_body(body, &added, offset)), None)
    }

    fn edit_comment(&self, key: &str, comment_id: &str, text: &str) -> Result<Card> {
        let next = clean_text(text)?;
        let card = self.read_card(key)?;
        let missing = format!("Comment {comment_id} on {}", card.key);
        self.mutate_body(card, |body| edit_comment_in_body(body, comment_id, &next), Some(missing))
    }

    fn remove_comment(&self, key: &str, comment_id: &str) -> Result<Card> {
        let card = self.read_card(key)?;
        let missing = format!("Comment {comment_id} on {}", card.key);
        self.mutate_body(card, |body| remove_comment_from_body(body, comment_id), Some(missing))
    }

    /// `12` becomes `OP-12` with the board's prefix; a full key is upper-cased and validated.
    fn resolve_key(&self, input: &str) -> Result<String> {
        let v = js_trim(input).to_uppercase();
        if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) {
            let n = v.parse::<f64>().unwrap_or(f64::INFINITY);
            return Ok(format!("{}-{}", self.config.prefix, number_to_js_string(n)));
        }
        if !is_valid_key(&v) {
            return Err(Error::validation(format!(
                "\"{input}\" is not a card key (expected {}-123 or 123)",
                self.config.prefix
            )));
        }
        Ok(v)
    }

    fn today(&self) -> String {
        local_date(Now::from_utc_offset(self.now_ms(), self.options.utc_offset_minutes).local_date)
    }
}
