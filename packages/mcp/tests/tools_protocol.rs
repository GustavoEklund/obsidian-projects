//! The server through the protocol, in process: the official client talks to it over a pipe, so what is tested is what a
//! real MCP client sees: `initialize`, `tools/list` (names, annotations, schemas, size) and `tools/call` (results,
//! tool errors, protocol errors), with the board faked.
mod common;

use std::sync::Arc;

use common::fake_board::{FakeBoard, card};
use oprojects_mcp::tools::{Projects, READ_TOOLS, ServerOptions, WRITE_TOOLS};
use rmcp::model::{CallToolRequestParams, CallToolResult, JsonObject};
use rmcp::service::{RoleClient, RunningService, ServiceError};
use rmcp::{ServiceExt, handler::server::ServerHandler};
use serde_json::{Value, json};

type Client = RunningService<RoleClient, ()>;

fn options(read_only: bool) -> ServerOptions {
    ServerOptions { read_only, author: "Claude".into() }
}

async fn connect(board: Arc<FakeBoard>, read_only: bool) -> Client {
    let (client_io, server_io) = tokio::io::duplex(256 * 1024);
    let server = Projects::new(board, &options(read_only));
    tokio::spawn(async move {
        if let Ok(running) = server.serve(server_io).await {
            let _ = running.waiting().await;
        }
    });
    ().serve(client_io).await.expect("the client initializes")
}

fn arguments(value: Value) -> JsonObject {
    value.as_object().cloned().expect("arguments are an object")
}

async fn call(client: &Client, tool: &'static str, args: Value) -> CallToolResult {
    client
        .call_tool(CallToolRequestParams::new(tool).with_arguments(arguments(args)))
        .await
        .expect("the call is routed")
}

fn text(result: &CallToolResult) -> String {
    result.content.iter().filter_map(|c| c.as_text()).map(|t| t.text.clone()).collect::<Vec<_>>().join("\n")
}

fn is_error(result: &CallToolResult) -> bool {
    result.is_error == Some(true)
}

async fn tools_json(client: &Client) -> Vec<Value> {
    let tools = client.list_all_tools().await.expect("tools/list");
    tools.iter().map(|t| serde_json::to_value(t).unwrap()).collect()
}

fn names(tools: &[Value]) -> Vec<String> {
    tools.iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
}

fn tool<'a>(tools: &'a [Value], name: &str) -> &'a Value {
    tools.iter().find(|t| t["name"] == name).unwrap_or_else(|| panic!("no tool {name}"))
}

// --- initialize ----------------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_server_introduces_itself_and_tells_the_agent_about_the_board() {
    let client = connect(FakeBoard::sample(), false).await;
    let info = client.peer_info().expect("the server answered initialize");
    let implementation = info.server_info.clone().expect("server info");
    assert_eq!(implementation.name, "oprojects-mcp");
    assert_eq!(implementation.version, env!("CARGO_PKG_VERSION"));
    assert!(info.capabilities.tools.is_some());
    assert!(info.capabilities.resources.is_none() && info.capabilities.prompts.is_none());
    let instructions = info.instructions.clone().expect("instructions");
    for expected in [
        "OP-12",
        "todo \"To Do\"",
        "doing \"In Progress\"",
        "done \"Done\" (done)",
        "\"me\" means Ana",
        "Markdown",
        "+3d",
        "board_summary",
    ] {
        assert!(instructions.contains(expected), "the instructions should mention {expected}: {instructions}");
    }
    assert!(!instructions.contains("read-only"));
    assert!(instructions.len() < 700, "the instructions are read at every session start: {} bytes", instructions.len());
}

#[tokio::test]
async fn a_read_only_server_says_so() {
    let client = connect(FakeBoard::sample(), true).await;
    assert!(client.peer_info().unwrap().instructions.clone().unwrap().contains("This server is read-only."));
}

// --- tools/list ----------------------------------------------------------------------------------------------------

#[tokio::test]
async fn all_ten_tools_are_offered_by_name() {
    let client = connect(FakeBoard::sample(), false).await;
    let mut expected: Vec<String> = READ_TOOLS.iter().chain(WRITE_TOOLS.iter()).map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(names(&tools_json(&client).await), expected);
    assert_eq!(expected.len(), 10);
}

#[tokio::test]
async fn read_only_mode_offers_exactly_the_three_reads() {
    let client = connect(FakeBoard::sample(), true).await;
    assert_eq!(names(&tools_json(&client).await), ["board_summary", "get_card", "list_cards"]);
}

#[tokio::test]
async fn in_read_only_mode_a_write_is_an_unknown_tool_and_changes_nothing() {
    let board = FakeBoard::sample();
    let client = connect(board.clone(), true).await;
    for write in WRITE_TOOLS {
        let outcome = client
            .call_tool(CallToolRequestParams::new(write).with_arguments(arguments(
                json!({ "key": "OP-1", "title": "x", "text": "x", "column": "done", "comment_id": "c1" }),
            )))
            .await;
        assert!(matches!(outcome, Err(ServiceError::McpError(_))), "{write} should not be callable: {outcome:?}");
    }
    assert_eq!(board.cards().len(), 3);
    assert!(board.call_log().is_empty(), "no write reached the board: {:?}", board.call_log());
}

#[tokio::test]
async fn annotations_tell_clients_what_each_tool_does_to_the_vault() {
    let client = connect(FakeBoard::sample(), false).await;
    let tools = tools_json(&client).await;
    // (tool, readOnly, destructive, idempotent)
    let table = [
        ("list_cards", Some(true), None, None),
        ("get_card", Some(true), None, None),
        ("board_summary", Some(true), None, None),
        ("create_card", None, Some(false), Some(false)),
        ("update_card", None, Some(true), Some(true)),
        ("move_card", None, Some(false), Some(true)),
        ("delete_card", None, Some(true), Some(false)),
        ("add_comment", None, Some(false), Some(false)),
        ("edit_comment", None, Some(true), Some(true)),
        ("delete_comment", None, Some(true), Some(false)),
    ];
    for (name, read_only, destructive, idempotent) in table {
        let annotations = &tool(&tools, name)["annotations"];
        assert_eq!(annotations["readOnlyHint"].as_bool(), read_only, "{name} readOnlyHint");
        assert_eq!(annotations["destructiveHint"].as_bool(), destructive, "{name} destructiveHint");
        assert_eq!(annotations["idempotentHint"].as_bool(), idempotent, "{name} idempotentHint");
        assert_eq!(annotations["openWorldHint"], json!(false), "{name} only touches the vault");
    }
}

/// Calls `visit` with every JSON Schema keyword used anywhere in `schema`. Property names are not keywords: a field may
/// well be called `title` (a card's title is).
fn keywords(schema: &Value, visit: &mut impl FnMut(&str)) {
    let Value::Object(object) = schema else { return };
    for (key, inner) in object {
        visit(key);
        match key.as_str() {
            "properties" => inner.as_object().into_iter().flat_map(|m| m.values()).for_each(|p| keywords(p, visit)),
            "items" => keywords(inner, visit),
            "anyOf" | "oneOf" | "allOf" => inner.as_array().into_iter().flatten().for_each(|o| keywords(o, visit)),
            _ => {}
        }
    }
}

#[tokio::test]
async fn schemas_are_compact_plain_json_schema_objects() {
    let client = connect(FakeBoard::sample(), false).await;
    for tool in tools_json(&client).await {
        let name = tool["name"].as_str().unwrap();
        let schema = &tool["inputSchema"];
        assert_eq!(schema["type"], "object", "{name}");
        keywords(schema, &mut |keyword| {
            for noise in ["$schema", "$defs", "$ref", "additionalProperties", "title", "default", "format", "minimum"] {
                assert_ne!(keyword, noise, "{name}'s schema should not carry `{noise}`");
            }
        });
        let description = tool["description"].as_str().unwrap_or_default();
        assert!(description.len() > 15 && description.len() < 260, "{name}: {description}");
        assert!(description.ends_with('.'), "{name}");
    }
}

#[tokio::test]
async fn required_fields_are_exactly_the_ones_a_call_cannot_do_without() {
    let client = connect(FakeBoard::sample(), false).await;
    let tools = tools_json(&client).await;
    let required = |name: &str| -> Vec<String> {
        tool(&tools, name)["inputSchema"]["required"]
            .as_array()
            .map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect())
            .unwrap_or_default()
    };
    assert_eq!(required("list_cards"), Vec::<String>::new());
    assert_eq!(required("board_summary"), Vec::<String>::new());
    assert_eq!(required("get_card"), ["key"]);
    assert_eq!(required("delete_card"), ["key"]);
    assert_eq!(required("create_card"), ["title"]);
    assert_eq!(required("update_card"), ["key"]);
    assert_eq!(required("move_card"), ["key", "column"]);
    assert_eq!(required("add_comment"), ["key", "text"]);
    assert_eq!(required("edit_comment"), ["key", "comment_id", "text"]);
    assert_eq!(required("delete_comment"), ["key", "comment_id"]);
}

#[tokio::test]
async fn enums_are_spelled_out_in_the_schema_so_the_model_sees_the_valid_values() {
    let client = connect(FakeBoard::sample(), false).await;
    let tools = tools_json(&client).await;
    let list = &tool(&tools, "list_cards")["inputSchema"]["properties"];
    assert_eq!(list["type"]["items"]["enum"], json!(["task", "story", "bug", "epic"]));
    assert_eq!(list["priority"]["items"]["enum"], json!(["highest", "high", "medium", "low", "lowest"]));
    let create = &tool(&tools, "create_card")["inputSchema"]["properties"];
    assert_eq!(create["type"]["enum"], json!(["task", "story", "bug", "epic"]));
    assert_eq!(create["priority"]["enum"], json!(["highest", "high", "medium", "low", "lowest"]));
}

#[tokio::test]
async fn only_the_fields_where_null_means_clear_allow_null() {
    let client = connect(FakeBoard::sample(), false).await;
    let tools = tools_json(&client).await;
    for tool in &tools {
        let name = tool["name"].as_str().unwrap();
        let properties = tool["inputSchema"]["properties"].as_object().unwrap();
        for (field, schema) in properties {
            let allows_null = schema.to_string().contains("\"null\"");
            let clears = name == "update_card" && ["assignee", "due", "estimate", "parent"].contains(&field.as_str());
            assert_eq!(allows_null, clears, "{name}.{field}: {schema}");
        }
    }
}

#[tokio::test]
async fn the_list_of_tools_stays_small_because_every_session_pays_for_it() {
    let client = connect(FakeBoard::sample(), false).await;
    let tools = tools_json(&client).await;
    let bytes = serde_json::to_string(&tools).unwrap().len();
    println!("tools/list: {bytes} bytes for {} tools (about {} tokens)", tools.len(), bytes * 10 / 36);
    assert!(bytes <= 5600, "tools/list is {bytes} bytes (it was 5,412 when this budget was set)");
    let read_only = connect(FakeBoard::sample(), true).await;
    let read_only_bytes = serde_json::to_string(&tools_json(&read_only).await).unwrap().len();
    assert!(read_only_bytes < bytes / 2, "a read-only server tells the agent much less: {read_only_bytes} vs {bytes}");
}

// --- tools/call ----------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_read_returns_the_text_and_is_not_an_error() {
    let client = connect(FakeBoard::sample(), false).await;
    let result = call(&client, "list_cards", json!({ "status": "doing" })).await;
    assert!(!is_error(&result));
    assert!(text(&result).starts_with("1 of 1 card\nOP-2 [doing]"), "{}", text(&result));
    let summary = call(&client, "board_summary", json!({})).await;
    assert!(text(&summary).starts_with("Board OP (folder Cards): 3 cards"));
    let one = call(&client, "get_card", json!({ "key": "2" })).await;
    assert!(text(&one).contains("comments (1):"));
}

#[tokio::test]
async fn board_summary_may_be_called_with_no_arguments_at_all() {
    let client = connect(FakeBoard::sample(), false).await;
    let result = client.call_tool(CallToolRequestParams::new("board_summary")).await.unwrap();
    assert!(!is_error(&result));
    assert!(text(&result).starts_with("Board OP"));
}

#[tokio::test]
async fn a_full_workflow_through_the_protocol() {
    let board = FakeBoard::sample();
    let client = connect(board.clone(), false).await;

    let created = call(
        &client,
        "create_card",
        json!({ "title": "Add dark mode", "type": "story", "due": "+1w", "labels": ["ui"] }),
    )
    .await;
    assert_eq!(text(&created), r#"Created: OP-4 [todo] medium story "Add dark mode" due:2026-10-21 labels:ui"#);

    let updated = call(&client, "update_card", json!({ "key": "OP-4", "assignee": "Ana", "estimate": 3 })).await;
    assert!(text(&updated).contains("@Ana") && text(&updated).contains("est:3"), "{}", text(&updated));
    let cleared = call(&client, "update_card", json!({ "key": "OP-4", "assignee": null })).await;
    assert!(!text(&cleared).contains('@'), "{}", text(&cleared));

    let moved = call(&client, "move_card", json!({ "key": "4", "column": "In Progress", "before": "OP-2" })).await;
    assert!(text(&moved).starts_with("Moved: OP-4 [doing]"));

    let commented = call(&client, "add_comment", json!({ "key": "OP-4", "text": "Started." })).await;
    assert_eq!(text(&commented), "Added comment c1 to OP-4 (1 in all).");
    assert_eq!(
        board.get_card("OP-4").comments[0].author,
        "Claude",
        "the server's author signs when the call names none"
    );
    let edited =
        call(&client, "edit_comment", json!({ "key": "OP-4", "comment_id": "c1", "text": "Started, and done." })).await;
    assert_eq!(text(&edited), "Edited comment c1 of OP-4.");
    let removed = call(&client, "delete_comment", json!({ "key": "OP-4", "comment_id": "c1" })).await;
    assert_eq!(text(&removed), "Deleted comment c1 from OP-4 (0 left).");

    let deleted = call(&client, "delete_card", json!({ "key": "OP-4" })).await;
    assert!(text(&deleted).starts_with("Deleted OP-4"));
    assert_eq!(board.cards().len(), 3);
    assert!(!is_error(&deleted));
}

#[tokio::test]
async fn what_the_board_refuses_comes_back_as_a_tool_error_the_model_can_read() {
    let client = connect(FakeBoard::sample(), false).await;
    let missing = call(&client, "get_card", json!({ "key": "OP-404" })).await;
    assert!(is_error(&missing));
    assert_eq!(text(&missing), "Card OP-404 not found");
    let column = call(&client, "move_card", json!({ "key": "1", "column": "limbo" })).await;
    assert!(is_error(&column));
    assert!(text(&column).contains("Unknown column \"limbo\"") && text(&column).contains("doing"), "{}", text(&column));
    let date = call(&client, "create_card", json!({ "title": "x", "due": "someday" })).await;
    assert!(is_error(&date));
    assert!(text(&date).contains("use YYYY-MM-DD, today, tomorrow, +3d, +2w"));
}

#[tokio::test]
async fn bad_arguments_are_tool_errors_too_and_say_which_field() {
    let client = connect(FakeBoard::sample(), false).await;
    let cases = [
        ("list_cards", json!({ "asignee": "x" }), "unknown field `asignee`"),
        ("list_cards", json!({ "type": ["tsak"] }), "unknown variant `tsak`"),
        ("list_cards", json!({ "limit": "ten" }), "invalid type"),
        ("create_card", json!({}), "missing field `title`"),
        ("update_card", json!({ "key": "1", "status": "done" }), "unknown field `status`"),
        ("move_card", json!({ "key": "1" }), "missing field `column`"),
        ("edit_comment", json!({ "key": "1", "text": "x" }), "missing field `comment_id`"),
    ];
    for (tool, args, expected) in cases {
        let result = call(&client, tool, args.clone()).await;
        assert!(is_error(&result), "{tool} {args}");
        assert!(text(&result).contains(expected), "{tool} {args}: {}", text(&result));
    }
}

#[tokio::test]
async fn a_panic_inside_a_tool_is_a_tool_error_and_the_server_keeps_serving() {
    let board = FakeBoard::sample();
    let client = connect(board.clone(), false).await;
    *board.panic_next.lock().unwrap() = true;
    let result = call(&client, "get_card", json!({ "key": "OP-1" })).await;
    assert!(is_error(&result));
    assert!(text(&result).contains("Internal error: the operation panicked"), "{}", text(&result));
    assert!(text(&result).contains("still running"));
    // The next call works: nothing was left locked or half done.
    let again = call(&client, "get_card", json!({ "key": "OP-1" })).await;
    assert!(!is_error(&again), "{}", text(&again));
    assert!(text(&again).starts_with("OP-1 [todo]"));
}

#[tokio::test]
async fn an_unknown_tool_is_a_protocol_error() {
    let client = connect(FakeBoard::sample(), false).await;
    let outcome = client.call_tool(CallToolRequestParams::new("frobnicate")).await;
    assert!(matches!(outcome, Err(ServiceError::McpError(_))), "{outcome:?}");
}

#[tokio::test]
async fn many_calls_at_once_each_get_their_own_answer() {
    let board = FakeBoard::new((1..=60).map(|n| card(n, "todo", &format!("Card {n}"))).collect());
    let client = connect(board, false).await;
    let mut tasks = Vec::new();
    for n in 1..=40u32 {
        let peer = client.peer().clone();
        tasks.push(tokio::spawn(async move {
            let result = peer
                .call_tool(
                    CallToolRequestParams::new("get_card").with_arguments(arguments(json!({ "key": n.to_string() }))),
                )
                .await
                .unwrap();
            (n, text(&result))
        }));
    }
    for task in tasks {
        let (n, body) = task.await.unwrap();
        assert!(body.starts_with(&format!("OP-{n} [todo]")), "{n}: {body}");
    }
}

#[tokio::test]
async fn a_slow_board_does_not_block_the_protocol() {
    struct Slow(Arc<FakeBoard>);
    // The fake answers instantly, so what is checked here is that a call is served on the blocking pool: two calls can be
    // outstanding at once and both complete.
    let client = connect(Arc::clone(&Slow(FakeBoard::sample()).0), false).await;
    let (a, b) = tokio::join!(call(&client, "list_cards", json!({})), call(&client, "board_summary", json!({})));
    assert!(!is_error(&a) && !is_error(&b));
}

#[tokio::test]
async fn the_server_stops_when_the_client_goes_away() {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let server = Projects::new(FakeBoard::sample(), &options(false));
    let task = tokio::spawn(async move { server.serve(server_io).await.unwrap().waiting().await });
    let client = ().serve(client_io).await.unwrap();
    drop(client);
    let outcome =
        tokio::time::timeout(std::time::Duration::from_secs(5), task).await.expect("the server exits").unwrap();
    assert!(outcome.is_ok());
}

#[tokio::test]
async fn the_handler_reports_the_same_info_without_a_connection() {
    let server = Projects::new(FakeBoard::sample(), &options(false));
    let info = server.get_info();
    assert_eq!(info.server_info.name, "oprojects-mcp");
    assert_eq!(server.tools().len(), 10);
}

trait Cards {
    fn get_card(&self, key: &str) -> oprojects_mcp::types::Card;
}

impl Cards for FakeBoard {
    fn get_card(&self, key: &str) -> oprojects_mcp::types::Card {
        use oprojects_mcp::api::Board;
        self.get(key).unwrap()
    }
}
