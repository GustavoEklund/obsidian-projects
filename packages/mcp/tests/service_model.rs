//! Model-based test of `CardService`: random sequences of operations are applied both to the service and to a model
//! that is simple enough to be obviously right (an ordered list of keys per column and a few fields per card), and after
//! every step the service must agree with the model: the order of the whole board, each card's fields, its comments,
//! the numbering of keys, the strictly increasing ranks inside a column, and the `resolved` rule.
use oprojects_mcp::api::{Board, CommentInput};
use oprojects_mcp::service::{CardService, ServiceOptions};
use oprojects_mcp::storage::MemoryStorage;
use oprojects_mcp::types::{BoardConfig, CardPatch, NewCardInput, PRIORITIES, Placement, Priority};
use proptest::prelude::*;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

const COLUMNS: [&str; 4] = ["todo", "doing", "review", "done"];
const DONE: usize = 3;
const LABELS: [&str; 3] = ["alpha", "beta", "gamma"];

#[derive(Debug, Clone)]
enum Op {
    Create { col: usize, title: u8, labels: Vec<u8>, parent: Option<usize> },
    Rename { pick: usize, title: u8 },
    SetPriority { pick: usize, priority: usize },
    SetStatus { pick: usize, col: usize },
    SetLabels { pick: usize, labels: Vec<u8> },
    SetBody { pick: usize, body: u8 },
    Move { pick: usize, col: usize, place: Option<(bool, usize)> },
    Remove { pick: usize },
    AddComment { pick: usize, text: u8 },
    EditComment { pick: usize, which: usize, text: u8 },
    RemoveComment { pick: usize, which: usize },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => (0..4usize, 0..20u8, prop::collection::vec(0..3u8, 0..4), prop::option::of(0..60usize))
            .prop_map(|(col, title, labels, parent)| Op::Create { col, title, labels, parent }),
        2 => (0..60usize, 0..20u8).prop_map(|(pick, title)| Op::Rename { pick, title }),
        1 => (0..60usize, 0..5usize).prop_map(|(pick, priority)| Op::SetPriority { pick, priority }),
        3 => (0..60usize, 0..4usize).prop_map(|(pick, col)| Op::SetStatus { pick, col }),
        1 => (0..60usize, prop::collection::vec(0..3u8, 0..4)).prop_map(|(pick, labels)| Op::SetLabels { pick, labels }),
        2 => (0..60usize, 0..9u8).prop_map(|(pick, body)| Op::SetBody { pick, body }),
        5 => (0..60usize, 0..4usize, prop::option::of((any::<bool>(), 0..60usize)))
            .prop_map(|(pick, col, place)| Op::Move { pick, col, place }),
        1 => (0..60usize).prop_map(|pick| Op::Remove { pick }),
        3 => (0..60usize, 0..9u8).prop_map(|(pick, text)| Op::AddComment { pick, text }),
        1 => (0..60usize, 0..8usize, 0..9u8).prop_map(|(pick, which, text)| Op::EditComment { pick, which, text }),
        1 => (0..60usize, 0..8usize).prop_map(|(pick, which)| Op::RemoveComment { pick, which }),
    ]
}

#[derive(Debug, Clone)]
struct ModelCard {
    title: String,
    priority: Priority,
    labels: Vec<String>,
    body: String,
    comments: Vec<(String, String)>,
    parent: Option<u64>,
}

#[derive(Default)]
struct Model {
    cards: BTreeMap<u64, ModelCard>,
    columns: [Vec<u64>; 4],
    comment_ids: u64,
}

impl Model {
    /// The nth existing card number, wrapping around: how a random index becomes a card that exists.
    fn pick(&self, i: usize) -> Option<u64> {
        (!self.cards.is_empty()).then(|| *self.cards.keys().nth(i % self.cards.len()).unwrap())
    }

    fn column_of(&self, n: u64) -> usize {
        self.columns.iter().position(|c| c.contains(&n)).unwrap()
    }

    fn take_out(&mut self, n: u64) -> usize {
        let col = self.column_of(n);
        self.columns[col].retain(|x| *x != n);
        col
    }

    fn board_order(&self) -> Vec<u64> {
        self.columns.iter().flatten().copied().collect()
    }
}

fn key(n: u64) -> String {
    format!("OP-{n}")
}

fn labels_of(indexes: &[u8]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for &i in indexes {
        let label = LABELS[usize::from(i)].to_string();
        if !out.contains(&label) {
            out.push(label);
        }
    }
    out
}

fn body_text(b: u8) -> String {
    format!("Body {b}\n\n- [ ] item {b}\n")
}

fn comment_text(t: u8) -> String {
    format!("Comment {t}")
}

struct Harness {
    service: CardService<Arc<MemoryStorage>>,
    model: Model,
}

impl Harness {
    fn new() -> Self {
        let ticks = Arc::new(AtomicI64::new(1_792_065_600_000));
        let ids = Arc::new(AtomicU64::new(0));
        let service = CardService::new(
            Arc::new(MemoryStorage::new()),
            BoardConfig { me: "Ana".into(), hide_done_after_days: 0, ..BoardConfig::default() },
            ServiceOptions {
                clock: Arc::new(move || ticks.fetch_add(1000, Ordering::SeqCst)),
                new_id: Arc::new(move || format!("i{}", ids.fetch_add(1, Ordering::SeqCst) + 1)),
                ..ServiceOptions::default()
            },
        );
        Self { service, model: Model::default() }
    }

    fn apply(&mut self, op: &Op) -> Result<(), TestCaseError> {
        let m = &mut self.model;
        match op {
            Op::Create { col, title, labels, parent } => {
                let n = m.cards.keys().next_back().map_or(1, |last| last + 1);
                let parent_n = parent.and_then(|p| m.pick(p));
                let card = self
                    .service
                    .create(NewCardInput {
                        title: format!("Card {title}"),
                        status: Some(COLUMNS[*col].into()),
                        labels: Some(labels_of(labels)),
                        parent: parent_n.map(key),
                        ..NewCardInput::default()
                    })
                    .map_err(|e| TestCaseError::fail(format!("create failed: {e}")))?;
                prop_assert_eq!(&card.key, &key(n), "keys are the highest number plus one");
                m.cards.insert(
                    n,
                    ModelCard {
                        title: format!("Card {title}"),
                        priority: Priority::Medium,
                        labels: labels_of(labels),
                        body: String::new(),
                        comments: Vec::new(),
                        parent: parent_n,
                    },
                );
                m.columns[*col].push(n);
            }
            Op::Rename { pick, title } => {
                let Some(n) = m.pick(*pick) else { return Ok(()) };
                self.service
                    .update(&key(n), CardPatch { title: Some(format!("Card {title}")), ..CardPatch::default() })
                    .unwrap();
                m.cards.get_mut(&n).unwrap().title = format!("Card {title}");
            }
            Op::SetPriority { pick, priority } => {
                let Some(n) = m.pick(*pick) else { return Ok(()) };
                self.service
                    .update(&key(n), CardPatch { priority: Some(PRIORITIES[*priority]), ..CardPatch::default() })
                    .unwrap();
                m.cards.get_mut(&n).unwrap().priority = PRIORITIES[*priority];
            }
            Op::SetStatus { pick, col } => {
                let Some(n) = m.pick(*pick) else { return Ok(()) };
                self.service
                    .update(&key(n), CardPatch { status: Some(COLUMNS[*col].into()), ..CardPatch::default() })
                    .unwrap();
                if m.column_of(n) != *col {
                    m.take_out(n);
                    m.columns[*col].push(n); // another column without saying where: the bottom
                }
            }
            Op::SetLabels { pick, labels } => {
                let Some(n) = m.pick(*pick) else { return Ok(()) };
                self.service
                    .update(&key(n), CardPatch { labels: Some(labels_of(labels)), ..CardPatch::default() })
                    .unwrap();
                m.cards.get_mut(&n).unwrap().labels = labels_of(labels);
            }
            Op::SetBody { pick, body } => {
                let Some(n) = m.pick(*pick) else { return Ok(()) };
                self.service
                    .update(&key(n), CardPatch { body: Some(body_text(*body)), ..CardPatch::default() })
                    .unwrap();
                m.cards.get_mut(&n).unwrap().body = body_text(*body);
            }
            Op::Move { pick, col, place } => {
                let Some(n) = m.pick(*pick) else { return Ok(()) };
                let reference = place.and_then(|(before, r)| m.pick(r).map(|r| (before, r)));
                let placement = Placement {
                    before: reference.filter(|(before, _)| *before).map(|(_, r)| key(r)),
                    after: reference.filter(|(before, _)| !*before).map(|(_, r)| key(r)),
                };
                let result = self.service.move_card(&key(n), COLUMNS[*col], placement);
                // the card moves next to the reference when that one sits in the target column and is not the card itself
                let valid = reference.is_none_or(|(_, r)| r != n && m.columns[*col].contains(&r));
                if valid {
                    prop_assert!(result.is_ok(), "move failed: {:?}", result.err());
                    m.take_out(n);
                    match reference {
                        None => m.columns[*col].push(n),
                        Some((before, r)) => {
                            let at = m.columns[*col].iter().position(|x| *x == r).unwrap();
                            m.columns[*col].insert(if before { at } else { at + 1 }, n);
                        }
                    }
                } else {
                    prop_assert!(result.is_err(), "moving next to {reference:?} should have been refused");
                }
            }
            Op::Remove { pick } => {
                let Some(n) = m.pick(*pick) else { return Ok(()) };
                self.service.remove(&key(n)).unwrap();
                m.take_out(n);
                m.cards.remove(&n);
            }
            Op::AddComment { pick, text } => {
                let Some(n) = m.pick(*pick) else { return Ok(()) };
                self.service.add_comment(&key(n), CommentInput { text: comment_text(*text), author: None }).unwrap();
                m.comment_ids += 1;
                let id = format!("i{}", m.comment_ids);
                m.cards.get_mut(&n).unwrap().comments.push((id, comment_text(*text)));
            }
            Op::EditComment { pick, which, text } => {
                let Some(n) = m.pick(*pick) else { return Ok(()) };
                let card = m.cards.get_mut(&n).unwrap();
                if card.comments.is_empty() {
                    return Ok(());
                }
                let i = which % card.comments.len();
                let id = card.comments[i].0.clone();
                self.service.edit_comment(&key(n), &id, &comment_text(*text)).unwrap();
                card.comments[i].1 = comment_text(*text);
            }
            Op::RemoveComment { pick, which } => {
                let Some(n) = m.pick(*pick) else { return Ok(()) };
                let card = m.cards.get_mut(&n).unwrap();
                if card.comments.is_empty() {
                    return Ok(());
                }
                let i = which % card.comments.len();
                let id = card.comments[i].0.clone();
                self.service.remove_comment(&key(n), &id).unwrap();
                card.comments.remove(i);
            }
        }
        Ok(())
    }

    /// The service and the model describe the same board.
    fn agree(&self) -> Result<(), TestCaseError> {
        let m = &self.model;
        let cards = self.service.list().unwrap();
        let want: Vec<String> = m.board_order().into_iter().map(key).collect();
        let got: Vec<String> = cards.iter().map(|c| c.key.clone()).collect();
        prop_assert_eq!(&got, &want, "the order of the board");

        for card in &cards {
            let n: u64 = card.key[3..].parse().unwrap();
            let expected = &m.cards[&n];
            let col = m.column_of(n);
            prop_assert_eq!(&card.status, COLUMNS[col], "{} status", card.key);
            prop_assert_eq!(&card.title, &expected.title, "{} title", card.key);
            prop_assert_eq!(card.priority, expected.priority, "{} priority", card.key);
            prop_assert_eq!(&card.labels, &expected.labels, "{} labels", card.key);
            prop_assert_eq!(card.parent.clone(), expected.parent.map(key), "{} parent", card.key);
            prop_assert_eq!(card.body.trim(), expected.body.trim(), "{} description", card.key);
            let comments: Vec<(String, String)> =
                card.comments.iter().map(|c| (c.id.clone(), c.text.clone())).collect();
            prop_assert_eq!(&comments, &expected.comments, "{} comments", card.key);
            prop_assert_eq!(card.resolved.is_some(), col == DONE, "{} resolved only while done", card.key);
            prop_assert!(card.updated >= card.created, "{} was updated before it was created", card.key);
            // a card read on its own is the card in the list
            let fresh = self.service.get(&card.key).unwrap();
            prop_assert_eq!(&fresh, &**card, "{} get and list disagree", card.key);
        }
        for column in COLUMNS {
            let ranks: Vec<&str> = cards.iter().filter(|c| c.status == column).map(|c| c.rank.as_str()).collect();
            prop_assert!(ranks.windows(2).all(|w| w[0] < w[1]), "ranks in {column} must strictly increase: {ranks:?}");
        }
        // the same board seen through a filter
        for (column, expected) in COLUMNS.iter().zip(&m.columns) {
            let found = self
                .service
                .find(&oprojects_mcp::api::CardQuery { status: vec![(*column).into()], ..Default::default() })
                .unwrap();
            let want: Vec<String> = expected.iter().copied().map(key).collect();
            prop_assert_eq!(found.iter().map(|c| c.key.clone()).collect::<Vec<_>>(), want, "find in {}", column);
        }
        Ok(())
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 40, ..ProptestConfig::default() })]

    #[test]
    fn the_service_agrees_with_a_simple_model_after_every_operation(ops in prop::collection::vec(op(), 1..45)) {
        let mut harness = Harness::new();
        for (i, op) in ops.iter().enumerate() {
            harness.apply(op).map_err(|e| TestCaseError::fail(format!("step {i} {op:?}: {e}")))?;
            harness.agree().map_err(|e| TestCaseError::fail(format!("after step {i} {op:?}: {e}")))?;
        }
    }
}
