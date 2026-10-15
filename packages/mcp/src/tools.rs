//! The ten tools, registered with the protocol. Each tool is a thin wrapper: it moves the call onto the blocking pool
//! (anything may touch the disk, and the protocol thread must stay free to answer other requests) and hands it to the
//! matching function in [`crate::ops`]. An `Err` becomes a tool error (`isError: true`, the message as text), which is
//! what lets the model read what was wrong, and correct itself; protocol errors are left for malformed requests.
//!
//! Reads: `list_cards`, `get_card`, `board_summary`. Writes: `create_card`, `update_card`, `move_card`,
//! `delete_card`, `add_comment`, `edit_comment`, `delete_comment`. In read-only mode the writes are not registered at
//! all: they are absent from `tools/list` and a call to one is an unknown tool, not a refusal.
use std::sync::Arc;

use rmcp::{
    ServerHandler,
    handler::server::{tool::ToolRouter, wrapper::Parameters},
    model::{Implementation, ServerCapabilities, ServerConfig, Tool},
    tool, tool_handler, tool_router,
};
use serde_json::{Map, Value};

use crate::api::Board;
use crate::ops::{self, AddComment, CreateCard, DeleteComment, EditComment, KeyArgs, ListCards, MoveCard, UpdateCard};
use crate::types::BoardConfig;

/// Tools that read. They are always offered.
pub const READ_TOOLS: [&str; 3] = ["list_cards", "get_card", "board_summary"];

/// Tools that change the vault. Removed in read-only mode.
pub const WRITE_TOOLS: [&str; 7] =
    ["create_card", "update_card", "move_card", "delete_card", "add_comment", "edit_comment", "delete_comment"];

/// How the server was started, as far as the tools are concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerOptions {
    pub read_only: bool,
    /// Signs the comments the agent adds when the call names no author.
    pub author: String,
}

/// The server: a board and the tools that act on it. Cloning is cheap (the board is shared, the router holds `Arc`s):
/// the HTTP transport asks for one handler per request.
#[derive(Clone)]
pub struct Projects {
    board: Arc<dyn Board>,
    author: String,
    instructions: String,
    tool_router: ToolRouter<Self>,
}

impl Projects {
    pub fn new(board: Arc<dyn Board>, options: &ServerOptions) -> Self {
        let mut tool_router = Self::tool_router();
        if options.read_only {
            for name in WRITE_TOOLS {
                tool_router.remove_route(name);
            }
        }
        // The schema of every tool is sent to the agent at the start of every session, so it is made as small as it can be.
        for route in tool_router.map.values_mut() {
            let mut schema = Map::clone(&route.attr.input_schema);
            compact_schema(&mut schema, nullable_fields(route.attr.name.as_ref()));
            route.attr.input_schema = Arc::new(schema);
        }
        let instructions = instructions(board.config(), options.read_only);
        Self { board, author: options.author.clone(), instructions, tool_router }
    }

    /// The tools this server offers, as `tools/list` shows them.
    pub fn tools(&self) -> Vec<Tool> {
        self.tool_router.list_all()
    }

    /// Runs `work` on the blocking pool and turns its outcome into the text of a tool result.
    async fn run<F>(&self, work: F) -> std::result::Result<String, String>
    where
        F: FnOnce(&dyn Board) -> crate::error::Result<String> + Send + 'static,
    {
        let board = Arc::clone(&self.board);
        match tokio::task::spawn_blocking(move || work(board.as_ref())).await {
            Ok(outcome) => outcome.map_err(|e| e.to_string()),
            Err(failure) if failure.is_panic() => Err(
                "Internal error: the operation panicked, which is a bug in oprojects-mcp. The server is still running; \
                 check the card with get_card before retrying."
                    .into(),
            ),
            Err(_) => Err("Internal error: the operation was cancelled.".into()),
        }
    }
}

// Annotations: a tool is destructive when it can lose information (deleting, or overwriting text such as a description
// or a comment); moving a card and adding things lose nothing. `open_world_hint = false` everywhere: the tools only
// touch the vault.
#[tool_router]
impl Projects {
    #[tool(
        description = "List cards in board order. Filters are ANDed; several values of one filter are alternatives. Old done cards need include_archived.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn list_cards(&self, Parameters(args): Parameters<ListCards>) -> std::result::Result<String, String> {
        self.run(move |board| ops::list_cards(board, args)).await
    }

    #[tool(
        description = "Read one card: fields, description and comments (with ids).",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn get_card(&self, Parameters(args): Parameters<KeyArgs>) -> std::result::Result<String, String> {
        self.run(move |board| ops::get_card(board, args)).await
    }

    #[tool(
        description = "Cards per column with WIP limits, overdue and unassigned counts. A good first call.",
        annotations(read_only_hint = true, open_world_hint = false)
    )]
    async fn board_summary(&self) -> std::result::Result<String, String> {
        self.run(ops::board_summary).await
    }

    #[tool(
        description = "Create a card at the bottom of a column (default: the first).",
        annotations(destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn create_card(&self, Parameters(args): Parameters<CreateCard>) -> std::result::Result<String, String> {
        self.run(move |board| ops::create_card(board, args)).await
    }

    #[tool(
        description = "Change fields of a card: omit one to keep it, null clears assignee, due, estimate or parent. To change the column use move_card.",
        annotations(destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn update_card(&self, Parameters(args): Parameters<UpdateCard>) -> std::result::Result<String, String> {
        self.run(move |board| ops::update_card(board, args)).await
    }

    #[tool(
        description = "Move a card to a column, or reorder it with before/after another card.",
        annotations(destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn move_card(&self, Parameters(args): Parameters<MoveCard>) -> std::result::Result<String, String> {
        self.run(move |board| ops::move_card(board, args)).await
    }

    #[tool(
        description = "Delete a card: its note goes to the vault's .trash.",
        annotations(destructive_hint = true, idempotent_hint = false, open_world_hint = false)
    )]
    async fn delete_card(&self, Parameters(args): Parameters<KeyArgs>) -> std::result::Result<String, String> {
        self.run(move |board| ops::delete_card(board, args)).await
    }

    #[tool(
        description = "Add a Markdown comment to a card.",
        annotations(destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn add_comment(&self, Parameters(args): Parameters<AddComment>) -> std::result::Result<String, String> {
        let author = self.author.clone();
        self.run(move |board| ops::add_comment(board, args, &author)).await
    }

    #[tool(
        description = "Replace a comment's text.",
        annotations(destructive_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn edit_comment(&self, Parameters(args): Parameters<EditComment>) -> std::result::Result<String, String> {
        self.run(move |board| ops::edit_comment(board, args)).await
    }

    #[tool(
        description = "Delete a comment.",
        annotations(destructive_hint = true, idempotent_hint = false, open_world_hint = false)
    )]
    async fn delete_comment(&self, Parameters(args): Parameters<DeleteComment>) -> std::result::Result<String, String> {
        self.run(move |board| ops::delete_comment(board, args)).await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Projects {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("oprojects-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions(self.instructions.clone())
    }
}

// --- what the agent is told at the start ----------------------------------------------------------------------------

/// A few sentences, built from the board, that save the agent several calls: what the cards are called, which columns
/// exist, who "me" is, and what formats to use.
pub fn instructions(config: &BoardConfig, read_only: bool) -> String {
    let columns = config
        .columns
        .iter()
        .map(|c| format!("{} \"{}\"{}", c.id, c.name, if c.done { " (done)" } else { "" }))
        .collect::<Vec<_>>()
        .join(", ");
    let mut text = format!(
        "Cards of an Obsidian vault, as a board. Keys look like {p}-12 (a bare 12 works). Columns: {columns}. \
         Descriptions and comments are Markdown. Dates: YYYY-MM-DD, today, tomorrow, +3d, +2w. \
         Start with board_summary, and filter list_cards instead of reading cards one by one.",
        p = config.prefix
    );
    if !config.me.is_empty() {
        text.push_str(&format!(" \"me\" means {}.", config.me));
    }
    if read_only {
        text.push_str(" This server is read-only.");
    }
    text
}

// --- smaller schemas -------------------------------------------------------------------------------------------------

/// The fields whose `null` means something (it clears the field), so the schema must keep allowing it.
fn nullable_fields(tool: &str) -> &'static [&'static str] {
    if tool == "update_card" { &["assignee", "due", "estimate", "parent"] } else { &[] }
}

/// Shrinks a generated input schema without changing what it accepts: drops `$schema`, inlines the `$defs` references,
/// and removes what only adds bytes (`additionalProperties`, since unknown fields are still refused when the call is read;
/// `default`, `format` and `minimum`, which the descriptions already convey) and, for fields where `null` is no different
/// from leaving the field out, the `null` alternative.
pub fn compact_schema(schema: &mut Map<String, Value>, keep_null: &[&str]) {
    schema.remove("$schema");
    let defs = match schema.remove("$defs") {
        Some(Value::Object(defs)) => defs,
        _ => Map::new(),
    };
    let mut root = Value::Object(std::mem::take(schema));
    inline_refs(&mut root, &defs);
    visit_schemas(&mut root, &mut |node| {
        for noise in ["additionalProperties", "default", "format", "minimum", "title"] {
            node.remove(noise);
        }
    });
    if let Some(Value::Object(properties)) = root.get_mut("properties") {
        for (name, property) in properties.iter_mut() {
            if !keep_null.contains(&name.as_str()) {
                drop_null(property);
            }
        }
    }
    if let Value::Object(object) = root {
        *schema = object;
    }
}

/// Calls `f` on every schema node: the root, each property, `items`, and the members of `anyOf`/`oneOf`/`allOf`. The keys
/// of `properties` are field names, not keywords, so they are never visited as such.
fn visit_schemas(node: &mut Value, f: &mut impl FnMut(&mut Map<String, Value>)) {
    let Value::Object(object) = node else { return };
    f(object);
    if let Some(Value::Object(properties)) = object.get_mut("properties") {
        properties.values_mut().for_each(|p| visit_schemas(p, f));
    }
    if let Some(items) = object.get_mut("items") {
        visit_schemas(items, f);
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(Value::Array(options)) = object.get_mut(key) {
            options.iter_mut().for_each(|o| visit_schemas(o, f));
        }
    }
}

fn inline_refs(value: &mut Value, defs: &Map<String, Value>) {
    match value {
        Value::Object(object) => {
            let target = object.get("$ref").and_then(Value::as_str).and_then(|r| r.strip_prefix("#/$defs/"));
            if let Some(definition) = target.and_then(|name| defs.get(name)) {
                let mut definition = definition.clone();
                inline_refs(&mut definition, defs);
                object.remove("$ref");
                if let Value::Object(definition) = definition {
                    for (key, inner) in definition {
                        object.entry(key).or_insert(inner);
                    }
                }
            }
            for inner in object.values_mut() {
                inline_refs(inner, defs);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| inline_refs(item, defs)),
        _ => {}
    }
}

/// `{"type": ["string", "null"]}` becomes `{"type": "string"}`, and `anyOf [X, {"type": "null"}]` becomes `X`.
fn drop_null(property: &mut Value) {
    let Value::Object(object) = property else { return };
    if let Some(Value::Array(types)) = object.get("type") {
        let kept: Vec<Value> = types.iter().filter(|t| t.as_str() != Some("null")).cloned().collect();
        if kept.len() == 1 {
            object.insert("type".into(), kept.into_iter().next().expect("one element"));
        } else if kept.len() > 1 {
            object.insert("type".into(), Value::Array(kept));
        }
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(options)) = object.get(key) {
            let kept: Vec<Value> =
                options.iter().filter(|o| o.get("type").and_then(Value::as_str) != Some("null")).cloned().collect();
            if kept.len() == 1 && kept.len() < options.len() {
                object.remove(key);
                if let Some(Value::Object(only)) = kept.into_iter().next() {
                    for (k, v) in only {
                        object.entry(k).or_insert(v);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn compacted(schema: Value, keep_null: &[&str]) -> Value {
        let mut map = schema.as_object().cloned().expect("a schema object");
        compact_schema(&mut map, keep_null);
        Value::Object(map)
    }

    #[test]
    fn references_are_inlined_and_the_definitions_dropped() {
        let schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": {
                "kind": { "$ref": "#/$defs/Kind" },
                "kinds": { "type": "array", "items": { "$ref": "#/$defs/Kind" } }
            },
            "$defs": { "Kind": { "type": "string", "enum": ["a", "b"] } }
        });
        assert_eq!(
            compacted(schema, &[]),
            json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["a", "b"] },
                    "kinds": { "type": "array", "items": { "type": "string", "enum": ["a", "b"] } }
                }
            })
        );
    }

    #[test]
    fn a_reference_to_a_definition_that_refers_to_another_is_followed() {
        let schema = json!({
            "type": "object",
            "properties": { "x": { "$ref": "#/$defs/Outer" } },
            "$defs": { "Outer": { "type": "array", "items": { "$ref": "#/$defs/Inner" } }, "Inner": { "type": "string" } }
        });
        assert_eq!(
            compacted(schema, &[])["properties"]["x"],
            json!({ "type": "array", "items": { "type": "string" } })
        );
    }

    #[test]
    fn noise_keywords_go_but_fields_with_those_names_stay() {
        let schema = json!({
            "type": "object",
            "title": "Noise",
            "additionalProperties": false,
            "properties": {
                "format": { "type": "string", "description": "A field called format.", "default": "x" },
                "title": { "type": "string", "format": "uri" },
                "default": { "type": "integer", "format": "uint32", "minimum": 0 }
            },
            "required": ["title"]
        });
        assert_eq!(
            compacted(schema, &[]),
            json!({
                "type": "object",
                "properties": {
                    "format": { "type": "string", "description": "A field called format." },
                    "title": { "type": "string" },
                    "default": { "type": "integer" }
                },
                "required": ["title"]
            })
        );
    }

    #[test]
    fn null_alternatives_are_dropped_except_where_null_means_clear() {
        let schema = json!({
            "type": "object",
            "properties": {
                "plain": { "type": ["string", "null"] },
                "list": { "type": ["array", "null"], "items": { "type": "string" } },
                "either": { "anyOf": [{ "type": "string", "enum": ["a"] }, { "type": "null" }] },
                "clears": { "type": ["string", "null"], "description": "null removes it." },
                "multi": { "type": ["string", "number", "null"] }
            }
        });
        let out = compacted(schema, &["clears"]);
        assert_eq!(out["properties"]["plain"], json!({ "type": "string" }));
        assert_eq!(out["properties"]["list"], json!({ "type": "array", "items": { "type": "string" } }));
        assert_eq!(out["properties"]["either"], json!({ "type": "string", "enum": ["a"] }));
        assert_eq!(
            out["properties"]["clears"],
            json!({ "type": ["string", "null"], "description": "null removes it." })
        );
        assert_eq!(out["properties"]["multi"], json!({ "type": ["string", "number"] }));
    }

    #[test]
    fn a_schema_with_nothing_to_compact_is_left_alone() {
        let schema = json!({ "type": "object", "properties": { "key": { "type": "string" } }, "required": ["key"] });
        assert_eq!(compacted(schema.clone(), &[]), schema);
        assert_eq!(compacted(json!({ "type": "object" }), &[]), json!({ "type": "object" }));
    }

    #[test]
    fn only_update_card_keeps_nulls() {
        assert_eq!(nullable_fields("update_card"), ["assignee", "due", "estimate", "parent"]);
        for other in READ_TOOLS.iter().chain(WRITE_TOOLS.iter()).filter(|t| **t != "update_card") {
            assert!(nullable_fields(other).is_empty(), "{other}");
        }
    }

    #[test]
    fn the_instructions_describe_the_board() {
        let config = BoardConfig { prefix: "BAAS".into(), ..BoardConfig::default() };
        let text = instructions(&config, false);
        assert!(text.contains("Keys look like BAAS-12"), "{text}");
        assert!(
            text.contains("todo \"To Do\", doing \"In Progress\", review \"Review\", done \"Done\" (done)"),
            "{text}"
        );
        assert!(!text.contains("\"me\" means"), "no one is configured as me: {text}");
        assert!(!text.contains("read-only"));
    }

    #[test]
    fn the_instructions_name_me_and_say_when_the_server_is_read_only() {
        let config = BoardConfig { me: "Gustavo Eklund".into(), ..BoardConfig::default() };
        let text = instructions(&config, true);
        assert!(text.contains("\"me\" means Gustavo Eklund."), "{text}");
        assert!(text.ends_with("This server is read-only."), "{text}");
    }

    #[test]
    fn the_read_and_write_tool_lists_partition_the_ten_tools() {
        let all: std::collections::BTreeSet<&str> = READ_TOOLS.iter().chain(WRITE_TOOLS.iter()).copied().collect();
        assert_eq!(all.len(), 10, "no tool is in both lists");
        assert_eq!(READ_TOOLS.len() + WRITE_TOOLS.len(), 10);
    }
}
