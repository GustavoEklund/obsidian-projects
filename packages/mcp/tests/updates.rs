//! Following the cards an agent takes, through the protocol: what a write that takes a card answers (`--updates watch`),
//! and the updates a server pushes to its client as channel messages (`--updates channel`).
mod common;

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use common::fake_board::FakeBoard;
use common::vaults::{note_text, sample_card, temp_vault};
use oprojects_mcp::api::Board;
use oprojects_mcp::channel::{self, CAPABILITY, Channel, METHOD};
use oprojects_mcp::storage::FsStorage;
use oprojects_mcp::tools::{Projects, ServerOptions, Updates};
use oprojects_mcp::types::Comment;
use oprojects_mcp::vault::{VaultOptions, open_vault};
use oprojects_mcp::watch::Watcher;
use rmcp::model::{CallToolRequestParams, CallToolResult, CustomNotification, JsonObject};
use rmcp::service::{NotificationContext, RoleClient, RunningService};
use rmcp::{ClientHandler, ServiceExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;

type Client<H> = RunningService<RoleClient, H>;

/// A client that keeps the custom notifications the server sends.
struct Listener(mpsc::UnboundedSender<CustomNotification>);

impl ClientHandler for Listener {
    async fn on_custom_notification(
        &self,
        notification: CustomNotification,
        _context: NotificationContext<RoleClient>,
    ) {
        let _ = self.0.send(notification);
    }
}

fn options() -> ServerOptions {
    ServerOptions { read_only: false, author: "Claude".into() }
}

const WATCH: &str = "/opt/bin/oprojects-mcp watch --vault /home/ana/vault --author Claude";

async fn connect(board: Arc<FakeBoard>, updates: Updates) -> Client<()> {
    let (client_io, server_io) = tokio::io::duplex(256 * 1024);
    let server = Projects::new(board, &options()).with_updates(updates);
    tokio::spawn(async move {
        if let Ok(running) = server.serve(server_io).await {
            let _ = running.waiting().await;
        }
    });
    ().serve(client_io).await.expect("the client initializes")
}

async fn call<H: ClientHandler>(client: &Client<H>, tool: &'static str, args: Value) -> String {
    let arguments: JsonObject = args.as_object().cloned().expect("arguments are an object");
    let result: CallToolResult =
        client.call_tool(CallToolRequestParams::new(tool).with_arguments(arguments)).await.expect("routed");
    assert_ne!(result.is_error, Some(true), "{result:?}");
    result.content.iter().filter_map(|c| c.as_text()).map(|t| t.text.clone()).collect::<Vec<_>>().join("\n")
}

// --- `--updates watch` -----------------------------------------------------------------------------------------------

#[tokio::test]
async fn taking_a_card_by_moving_it_out_of_the_first_column_says_how_to_follow_it() {
    let client = connect(FakeBoard::sample(), Updates::Watch { command: WATCH.into() }).await;
    let text = call(&client, "move_card", json!({ "key": "1", "column": "doing" })).await;
    assert!(text.starts_with("Moved: "), "the usual answer comes first: {text}");
    assert!(text.contains("You took OP-1"), "{text}");
    assert!(text.contains("Monitor") && text.contains("timeout_ms 1800000"), "{text}");
    assert!(text.contains(&format!("{WATCH} OP-1")), "the exact command, ready to run: {text}");
    assert!(text.contains("ends by itself when the card is done"), "{text}");
}

#[tokio::test]
async fn assigning_a_card_to_the_agent_takes_it_too_and_assigning_it_to_someone_else_does_not() {
    let client = connect(FakeBoard::sample(), Updates::Watch { command: WATCH.into() }).await;
    let other = call(&client, "update_card", json!({ "key": "OP-1", "assignee": "Bruno" })).await;
    assert!(!other.contains("Monitor"), "{other}");
    let me = call(&client, "update_card", json!({ "key": "OP-1", "assignee": "me" })).await;
    assert!(!me.contains("Monitor"), "\"me\" is the person, not the agent: {me}");
    let mine = call(&client, "update_card", json!({ "key": "OP-1", "assignee": "claude" })).await;
    assert!(mine.contains("You took OP-1") && mine.contains(&format!("{WATCH} OP-1")), "{mine}");
    let again = call(&client, "update_card", json!({ "key": "OP-1", "priority": "high" })).await;
    assert!(!again.contains("Monitor"), "already the assignee: {again}");
}

#[tokio::test]
async fn work_that_is_not_taking_a_card_says_nothing_extra() {
    let client = connect(FakeBoard::sample(), Updates::Watch { command: WATCH.into() }).await;
    let within = call(&client, "move_card", json!({ "key": "OP-2", "column": "review" })).await;
    assert!(!within.contains("Monitor") && !within.contains("You took"), "doing to review is the same work: {within}");
    let finish = call(&client, "move_card", json!({ "key": "OP-1", "column": "done" })).await;
    assert!(!finish.contains("Monitor"), "a finished card has nothing to follow: {finish}");
    let comment = call(&client, "add_comment", json!({ "key": "OP-2", "text": "hello" })).await;
    assert!(!comment.contains("Monitor"), "{comment}");
}

#[tokio::test]
async fn with_updates_off_the_answers_are_the_plain_ones() {
    let off = connect(FakeBoard::sample(), Updates::Off).await;
    let text = call(&off, "move_card", json!({ "key": "1", "column": "doing" })).await;
    assert!(text.starts_with("Moved: ") && !text.contains("Monitor") && !text.contains("You took"), "{text}");
    let default = connect(FakeBoard::sample(), Updates::Off).await;
    let same = call(&default, "move_card", json!({ "key": "1", "column": "doing" })).await;
    assert_eq!(text, same);
}

#[tokio::test]
async fn the_instructions_mention_following_only_when_it_is_on() {
    let text = |client: &Client<()>| client.peer_info().unwrap().instructions.clone().unwrap();
    let watch = text(&connect(FakeBoard::sample(), Updates::Watch { command: WATCH.into() }).await);
    assert!(watch.contains("Monitor tool"), "{watch}");
    let off = text(&connect(FakeBoard::sample(), Updates::Off).await);
    assert!(!off.contains("Monitor") && !off.contains("channel"), "{off}");
    assert!(watch.starts_with(&off), "what was said before is unchanged");
}

#[tokio::test]
async fn only_a_channel_server_declares_the_channel_capability() {
    let capabilities = |client: &Client<()>| client.peer_info().unwrap().capabilities.clone();
    for updates in [Updates::Off, Updates::Watch { command: WATCH.into() }] {
        assert!(capabilities(&connect(FakeBoard::sample(), updates).await).experimental.is_none());
    }
}

// --- `--updates channel` ---------------------------------------------------------------------------------------------

/// A real vault with `OP-1` in the first column, a server that follows cards for "Claude" and pushes what happens, and a
/// client that listens.
struct Channelled {
    vault: tempfile::TempDir,
    client: Client<Listener>,
    pushed: mpsc::UnboundedReceiver<CustomNotification>,
}

async fn channelled() -> Channelled {
    let vault = temp_vault();
    fs::create_dir_all(vault.path().join("Cards")).unwrap();
    let mut card = sample_card("OP-1", "todo", "M");
    card.assignee = None;
    fs::write(vault.path().join(&card.path), note_text(&card)).unwrap();

    let board = open_vault(
        vault.path(),
        VaultOptions { use_index: false, watch: false, utc_offset_minutes: Some(0), ..VaultOptions::default() },
    )
    .unwrap();
    let watcher = Watcher::new(
        Arc::new(FsStorage::new(vault.path())),
        board.config().clone(),
        "Claude",
        Duration::from_millis(200),
    );
    let following = Channel::new(watcher);

    let (client_io, server_io) = tokio::io::duplex(256 * 1024);
    let server = Projects::new(board, &options()).with_updates(Updates::Channel(Arc::clone(&following)));
    tokio::spawn(async move {
        if let Ok(running) = server.serve(server_io).await {
            let pump = tokio::spawn(channel::pump(following, running.peer().clone()));
            let _ = running.waiting().await;
            pump.abort();
        }
    });
    let (sender, pushed) = mpsc::unbounded_channel();
    let client = Listener(sender).serve(client_io).await.expect("the client initializes");
    Channelled { vault, client, pushed }
}

async fn next(pushed: &mut mpsc::UnboundedReceiver<CustomNotification>) -> CustomNotification {
    tokio::time::timeout(Duration::from_secs(15), pushed.recv()).await.expect("a message arrives").expect("open")
}

#[tokio::test]
async fn a_channel_server_declares_the_capability_and_tells_the_agent_to_expect_messages() {
    let setup = channelled().await;
    let info = setup.client.peer_info().unwrap();
    assert_eq!(info.capabilities.experimental.as_ref().and_then(|e| e.get(CAPABILITY)), Some(&JsonObject::new()));
    assert!(info.instructions.clone().unwrap().contains("arrive as channel messages"));
}

#[tokio::test]
async fn the_server_follows_a_card_it_took_and_pushes_a_comment_then_the_finish() {
    let mut setup = channelled().await;
    let text = call(&setup.client, "move_card", json!({ "key": "OP-1", "column": "doing" })).await;
    assert!(text.contains("You took OP-1") && text.contains("channel messages"), "{text}");
    assert!(!text.contains("Monitor"), "no second process in this mode: {text}");

    // Someone else, in the note, as the plugin would write it.
    let path = setup.vault.path().join("Cards/OP-1.md");
    let mut card = oprojects_mcp::card::parse_card("Cards/OP-1.md", &fs::read_to_string(&path).unwrap()).unwrap();
    card.comments.push(Comment {
        id: "n1".into(),
        author: "Gustavo".into(),
        at: "2026-10-04T10:00:00.000Z".into(),
        text: "Please also check Safari.".into(),
    });
    fs::write(&path, note_text(&card)).unwrap();

    let message = next(&mut setup.pushed).await;
    assert_eq!(message.method, METHOD);
    let params = message.params.expect("params");
    assert!(
        params["content"].as_str().unwrap().contains("Gustavo commented: \"Please also check Safari.\""),
        "{params}"
    );
    assert_eq!(params["meta"], json!({ "card": "OP-1", "event": "changed" }));

    card.status = "done".into();
    fs::write(&path, note_text(&card)).unwrap();
    let params = next(&mut setup.pushed).await.params.expect("params");
    assert!(params["content"].as_str().unwrap().contains("stop watching it"), "{params}");
    assert_eq!(params["meta"], json!({ "card": "OP-1", "event": "done" }));

    assert!(
        tokio::time::timeout(Duration::from_millis(1500), setup.pushed.recv()).await.is_err(),
        "a done card is not followed any more"
    );
}

#[tokio::test]
async fn a_card_the_agent_did_not_take_is_never_pushed() {
    let mut setup = channelled().await;
    let path = setup.vault.path().join("Cards/OP-1.md");
    let mut card = oprojects_mcp::card::parse_card("Cards/OP-1.md", &fs::read_to_string(&path).unwrap()).unwrap();
    card.comments.push(Comment { id: "n1".into(), author: "Gustavo".into(), at: String::new(), text: "hello".into() });
    fs::write(&path, note_text(&card)).unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(1800), setup.pushed.recv()).await.is_err());
    // keep the client alive until here
    drop(setup.client);
}
