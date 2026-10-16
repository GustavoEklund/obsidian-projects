//! An in-memory `Board` for testing the tools without the card service: simple, predictable, and able to record what the
//! tools asked of it. It implements just enough of the rules (columns by name, `me`, `none`, key numbers) to answer like
//! the real board in the cases the tool tests exercise; the real rules are the service's job and are tested there.
#![allow(dead_code)]
use std::sync::{Arc, Mutex};

use oprojects_mcp::api::{Board, CardQuery, CommentInput};
use oprojects_mcp::card::apply_patch;
use oprojects_mcp::config::resolve_column;
use oprojects_mcp::error::{Error, Result};
use oprojects_mcp::query::{CardFilter, UNASSIGNED, filter_cards, sort_cards};
use oprojects_mcp::types::{
    BoardConfig, Card, CardPatch, CardType, Checklist, Comment, NewCardInput, Placement, Priority,
};

pub struct FakeBoard {
    config: BoardConfig,
    pub today: Mutex<String>,
    cards: Mutex<Vec<Card>>,
    /// One entry per call, e.g. `find`, `update OP-1`, `move OP-1 doing`.
    pub calls: Mutex<Vec<String>>,
    pub last_patch: Mutex<Option<CardPatch>>,
    pub last_placement: Mutex<Option<Placement>>,
    pub last_new_card: Mutex<Option<NewCardInput>>,
    pub last_query: Mutex<Option<CardQuery>>,
    pub last_comment: Mutex<Option<CommentInput>>,
    /// When set, the next call fails with this error and the slot is emptied.
    pub fail_next: Mutex<Option<Error>>,
    /// When set, the next call panics (and the flag is cleared).
    pub panic_next: Mutex<bool>,
}

pub fn config() -> BoardConfig {
    let mut config = BoardConfig { me: "Ana".into(), ..BoardConfig::default() };
    config.columns[1].wip = Some(2);
    config
}

pub fn card(n: u32, status: &str, title: &str) -> Card {
    Card {
        key: format!("OP-{n}"),
        path: format!("Cards/OP-{n}.md"),
        title: title.into(),
        status: status.into(),
        card_type: CardType::Task,
        priority: Priority::Medium,
        assignee: None,
        labels: vec![],
        due: None,
        estimate: None,
        parent: None,
        rank: format!("{n:05}"),
        created: "2026-10-01T10:00:00.000Z".into(),
        updated: "2026-10-02T10:00:00.000Z".into(),
        resolved: None,
        body: String::new(),
        checklist: Checklist::default(),
        comments: vec![],
    }
}

impl FakeBoard {
    pub fn new(cards: Vec<Card>) -> Arc<Self> {
        Self::with_config(cards, config())
    }

    /// Like `new`, for a board whose configuration is not the default one (for example nobody configured as `me`).
    pub fn with_config(cards: Vec<Card>, config: BoardConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            today: Mutex::new("2026-10-14".into()),
            cards: Mutex::new(cards),
            calls: Mutex::new(vec![]),
            last_patch: Mutex::new(None),
            last_placement: Mutex::new(None),
            last_new_card: Mutex::new(None),
            last_query: Mutex::new(None),
            last_comment: Mutex::new(None),
            fail_next: Mutex::new(None),
            panic_next: Mutex::new(false),
        })
    }

    /// Three cards in three columns, one of them overdue and assigned.
    pub fn sample() -> Arc<Self> {
        let mut first = card(1, "todo", "Write the docs");
        first.due = Some("2026-10-01".into());
        first.assignee = Some("Ana".into());
        first.labels = vec!["docs".into()];
        let mut second = card(2, "doing", "Fix the login redirect");
        second.card_type = CardType::Bug;
        second.priority = Priority::High;
        second.body = "The user lands on the home page.".into();
        second.comments = vec![Comment {
            id: "c1".into(),
            author: "Bruno".into(),
            at: "2026-10-02T10:00:00.000Z".into(),
            text: "Seen in Safari.".into(),
        }];
        Self::new(vec![first, second, card(3, "done", "Ship it")])
    }

    pub fn cards(&self) -> Vec<Card> {
        self.cards.lock().unwrap().clone()
    }

    pub fn call_log(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn enter(&self, what: impl Into<String>) -> Result<()> {
        self.calls.lock().unwrap().push(what.into());
        if std::mem::take(&mut *self.panic_next.lock().unwrap()) {
            panic!("the fake board was told to panic");
        }
        match self.fail_next.lock().unwrap().take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn position(&self, key: &str) -> Result<usize> {
        let key = self.resolve_key(key)?;
        self.cards
            .lock()
            .unwrap()
            .iter()
            .position(|c| c.key == key)
            .ok_or_else(|| Error::NotFound(format!("Card {key}")))
    }

    fn column(&self, name: &str) -> Result<String> {
        resolve_column(&self.config, name).map(|c| c.id.clone()).ok_or_else(|| {
            let valid: Vec<String> = self.config.columns.iter().map(|c| format!("{} (\"{}\")", c.id, c.name)).collect();
            Error::validation(format!("Unknown column \"{name}\". Valid: {}", valid.join(", ")))
        })
    }

    fn edit(&self, key: &str, change: impl FnOnce(&mut Card) -> Result<()>) -> Result<Card> {
        let at = self.position(key)?;
        let mut cards = self.cards.lock().unwrap();
        change(&mut cards[at])?;
        Ok(cards[at].clone())
    }
}

impl Board for FakeBoard {
    fn config(&self) -> &BoardConfig {
        &self.config
    }

    fn list(&self) -> Result<Vec<Arc<Card>>> {
        self.enter("list")?;
        Ok(sort_cards(&self.cards(), &self.config).into_iter().map(Arc::new).collect())
    }

    fn find(&self, query: &CardQuery) -> Result<Vec<Arc<Card>>> {
        self.enter("find")?;
        *self.last_query.lock().unwrap() = Some(query.clone());
        let mut filter = CardFilter {
            text: query.text.clone(),
            card_type: query.card_type.clone(),
            priority: query.priority.clone(),
            labels: query.labels.clone(),
            parent: query.parent.clone(),
            ..CardFilter::default()
        };
        for status in &query.status {
            filter.status.push(self.column(status)?);
        }
        for who in &query.assignee {
            filter.assignee.push(match who.to_lowercase().as_str() {
                "none" => UNASSIGNED.to_string(),
                "me" => self.config.me.clone(),
                _ => who.clone(),
            });
        }
        let all = sort_cards(&self.cards(), &self.config);
        let mut kept: Vec<Arc<Card>> =
            filter_cards(&all, &filter, &self.config).into_iter().cloned().map(Arc::new).collect();
        if !query.include_archived {
            // The fake has no clock: a done card resolved before this date counts as an old one.
            kept.retain(|c| c.resolved.as_deref().is_none_or(|r| r >= "2026-09-30"));
        }
        Ok(kept)
    }

    fn get(&self, key: &str) -> Result<Card> {
        self.enter(format!("get {key}"))?;
        Ok(self.cards()[self.position(key)?].clone())
    }

    fn create(&self, input: NewCardInput) -> Result<Card> {
        self.enter("create")?;
        *self.last_new_card.lock().unwrap() = Some(input.clone());
        let status = match &input.status {
            Some(status) => self.column(status)?,
            None => self.config.columns[0].id.clone(),
        };
        let mut cards = self.cards.lock().unwrap();
        let n = cards.iter().filter_map(|c| c.key.strip_prefix("OP-")?.parse::<u32>().ok()).max().unwrap_or(0) + 1;
        let mut new = card(n, &status, input.title.trim());
        new.card_type = input.card_type.unwrap_or(CardType::Task);
        new.priority = input.priority.unwrap_or(Priority::Medium);
        new.assignee = input.assignee;
        new.labels = input.labels.unwrap_or_default();
        new.due = input.due;
        new.estimate = input.estimate;
        new.parent = input.parent;
        new.body = input.body.unwrap_or_default();
        cards.push(new.clone());
        Ok(new)
    }

    fn update(&self, key: &str, patch: CardPatch) -> Result<Card> {
        self.enter(format!("update {key}"))?;
        *self.last_patch.lock().unwrap() = Some(patch.clone());
        self.edit(key, |card| {
            *card = apply_patch(card, &patch);
            Ok(())
        })
    }

    fn move_card(&self, key: &str, column: &str, placement: Placement) -> Result<Card> {
        self.enter(format!("move {key} {column}"))?;
        *self.last_placement.lock().unwrap() = Some(placement);
        let status = self.column(column)?;
        self.edit(key, |card| {
            card.status = status;
            Ok(())
        })
    }

    fn remove(&self, key: &str) -> Result<Card> {
        self.enter(format!("remove {key}"))?;
        let at = self.position(key)?;
        Ok(self.cards.lock().unwrap().remove(at))
    }

    fn add_comment(&self, key: &str, comment: CommentInput) -> Result<Card> {
        self.enter(format!("add_comment {key}"))?;
        *self.last_comment.lock().unwrap() = Some(comment.clone());
        if comment.text.trim().is_empty() {
            return Err(Error::validation("A comment needs some text"));
        }
        self.edit(key, |card| {
            let id = format!("c{}", card.comments.len() + 1);
            card.comments.push(Comment {
                id,
                author: comment.author.clone().unwrap_or_else(|| self.config.me.clone()),
                at: "2026-10-14T12:00:00.000Z".into(),
                text: comment.text.clone(),
            });
            Ok(())
        })
    }

    fn edit_comment(&self, key: &str, comment_id: &str, text: &str) -> Result<Card> {
        self.enter(format!("edit_comment {key} {comment_id}"))?;
        self.edit(key, |card| {
            let comment = card
                .comments
                .iter_mut()
                .find(|c| c.id == comment_id)
                .ok_or_else(|| Error::NotFound(format!("Comment {comment_id}")))?;
            comment.text = text.to_string();
            Ok(())
        })
    }

    fn remove_comment(&self, key: &str, comment_id: &str) -> Result<Card> {
        self.enter(format!("remove_comment {key} {comment_id}"))?;
        self.edit(key, |card| {
            let at = card
                .comments
                .iter()
                .position(|c| c.id == comment_id)
                .ok_or_else(|| Error::NotFound(format!("Comment {comment_id}")))?;
            card.comments.remove(at);
            Ok(())
        })
    }

    fn resolve_key(&self, input: &str) -> Result<String> {
        let v = input.trim().to_uppercase();
        if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) {
            return Ok(format!("OP-{}", v.parse::<u32>().unwrap_or(0)));
        }
        if v.starts_with("OP-") && v.len() > 3 && v[3..].bytes().all(|b| b.is_ascii_digit()) {
            return Ok(v);
        }
        Err(Error::validation(format!("\"{input}\" is not a card key (expected OP-123 or 123)")))
    }

    fn today(&self) -> String {
        self.today.lock().unwrap().clone()
    }
}
