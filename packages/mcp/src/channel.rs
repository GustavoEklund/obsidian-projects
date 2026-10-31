//! Updates pushed into the agent's session, for clients that support it (`--updates channel`).
//!
//! Claude Code calls this a *channel*: a server that declares the `claude/channel` experimental capability can send
//! `notifications/claude/channel`, and each one arrives in the session as a `<channel source="…">` message, whether the
//! agent is busy (it is read with the next turn) or waiting for a prompt (it wakes the agent). It is the same
//! [`Watcher`](crate::watch::Watcher) as the `watch` command, living inside the server: the server follows a card by
//! itself when its own tools make the agent take it, and the updates need no second process.
//!
//! It is off by default because Claude Code only listens to a custom channel when started with
//! `--dangerously-load-development-channels server:<name>`, which an organization can forbid (`channelsEnabled`), and a
//! message sent to a session that is not listening is dropped without a word. Where that is the case the `watch`
//! command, which needs nothing from the client but the `Monitor` tool, does the same job.
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use rmcp::model::{CustomNotification, ServerNotification};
use rmcp::{Peer, RoleServer};
use serde_json::json;

use crate::storage::FsStorage;
use crate::watch::{POLL, Update, Watcher};

/// The experimental capability that makes a server a channel.
pub const CAPABILITY: &str = "claude/channel";
/// The notification a channel sends.
pub const METHOD: &str = "notifications/claude/channel";

/// The cards the server follows for its agent, shared between the tools (which start following) and the task that sends
/// the updates.
pub struct Channel {
    watcher: Mutex<Watcher<Arc<FsStorage>>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Channel {
    pub fn new(watcher: Watcher<Arc<FsStorage>>) -> Arc<Self> {
        Arc::new(Self { watcher: Mutex::new(watcher) })
    }

    /// Starts following a card. `false` when it could not be (it does not exist, or it is already done).
    pub fn follow(&self, key: &str) -> bool {
        matches!(locked(&self.watcher).add(key), Ok(crate::watch::Added::Following(_)))
    }

    /// No card is followed, so there is nothing to read.
    pub fn is_idle(&self) -> bool {
        locked(&self.watcher).is_empty()
    }

    pub fn poll(&self, now: Instant) -> Vec<Update> {
        locked(&self.watcher).poll(now)
    }
}

/// The message for one update: the line is the content, and the card and the kind of update are attributes of the tag
/// (`<channel source="…" card="OP-12" event="done">`).
pub fn notification(update: &Update) -> CustomNotification {
    CustomNotification::new(
        METHOD,
        Some(json!({ "content": update.line, "meta": { "card": update.key, "event": update.kind.as_str() } })),
    )
}

/// Reads the followed cards every [`POLL`] and sends what changed, until the connection ends. Reading is file I/O, so it
/// runs on the blocking pool and the protocol thread stays free.
pub async fn pump(channel: Arc<Channel>, peer: Peer<RoleServer>) {
    let mut tick = tokio::time::interval(POLL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        if channel.is_idle() {
            continue;
        }
        let reading = Arc::clone(&channel);
        let Ok(updates) = tokio::task::spawn_blocking(move || reading.poll(Instant::now())).await else {
            continue;
        };
        for update in updates {
            if peer.send_notification(ServerNotification::CustomNotification(notification(&update))).await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watch::UpdateKind;

    #[test]
    fn an_update_is_a_channel_message_with_the_card_and_the_event_as_attributes() {
        let update = Update { key: "OP-12".into(), kind: UpdateKind::Done, line: "OP-12 is done.".into() };
        let message = notification(&update);
        assert_eq!(message.method, "notifications/claude/channel");
        assert_eq!(
            message.params,
            Some(json!({ "content": "OP-12 is done.", "meta": { "card": "OP-12", "event": "done" } }))
        );
    }

    #[test]
    fn attribute_names_are_identifiers_because_claude_code_drops_any_other() {
        let update = Update { key: "OP-1".into(), kind: UpdateKind::Changed, line: "x".into() };
        let params = notification(&update).params.expect("params");
        for name in params["meta"].as_object().expect("meta").keys() {
            assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "{name}");
        }
    }
}
