//! The commands of `oprojects`, a port of `packages/cli/src/run.ts`: what each one reads from its arguments, which
//! service call it makes and what it prints. The messages, the order in which problems are noticed and the exit codes are
//! the TypeScript's; the conformance corpus holds what that version did.
use super::Io;
use super::json;
use super::parse::{Opt, Parsed, flag, text};
use super::render::{Painter, Style, render_board, render_card, render_table};
use crate::api::{Board, CardQuery, CommentInput};
use crate::config::{has_board_config, is_valid_prefix, normalize_config, normalize_folder, save_board_config};
use crate::due::parse_due;
use crate::error::Error;
use crate::jscompat::{js_to_number, js_trim};
use crate::query::{Now, group_by_column};
use crate::service::{CardService, clean_title};
use crate::storage::{FsStorage, Storage};
use crate::types::{BoardConfig, CARD_TYPES, Card, CardPatch, CardType, NewCardInput, PRIORITIES, Placement, Priority};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// Why a command did not finish.
#[derive(Debug)]
pub enum Failure {
    /// The command line is wrong (a bad flag, a missing argument): exit code 2.
    Usage(String),
    /// The vault or the cards do not allow it: exit code 1, and `{"error": …}` with `--json`.
    Domain(Error),
    /// Anything else (an opener that failed to start): exit code 1 and plain text, even with `--json`.
    Other(String),
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self::Domain(error)
    }
}

pub type CmdResult = Result<(), Failure>;

fn usage<T>(message: impl Into<String>) -> Result<T, Failure> {
    Err(Failure::Usage(message.into()))
}

/// Everything a command works with.
pub struct Ctx<'a, 'io> {
    pub io: &'a mut Io<'io>,
    pub root: PathBuf,
    pub config: BoardConfig,
    pub svc: CardService<Arc<FsStorage>>,
    pub paint: Painter,
    pub json: bool,
    pub now: Now,
}

impl Ctx<'_, '_> {
    fn out(&mut self, text: &str) {
        self.io.write_out(text);
    }

    fn emit(&mut self, value: &Value) {
        let text = json::pretty(value) + "\n";
        self.io.write_out(&text);
    }
}

pub struct Command {
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub summary: &'static str,
    pub usage: &'static str,
    pub examples: &'static [&'static str],
    /// Options besides the global ones, in groups.
    pub options: &'static [&'static [Opt]],
    pub run: fn(&mut Ctx, &Parsed) -> CmdResult,
}

impl Command {
    /// The options of this command and the global ones.
    pub fn all_options(&self) -> Vec<Opt> {
        GLOBAL.iter().chain(self.options.iter().flat_map(|group| group.iter())).copied().collect()
    }
}

pub const GLOBAL: &[Opt] = &[text("vault"), flag("json"), flag("no-color"), flag("help").short('h')];

const FILTER: &[Opt] = &[
    text("status").short('s').multiple(),
    text("type").short('t').multiple(),
    text("priority").short('p').multiple(),
    text("assignee").short('a').multiple(),
    text("label").short('l').multiple(),
    text("parent"),
    text("query").short('q'),
    flag("mine"),
    flag("all"),
];

const FIELDS: &[Opt] = &[
    text("status").short('s'),
    text("type").short('t'),
    text("priority").short('p'),
    text("assignee").short('a'),
    text("label").short('l').multiple(),
    text("due"),
    text("estimate"),
    text("parent"),
    text("body"),
];

pub const COMMANDS: &[Command] = &[
    Command {
        name: "add",
        aliases: &["new", "create"],
        summary: "Create a card",
        usage: "oprojects add <title…> [-t type] [-p priority] [-s status] [-a assignee] [-l label,…] [--due date] [--estimate n] [--parent KEY] [--body text|-]",
        examples: &[
            "oprojects add Fix the login redirect -t bug -p high -a ana --due +3d",
            "oprojects add \"Write release notes\" -s doing -l docs,release",
            "echo \"Steps to reproduce…\" | oprojects add Crash on save -t bug --body -",
        ],
        options: &[FIELDS],
        run: add,
    },
    Command {
        name: "list",
        aliases: &["ls"],
        summary: "List cards (hides done cards older than the board setting; --all shows them)",
        usage: "oprojects list [-s status] [-t type] [-p priority] [-a assignee|none|me] [-l label] [--parent KEY] [-q text] [--mine] [--all]",
        examples: &[
            "oprojects ls --mine",
            "oprojects ls -s doing -s review",
            "oprojects ls -q \"login\" -t bug --json",
        ],
        options: &[FILTER],
        run: list,
    },
    Command {
        name: "board",
        aliases: &["b"],
        summary: "Show the kanban board (epics are hidden unless --epics)",
        usage: "oprojects board [same filters as list] [--epics]",
        examples: &[],
        options: &[FILTER, &[flag("epics")]],
        run: board,
    },
    Command {
        name: "show",
        aliases: &["get"],
        summary: "Show one card with its description",
        usage: "oprojects show <key>",
        examples: &[],
        options: &[],
        run: show,
    },
    Command {
        name: "comment",
        aliases: &["c"],
        summary: "Add, edit or remove a comment on a card",
        usage: "oprojects comment <key> <text…|-> [--author name]   |   oprojects comment <key> --edit <id> <text…|->   |   oprojects comment <key> --rm <id>",
        examples: &[
            "oprojects comment 12 \"Reproduced on Safari, only there\"",
            "git log -1 --format=%B | oprojects comment 12 -",
            "oprojects show 12            # comments are listed with their ids",
            "oprojects comment 12 --edit k3f9a \"texto corrigido\"",
            "oprojects comment 12 --rm k3f9a",
        ],
        options: &[&[text("author"), text("edit"), text("rm")]],
        run: comment,
    },
    Command {
        name: "move",
        aliases: &["mv"],
        summary: "Move a card to another column (optionally next to a card)",
        usage: "oprojects move <key> <status> [--before KEY | --after KEY]",
        examples: &["oprojects mv 12 doing", "oprojects mv OP-12 review --before OP-3"],
        options: &[&[text("before"), text("after")]],
        run: move_card,
    },
    Command {
        name: "edit",
        aliases: &["set"],
        summary: "Change fields of a card (use \"none\" to clear a field)",
        usage: "oprojects edit <key> [--title t] [-s status] [-t type] [-p priority] [-a assignee|none] [-l label,…] [--add-label l] [--rm-label l] [--due date|none] [--estimate n|none] [--parent KEY|none] [--body text|-]",
        examples: &["oprojects edit 12 -p highest --due tomorrow", "oprojects edit 12 -a none --add-label blocked"],
        options: &[FIELDS, &[text("title"), text("add-label").multiple(), text("rm-label").multiple()]],
        run: edit,
    },
    Command {
        name: "rm",
        aliases: &["delete", "remove"],
        summary: "Delete a card (moved to the vault .trash, so it is recoverable)",
        usage: "oprojects rm <key>",
        examples: &[],
        options: &[],
        run: remove,
    },
    Command {
        name: "open",
        aliases: &[],
        summary: "Open a card in Obsidian",
        usage: "oprojects open <key> [--print]",
        examples: &[],
        options: &[&[flag("print")]],
        run: open,
    },
    Command {
        name: "config",
        aliases: &[],
        summary: "Show the board configuration in use",
        usage: "oprojects config",
        examples: &[],
        options: &[],
        run: config,
    },
    Command {
        name: "init",
        aliases: &[],
        summary: "Set up the board in this vault (folder + project key)",
        usage: "oprojects init [--prefix OP] [--folder Cards] [--me name] [--force]",
        examples: &[],
        options: &[&[text("prefix"), text("folder"), text("me"), flag("force")]],
        run: init,
    },
];

pub fn find_command(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.name == name || c.aliases.contains(&name))
}

// --- reading the arguments -----------------------------------------------------------------------------------------

fn split_csv(items: &[&str]) -> Vec<String> {
    items
        .iter()
        .flat_map(|item| item.split(','))
        .map(|part| js_trim(part).to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn is_clear(value: &str) -> bool {
    value.is_empty() || value.to_lowercase() == "none"
}

fn read_stdin(ctx: &mut Ctx) -> Result<String, Failure> {
    (ctx.io.read_stdin)().map(|text| text.replace("\r\n", "\n")).map_err(|e| Failure::Other(e.to_string()))
}

fn read_body(ctx: &mut Ctx, value: Option<&str>) -> Result<Option<String>, Failure> {
    match value {
        None => Ok(None),
        Some("-") => read_stdin(ctx).map(Some),
        Some(text) => Ok(Some(text.to_string())),
    }
}

fn parse_estimate(value: &str) -> Result<f64, Error> {
    let n = js_to_number(value);
    if js_trim(value).is_empty() || !n.is_finite() {
        return Err(Error::validation(format!("Invalid estimate \"{value}\" (expected a number)")));
    }
    Ok(n)
}

/// The fields a command line can set on a card, as typed. A type or priority is kept as text: telling that it is wrong is
/// the service's job, and it does so after the checks that come before it, which `bad_choice` imitates.
#[derive(Default)]
struct Fields {
    status: Option<String>,
    card_type: Option<String>,
    priority: Option<String>,
    assignee: Option<Option<String>>,
    due: Option<Option<String>>,
    estimate: Option<Option<f64>>,
    parent: Option<Option<String>>,
    labels: Option<Vec<String>>,
}

fn fields_from_args(ctx: &Ctx, args: &Parsed) -> Result<Fields, Failure> {
    let mut fields = Fields {
        status: args.text("status").map(str::to_string),
        card_type: args.text("type").map(str::to_string),
        priority: args.text("priority").map(str::to_string),
        ..Fields::default()
    };
    if let Some(assignee) = args.text("assignee") {
        fields.assignee = Some(if is_clear(assignee) {
            None
        } else if assignee.to_lowercase() == "me" && !ctx.config.me.is_empty() {
            Some(ctx.config.me.clone())
        } else {
            Some(assignee.to_string())
        });
    }
    if let Some(due) = args.text("due") {
        fields.due = Some(if is_clear(due) { None } else { Some(parse_due(due, ctx.now.local_date)?) });
    }
    if let Some(estimate) = args.text("estimate") {
        fields.estimate = Some(if is_clear(estimate) { None } else { Some(parse_estimate(estimate)?) });
    }
    if let Some(parent) = args.text("parent") {
        fields.parent = Some(if is_clear(parent) { None } else { Some(parent.to_string()) });
    }
    let given = args.list("label");
    if !given.is_empty() {
        let labels = split_csv(&given);
        fields.labels = Some(if labels.len() == 1 && is_clear(&labels[0]) { Vec::new() } else { labels });
    }
    Ok(fields)
}

fn names<T: Copy>(all: &[T], name: fn(T) -> &'static str) -> String {
    all.iter().map(|item| name(*item)).collect::<Vec<_>>().join(", ")
}

fn invalid_type(value: &str) -> Error {
    Error::validation(format!("Invalid type \"{value}\" ({})", names(&CARD_TYPES, CardType::as_str)))
}

fn invalid_priority(value: &str) -> Error {
    Error::validation(format!("Invalid priority \"{value}\" ({})", names(&PRIORITIES, Priority::as_str)))
}

/// The complaint about a type or a priority that is not one, if there is one. The type comes first.
fn bad_choice(card_type: Option<&str>, priority: Option<&str>) -> Option<Error> {
    if let Some(value) = card_type.filter(|v| CardType::parse(v).is_none()) {
        return Some(invalid_type(value));
    }
    priority.filter(|v| Priority::parse(v).is_none()).map(invalid_priority)
}

fn card_value(card: &Card) -> Value {
    serde_json::to_value(card).expect("a card is always JSON")
}

/// Lists stay small: no description or comment texts, just how many comments there are.
fn without_body(card: &Card) -> Value {
    let mut fields = match card_value(card) {
        Value::Object(fields) => fields,
        other => return other,
    };
    fields.remove("body");
    fields.remove("comments");
    fields.insert("commentCount".into(), card.comments.len().into());
    Value::Object(fields)
}

fn select_cards(ctx: &Ctx, args: &Parsed) -> Result<Vec<Arc<Card>>, Failure> {
    let raw_types = split_csv(&args.list("type"));
    let raw_priorities = split_csv(&args.list("priority"));
    let mut assignee = split_csv(&args.list("assignee"));
    if args.flag("mine") {
        if ctx.config.me.is_empty() {
            return usage(
                "--mine needs \"me\" in the board settings (Obsidian: Settings → Projects → My name, or `me` in data.json)",
            );
        }
        assignee.push("me".to_string());
    }
    let query = CardQuery {
        text: args.text("query").filter(|q| !q.is_empty()).map(str::to_string),
        status: args.list("status").into_iter().map(str::to_string).collect(),
        card_type: raw_types.iter().filter_map(|t| CardType::parse(t)).collect(),
        priority: raw_priorities.iter().filter_map(|p| Priority::parse(p)).collect(),
        assignee,
        labels: split_csv(&args.list("label")),
        parent: args.text("parent").filter(|p| !p.is_empty()).map(str::to_string),
        include_archived: args.flag("all"),
    };
    let cards = ctx.svc.find(&query)?;
    // The service looks at the types and priorities after the columns, the parent and the assignees: so does this.
    if let Some(value) = raw_types.iter().find(|t| CardType::parse(t).is_none()) {
        return Err(invalid_type(value).into());
    }
    if let Some(value) = raw_priorities.iter().find(|p| Priority::parse(p).is_none()) {
        return Err(invalid_priority(value).into());
    }
    Ok(cards)
}

fn first_positional<'a>(args: &'a Parsed, missing: &str) -> Result<&'a str, Failure> {
    match args.positionals.first().map(String::as_str).filter(|k| !k.is_empty()) {
        Some(key) => Ok(key),
        None => usage(missing),
    }
}

// --- the commands --------------------------------------------------------------------------------------------------

fn add(ctx: &mut Ctx, args: &Parsed) -> CmdResult {
    let title = js_trim(&args.positionals.join(" ")).to_string();
    if title.is_empty() {
        return usage("Missing title. Usage: oprojects add <title…>");
    }
    let fields = fields_from_args(ctx, args)?;
    let body = read_body(ctx, args.text("body"))?;
    if let Some(error) = bad_choice(fields.card_type.as_deref(), fields.priority.as_deref()) {
        clean_title(&title)?;
        if let Some(status) = &fields.status {
            ctx.svc.check_status(status)?;
        }
        return Err(error.into());
    }
    let input = NewCardInput {
        title,
        status: fields.status,
        card_type: fields.card_type.as_deref().and_then(CardType::parse),
        priority: fields.priority.as_deref().and_then(Priority::parse),
        assignee: fields.assignee.flatten(),
        labels: fields.labels,
        due: fields.due.flatten(),
        estimate: fields.estimate.flatten(),
        parent: fields.parent.flatten(),
        body,
        rank: None,
    };
    let card = ctx.svc.create(input)?;
    if ctx.json {
        ctx.emit(&card_value(&card));
        return Ok(());
    }
    let text = format!(
        "{} {}  {}\n{}\n",
        ctx.paint.paint(Style::Green, "Created"),
        ctx.paint.paint(Style::Bold, &card.key),
        card.title,
        ctx.paint.paint(Style::Gray, &card.path)
    );
    ctx.out(&text);
    Ok(())
}

fn list(ctx: &mut Ctx, args: &Parsed) -> CmdResult {
    let cards = select_cards(ctx, args)?;
    if ctx.json {
        let items: Vec<Value> = cards.iter().map(|c| without_body(c)).collect();
        ctx.emit(&Value::Array(items));
        return Ok(());
    }
    let table = render_table(&cards, &ctx.config, ctx.paint, ctx.io.columns, &ctx.now);
    ctx.out(&(table + "\n"));
    Ok(())
}

fn board(ctx: &mut Ctx, args: &Parsed) -> CmdResult {
    let cards: Vec<Arc<Card>> =
        select_cards(ctx, args)?.into_iter().filter(|c| args.flag("epics") || c.card_type != CardType::Epic).collect();
    if ctx.json {
        let groups: Vec<Value> = group_by_column(&cards, &ctx.config)
            .into_iter()
            .map(|group| {
                let mut fields = Map::new();
                fields.insert("column".into(), group.column.id.clone().into());
                fields.insert("name".into(), group.column.name.clone().into());
                fields.insert("done".into(), group.column.done.into());
                if let Some(wip) = group.column.wip {
                    fields.insert("wip".into(), wip.into());
                }
                fields.insert("cards".into(), Value::Array(group.cards.iter().map(|c| without_body(c)).collect()));
                Value::Object(fields)
            })
            .collect();
        ctx.emit(&Value::Array(groups));
        return Ok(());
    }
    let drawn = render_board(&cards, &ctx.config, ctx.paint, ctx.io.columns, &ctx.now);
    ctx.out(&(drawn + "\n"));
    Ok(())
}

fn show(ctx: &mut Ctx, args: &Parsed) -> CmdResult {
    let key = first_positional(args, "Missing card key. Usage: oprojects show <key>")?;
    let card = ctx.svc.get(key)?;
    if ctx.json {
        ctx.emit(&card_value(&card));
        return Ok(());
    }
    let drawn = render_card(&card, &ctx.config, ctx.paint, &ctx.now, ctx.io.utc_offset_minutes);
    ctx.out(&(drawn + "\n"));
    Ok(())
}

fn comment(ctx: &mut Ctx, args: &Parsed) -> CmdResult {
    let key = first_positional(args, "Missing card key. Usage: oprojects comment <key> <text…>")?;
    let words = &args.positionals[1..];
    // An empty id is as good as none: only a non-empty one selects editing or removing.
    let edit_id = args.text("edit").filter(|id| !id.is_empty());
    let rm_id = args.text("rm").filter(|id| !id.is_empty());
    if edit_id.is_some() && rm_id.is_some() {
        return usage("Use either --edit or --rm, not both");
    }
    let paint = ctx.paint;
    let (card, message) = if let Some(id) = rm_id {
        if !words.is_empty() {
            return usage("--rm takes no text");
        }
        let card = ctx.svc.remove_comment(key, id)?;
        let message = format!(
            "{} comment {} from {}",
            paint.paint(Style::Yellow, "Removed"),
            paint.paint(Style::Gray, &format!("#{id}")),
            paint.paint(Style::Bold, &card.key)
        );
        (card, message)
    } else {
        let joined = words.join(" ");
        let text = if joined == "-" { read_stdin(ctx)? } else { joined };
        if js_trim(&text).is_empty() {
            return usage("Missing comment text. Usage: oprojects comment <key> <text…>  (use - to read stdin)");
        }
        if let Some(id) = edit_id {
            let card = ctx.svc.edit_comment(key, id, &text)?;
            let message = format!(
                "{} comment {} on {}",
                paint.paint(Style::Green, "Edited"),
                paint.paint(Style::Gray, &format!("#{id}")),
                paint.paint(Style::Bold, &card.key)
            );
            (card, message)
        } else {
            let author = args
                .text("author")
                .filter(|a| !a.is_empty())
                .map(str::to_string)
                .or_else(|| Some(ctx.config.me.clone()).filter(|me| !me.is_empty()))
                .or_else(|| (ctx.io.env)("USER").filter(|u| !u.is_empty()))
                .or_else(|| (ctx.io.env)("LOGNAME"));
            let card = ctx.svc.add_comment(key, CommentInput { text, author })?;
            let id = card.comments.last().map(|c| c.id.clone()).unwrap_or_default();
            let message = format!(
                "{} on {} {}",
                paint.paint(Style::Green, "Commented"),
                paint.paint(Style::Bold, &card.key),
                paint.paint(Style::Gray, &format!("#{id}"))
            );
            (card, message)
        }
    };
    if ctx.json {
        ctx.emit(&card_value(&card));
        return Ok(());
    }
    ctx.out(&(message + "\n"));
    Ok(())
}

fn move_card(ctx: &mut Ctx, args: &Parsed) -> CmdResult {
    let (Some(key), Some(status)) = (args.positionals.first(), args.positionals.get(1)) else {
        return usage("Usage: oprojects move <key> <status> [--before KEY | --after KEY]");
    };
    if key.is_empty() || status.is_empty() {
        return usage("Usage: oprojects move <key> <status> [--before KEY | --after KEY]");
    }
    let before = args.text("before").filter(|b| !b.is_empty());
    let after = args.text("after").filter(|a| !a.is_empty());
    if before.is_some() && after.is_some() {
        return usage("Use either --before or --after, not both");
    }
    let placement = Placement {
        before: before.map(|b| ctx.svc.resolve_key(b)).transpose()?,
        after: after.map(|a| ctx.svc.resolve_key(a)).transpose()?,
    };
    let card = ctx.svc.move_card(key, status, placement)?;
    if ctx.json {
        ctx.emit(&card_value(&card));
        return Ok(());
    }
    let column = crate::config::display_column(&ctx.config, &card.status).name.clone();
    let text = format!("{} → {}\n", ctx.paint.paint(Style::Bold, &card.key), ctx.paint.paint(Style::Cyan, &column));
    ctx.out(&text);
    Ok(())
}

fn edit(ctx: &mut Ctx, args: &Parsed) -> CmdResult {
    let key = first_positional(args, "Missing card key. Usage: oprojects edit <key> [options]")?;
    let fields = fields_from_args(ctx, args)?;
    let mut touched = fields.status.is_some()
        || fields.card_type.is_some()
        || fields.priority.is_some()
        || fields.assignee.is_some()
        || fields.due.is_some()
        || fields.estimate.is_some()
        || fields.parent.is_some()
        || fields.labels.is_some();
    let title = args.text("title").map(str::to_string);
    touched |= title.is_some();
    let body = read_body(ctx, args.text("body"))?.map(|b| if b.ends_with('\n') || b.is_empty() { b } else { b + "\n" });
    touched |= body.is_some();
    let add = split_csv(&args.list("add-label"));
    let remove = split_csv(&args.list("rm-label"));
    let mut labels = fields.labels.clone();
    if !add.is_empty() || !remove.is_empty() {
        let current = match labels.take() {
            Some(labels) => labels,
            None => ctx.svc.get(key)?.labels,
        };
        let removed: Vec<String> = remove.iter().map(|l| l.to_lowercase()).collect();
        labels = Some(current.into_iter().chain(add).filter(|l| !removed.contains(&l.to_lowercase())).collect());
        touched = true;
    }
    if !touched {
        return usage("Nothing to change. Pass at least one option, e.g. --priority high");
    }
    if let Some(error) = bad_choice(fields.card_type.as_deref(), fields.priority.as_deref()) {
        ctx.svc.get(key)?;
        if let Some(title) = &title {
            clean_title(title)?;
        }
        return Err(error.into());
    }
    let patch = CardPatch {
        title,
        status: fields.status,
        card_type: fields.card_type.as_deref().and_then(CardType::parse),
        priority: fields.priority.as_deref().and_then(Priority::parse),
        assignee: fields.assignee,
        labels,
        due: fields.due,
        estimate: fields.estimate,
        parent: fields.parent,
        rank: None,
        body,
    };
    let card = ctx.svc.update(key, patch)?;
    if ctx.json {
        ctx.emit(&card_value(&card));
        return Ok(());
    }
    let text = format!(
        "{} {}  {}\n",
        ctx.paint.paint(Style::Green, "Updated"),
        ctx.paint.paint(Style::Bold, &card.key),
        card.title
    );
    ctx.out(&text);
    Ok(())
}

fn remove(ctx: &mut Ctx, args: &Parsed) -> CmdResult {
    let key = first_positional(args, "Missing card key. Usage: oprojects rm <key>")?;
    let card = ctx.svc.remove(key)?;
    if ctx.json {
        ctx.emit(&without_body(&card));
        return Ok(());
    }
    let text = format!(
        "{} {}  {} {}\n",
        ctx.paint.paint(Style::Yellow, "Deleted"),
        ctx.paint.paint(Style::Bold, &card.key),
        card.title,
        ctx.paint.paint(Style::Gray, "(in .trash)")
    );
    ctx.out(&text);
    Ok(())
}

/// `encodeURIComponent`: everything but letters, digits and `-_.!~*'()` as UTF-8 percent escapes.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn open(ctx: &mut Ctx, args: &Parsed) -> CmdResult {
    let key = first_positional(args, "Missing card key. Usage: oprojects open <key>")?;
    let card = ctx.svc.get(key)?;
    let vault = ctx.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let file = card.path.strip_suffix(".md").unwrap_or(&card.path);
    let url = format!("obsidian://open?vault={}&file={}", encode_uri_component(&vault), encode_uri_component(file));
    if args.flag("print") {
        ctx.out(&(url + "\n"));
        return Ok(());
    }
    (ctx.io.open_url)(&url).map_err(|e| Failure::Other(e.to_string()))?;
    let text = format!("Opening {} in Obsidian…\n", ctx.paint.paint(Style::Bold, &card.key));
    ctx.out(&text);
    Ok(())
}

fn config(ctx: &mut Ctx, _args: &Parsed) -> CmdResult {
    if ctx.json {
        let mut fields = Map::new();
        fields.insert("vault".into(), ctx.root.to_string_lossy().into_owned().into());
        if let Value::Object(config) = serde_json::to_value(&ctx.config).expect("a board config is always JSON") {
            fields.extend(config);
        }
        ctx.emit(&Value::Object(fields));
        return Ok(());
    }
    let paint = ctx.paint;
    let c = &ctx.config;
    let columns: Vec<String> = c
        .columns
        .iter()
        .map(|col| {
            let done = if col.done { "✓" } else { "" };
            let wip = col.wip.filter(|w| *w > 0).map(|w| format!("(wip {w})")).unwrap_or_default();
            format!("{}{done}{wip}", col.id)
        })
        .collect();
    let me = if c.me.is_empty() { paint.paint(Style::Gray, "(not set)") } else { c.me.clone() };
    let lines = [
        format!("{} {}", paint.paint(Style::Gray, "vault   "), ctx.root.display()),
        format!("{} {}", paint.paint(Style::Gray, "folder  "), c.folder),
        format!("{} {}", paint.paint(Style::Gray, "prefix  "), c.prefix),
        format!("{} {me}", paint.paint(Style::Gray, "me      ")),
        format!("{} {}", paint.paint(Style::Gray, "columns "), columns.join(" → ")),
    ];
    let text = lines.join("\n") + "\n";
    ctx.out(&text);
    Ok(())
}

fn init(ctx: &mut Ctx, args: &Parsed) -> CmdResult {
    let exists = has_board_config(&ctx.root);
    let prefix = args.text("prefix").map(str::to_uppercase);
    let folder = args.text("folder");
    let me = args.text("me");
    if let Some(prefix) = &prefix
        && !is_valid_prefix(prefix)
    {
        return usage(format!("Invalid prefix \"{prefix}\" (2–10 chars, A–Z and digits, starting with a letter)"));
    }
    let changes_key = prefix.as_deref().is_some_and(|p| !p.is_empty()) || folder.is_some_and(|f| !f.is_empty());
    if exists && changes_key && !args.flag("force") {
        return usage(
            "This vault already has a board. Changing prefix/folder would orphan existing cards; pass --force if you really mean it.",
        );
    }
    let mut raw = match serde_json::to_value(&ctx.config).expect("a board config is always JSON") {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    if let Some(prefix) = prefix.as_deref().filter(|p| !p.is_empty()) {
        raw.insert("prefix".into(), prefix.into());
    }
    if let Some(folder) = folder {
        let normalized = normalize_folder(folder);
        raw.insert(
            "folder".into(),
            if normalized.is_empty() { BoardConfig::default().folder.into() } else { normalized.into() },
        );
    }
    if let Some(me) = me {
        raw.insert("me".into(), me.into());
    }
    let config = normalize_config(&Value::Object(raw));
    if exists && prefix.is_none() && folder.is_none() && me.is_none() {
        let text = format!(
            "Board already set up ({} in {}/). Nothing to do.\n",
            ctx.paint.paint(Style::Bold, &config.prefix),
            config.folder
        );
        ctx.out(&text);
        return Ok(());
    }
    save_board_config(&ctx.root, &config)?;
    let _ = FsStorage::new(&ctx.root).create(&format!("{}/.keep", config.folder), "");
    let paint = ctx.paint;
    let text = format!(
        "{}: cards are {} notes in {}\nNext: {}  then  {}\n",
        paint.paint(Style::Green, "Board ready"),
        paint.paint(Style::Bold, &format!("{}-<n>", config.prefix)),
        paint.paint(Style::Bold, &format!("{}/", config.folder)),
        paint.paint(Style::Cyan, "oprojects add \"My first card\""),
        paint.paint(Style::Cyan, "oprojects board"),
    );
    ctx.out(&text);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_components_are_escaped_like_javascript() {
        assert_eq!(encode_uri_component("My Vault"), "My%20Vault");
        assert_eq!(encode_uri_component("Cards/OP-1"), "Cards%2FOP-1");
        assert_eq!(encode_uri_component("a&b=c?d#e"), "a%26b%3Dc%3Fd%23e");
        assert_eq!(encode_uri_component("ünï 🚀"), "%C3%BCn%C3%AF%20%F0%9F%9A%80");
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
    }

    #[test]
    fn csv_values_are_split_trimmed_and_emptied() {
        assert_eq!(split_csv(&["a, b ,,c", "", " d"]), ["a", "b", "c", "d"]);
        assert!(split_csv(&[",", " "]).is_empty());
    }

    #[test]
    fn clearing_words() {
        assert!(is_clear("") && is_clear("none") && is_clear("NONE") && is_clear("None"));
        assert!(!is_clear(" none") && !is_clear("nope"));
    }

    #[test]
    fn estimates_are_read_like_javascript_numbers() {
        assert_eq!(parse_estimate(" 5 ").unwrap(), 5.0);
        assert_eq!(parse_estimate("0x10").unwrap(), 16.0);
        for bad in ["abc", "", " ", "Infinity", "1e999", "NaN"] {
            assert_eq!(
                parse_estimate(bad).unwrap_err().to_string(),
                format!("Invalid estimate \"{bad}\" (expected a number)")
            );
        }
    }
}
