//! The board configuration and where the vault is: a port of `packages/core/src/config.ts` and `node/vault.ts`.
//!
//! The configuration lives in the plugin's own `data.json` (`.obsidian/plugins/obsidian-projects/data.json`, shaped
//! `{"version": 1, "board": {...}}`), so the plugin, the CLI and this server share one board. The file is edited by hand
//! and written by several programs, so everything here is tolerant: whatever is invalid falls back to a default instead
//! of failing, and saving keeps every other setting the plugin stored next to `board`.
use crate::error::{Error, Result};
use crate::jscompat::js_trim;
use crate::types::{BoardConfig, Column};
use serde_json::{Map, Value};
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

/// The plugin's id, which names its folder under `.obsidian/plugins`.
pub const PLUGIN_ID: &str = "obsidian-projects";
pub const PLUGIN_DATA_PATH: &str = ".obsidian/plugins/obsidian-projects/data.json";

pub fn default_columns() -> Vec<Column> {
    BoardConfig::default().columns
}

/// 2-10 upper-case ASCII letters or digits, starting with a letter (`/^[A-Z][A-Z0-9]{1,9}$/`).
pub fn is_valid_prefix(prefix: &str) -> bool {
    let bytes = prefix.as_bytes();
    (2..=10).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes.iter().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn is_valid_column_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A column id from a display name: accents stripped, lower-cased, runs of anything else become one dash.
pub fn slugify_column_id(name: &str) -> String {
    let stripped: String = name.nfd().filter(|c| !('\u{0300}'..='\u{036f}').contains(c)).collect();
    let mut slug = String::new();
    let mut pending_dash = false;
    for c in stripped.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(c);
        } else {
            pending_dash = true;
        }
    }
    if slug.is_empty() { "column".to_string() } else { slug }
}

/// A folder without leading or trailing slashes or `.` and `..` segments, with `/` separators.
pub fn normalize_folder(folder: &str) -> String {
    folder
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect::<Vec<_>>()
        .join("/")
}

/// A string value, trimmed like JavaScript does; anything else is `None`.
fn string_of(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(|s| js_trim(s).to_string())
}

/// `Math.floor` of a JSON number that must be at least `min`, saturating at the largest value a `u32` holds.
fn floored(value: Option<&Value>, min: f64) -> Option<u32> {
    let x = value?.as_f64()?;
    (x.is_finite() && x >= min).then(|| x.floor().min(f64::from(u32::MAX)) as u32)
}

fn normalize_columns(raw: Option<&Value>) -> Vec<Column> {
    let Some(Value::Array(items)) = raw else { return default_columns() };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let Value::Object(fields) = item else { continue };
        let name = match string_of(fields.get("name")).filter(|s| !s.is_empty()) {
            Some(name) => name,
            None => match string_of(fields.get("id")).filter(|s| !s.is_empty()) {
                Some(id) => id,
                None => continue,
            },
        };
        let mut id = string_of(fields.get("id")).filter(|s| !s.is_empty()).unwrap_or_else(|| slugify_column_id(&name));
        if !is_valid_column_id(&id) {
            id = slugify_column_id(&id);
        }
        if !seen.insert(id.clone()) {
            continue; // ids must be unique; the first wins
        }
        let done = fields.get("done") == Some(&Value::Bool(true));
        // `wip` is kept when the *original* number is positive, then floored: 0.5 becomes Some(0), like the original.
        let wip = fields
            .get("wip")
            .and_then(Value::as_f64)
            .filter(|w| w.is_finite() && *w > 0.0)
            .map(|w| w.floor().min(f64::from(u32::MAX)) as u32);
        out.push(Column { id, name, done, wip });
    }
    if out.is_empty() { default_columns() } else { out }
}

/// A tolerant loader for hand-edited or partially missing settings: whatever is invalid falls back to the default.
pub fn normalize_config(raw: &Value) -> BoardConfig {
    let defaults = BoardConfig::default();
    let empty = Map::new();
    let fields = raw.as_object().unwrap_or(&empty);

    let prefix = string_of(fields.get("prefix")).unwrap_or_default().to_uppercase();
    let folder = normalize_folder(&string_of(fields.get("folder")).unwrap_or_default());
    let mut members: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = fields.get("members") {
        for item in items {
            if let Some(member) = string_of(Some(item)).filter(|m| !m.is_empty())
                && !members.contains(&member)
            {
                members.push(member);
            }
        }
    }
    BoardConfig {
        folder: if folder.is_empty() { defaults.folder } else { folder },
        prefix: if is_valid_prefix(&prefix) { prefix } else { defaults.prefix },
        columns: normalize_columns(fields.get("columns")),
        hide_done_after_days: floored(fields.get("hideDoneAfterDays"), 0.0).unwrap_or(defaults.hide_done_after_days),
        me: string_of(fields.get("me")).unwrap_or_default(),
        members,
    }
}

pub fn column_by_id<'a>(config: &'a BoardConfig, id: &str) -> Option<&'a Column> {
    config.columns.iter().find(|c| c.id == id)
}

/// The column a card is displayed in; an unknown status falls back to the first column.
pub fn display_column<'a>(config: &'a BoardConfig, status: &str) -> &'a Column {
    column_by_id(config, status).unwrap_or(&config.columns[0])
}

pub fn is_done_status(config: &BoardConfig, status: &str) -> bool {
    column_by_id(config, status).is_some_and(|c| c.done)
}

/// A column by id or by display name, trimmed and case-insensitive.
pub fn resolve_column<'a>(config: &'a BoardConfig, id_or_name: &str) -> Option<&'a Column> {
    let needle = js_trim(id_or_name).to_lowercase();
    config.columns.iter().find(|c| c.id == needle || c.name.to_lowercase() == needle)
}

// --- the vault -----------------------------------------------------------------------------------------------------

/// `path.resolve`: absolute, with `.` and `..` resolved lexically (symlinks are not followed).
pub fn resolve_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                if !matches!(out.components().next_back(), Some(Component::RootDir | Component::Prefix(_)) | None) {
                    out.pop();
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_dir(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_dir())
}

/// Where the vault is: an explicit path (a flag or `$OPROJECTS_VAULT`, empty means none) wins, otherwise the nearest
/// ancestor of `start` that has an `.obsidian` folder.
pub fn find_vault_root(start: &Path, explicit: Option<&str>) -> Result<PathBuf> {
    if let Some(explicit) = explicit.filter(|e| !e.is_empty()) {
        let root = resolve_path(Path::new(explicit));
        if !is_dir(&root.join(".obsidian")) {
            return Err(Error::VaultNotFound(format!(
                "\"{}\" is not an Obsidian vault (no .obsidian folder)",
                root.display()
            )));
        }
        return Ok(root);
    }
    let mut dir = resolve_path(start);
    loop {
        if is_dir(&dir.join(".obsidian")) {
            return Ok(dir);
        }
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => {
                return Err(Error::VaultNotFound(
                    "No Obsidian vault found. Run inside a vault, or pass --vault <path> / set OPROJECTS_VAULT.".into(),
                ));
            }
        }
    }
}

/// The vault named by `$OPROJECTS_VAULT`, when set and not empty.
pub fn vault_from_env() -> Option<String> {
    std::env::var("OPROJECTS_VAULT").ok().filter(|v| !v.is_empty())
}

/// The plugin's data as an object. Missing, unreadable, corrupt or non-object data is an empty object; an array
/// counts as an object keyed by index, which is what spreading one does in JavaScript.
fn read_plugin_data(root: &Path) -> Map<String, Value> {
    let Ok(text) = std::fs::read_to_string(root.join(PLUGIN_DATA_PATH)) else { return Map::new() };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map,
        Ok(Value::Array(items)) => items.into_iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        _ => Map::new(),
    }
}

pub fn load_board_config(root: &Path) -> BoardConfig {
    match read_plugin_data(root).get("board") {
        Some(board) if !board.is_null() => normalize_config(board),
        _ => BoardConfig::default(),
    }
}

pub fn has_board_config(root: &Path) -> bool {
    read_plugin_data(root).contains_key("board")
}

/// Writes `board` while keeping any other settings the plugin stored. The file is pretty JSON ending with a newline,
/// replaced atomically so a reader never sees half of it.
pub fn save_board_config(root: &Path, board: &BoardConfig) -> Result<()> {
    let mut data = read_plugin_data(root);
    data.insert("board".to_string(), serde_json::to_value(board).map_err(|e| Error::Config(e.to_string()))?);
    let file = root.join(PLUGIN_DATA_PATH);
    let dir = file.parent().expect("the data file has a parent folder");
    std::fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
    let mut text = serde_json::to_string_pretty(&Value::Object(data)).map_err(|e| Error::Config(e.to_string()))?;
    text.push('\n');
    let temp = dir.join(format!(".data.json.{}.tmp", std::process::id()));
    std::fs::write(&temp, text).map_err(|e| Error::io(&temp, e))?;
    std::fs::rename(&temp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        Error::io(&file, e)
    })
}
