//! The command line, parsed by hand: a flag parser pulled in for six flags would cost more binary size and memory than
//! it saves, and this server exists to be small.
//!
//! ```text
//! oprojects-mcp [--vault <path>] [--read-only] [--author <name>] [--updates watch|channel|off]
//! oprojects-mcp --http [--port <n>] [--token <secret> | --token-file <path>] [--vault <path>] [--read-only] [--author <name>]
//! oprojects-mcp watch <key>... [--vault <path>] [--author <name>] [--settle <seconds>]
//! ```
//!
//! Each setting can also come from the environment (`OPROJECTS_VAULT`, `OPROJECTS_AUTHOR`, and for HTTP
//! `OPROJECTS_MCP_TOKEN`); a flag wins over the environment, which wins over the default. A repeated flag takes its
//! last value. The HTTP flags are an error without `--http`: silently ignoring `--port` would leave the user talking to
//! the wrong kind of server.

use std::path::PathBuf;

use std::time::Duration;

use crate::http::DEFAULT_PORT;
use crate::token;
use crate::watch::{SETTLE, WatchArgs};

/// What the user asked the program to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Serve the vault over MCP on stdin and stdout.
    Run(Options),
    /// Serve the vault over MCP on a local HTTP port.
    Http { options: Options, http: HttpArgs },
    /// Follow cards and print what happens to them, until each is done.
    Watch(WatchArgs),
    /// Print the usage and exit.
    Help,
    /// Print the version and exit.
    Version,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// The vault given by `--vault` or `$OPROJECTS_VAULT`; `None` means the nearest vault above the current folder.
    pub vault: Option<String>,
    /// Offer only the tools that read.
    pub read_only: bool,
    /// Who the comments the agent adds are signed by, when the call does not say.
    pub author: String,
    /// How the agent hears about the cards it takes.
    pub updates: UpdatesMode,
}

/// `--updates`: how the agent hears about the cards it takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdatesMode {
    /// The result of the write that takes a card says how to follow it with the `Monitor` tool and `oprojects-mcp watch`.
    Watch,
    /// The server follows the card and pushes the updates to the session (Claude Code's channels).
    Channel,
    /// Nothing.
    Off,
}

/// What `--http` adds to the command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpArgs {
    /// The port; 0 asks the operating system for a free one.
    pub port: u16,
    /// A token given by `--token` or `$OPROJECTS_MCP_TOKEN`, already checked.
    pub token: Option<String>,
    /// The file that holds the token, given by `--token-file`.
    pub token_file: Option<PathBuf>,
}

/// The author used when neither `--author` nor `$OPROJECTS_AUTHOR` is given.
pub const DEFAULT_AUTHOR: &str = "Agent";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArgsError {
    #[error("{0} needs a value")]
    MissingValue(String),
    #[error("unknown option \"{0}\"")]
    UnknownOption(String),
    #[error("unexpected argument \"{0}\" (this server takes only options)")]
    UnexpectedArgument(String),
    #[error("{flag}: {message}")]
    InvalidValue { flag: String, message: String },
    #[error("{0} only applies with --http")]
    HttpOnly(String),
    #[error("--token and --token-file cannot be used together: the token is either given or kept in a file")]
    TokenAndFile,
    #[error("--updates channel needs stdin and stdout: a server shared over HTTP has no session to send updates to")]
    ChannelNeedsStdio,
    #[error("watch needs at least one card key (OP-12, or just 12)")]
    WatchNeedsKey,
}

/// A `--flag value` or `--flag=value` option. `None` when `arg` is not this flag; the value is taken from the next
/// argument when it is not given inline, and must not be empty.
fn value_of(arg: &str, flag: &str, rest: &mut impl Iterator<Item = String>) -> Option<Result<String, ArgsError>> {
    let inline = arg.strip_prefix(flag).and_then(|tail| tail.strip_prefix('='));
    let value = match inline {
        Some(value) => Some(value.to_string()),
        None if arg == flag => rest.next(),
        None => return None,
    };
    Some(match value {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(ArgsError::MissingValue(flag.to_string())),
    })
}

/// Parses the arguments after the program name. `env` looks an environment variable up (a closure in tests).
pub fn parse(
    args: impl IntoIterator<Item = String>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Command, ArgsError> {
    let non_empty = |name: &str| env(name).filter(|v| !v.is_empty());
    let mut rest = args.into_iter().peekable();
    if rest.next_if(|first| first == "watch").is_some() {
        return parse_watch(rest, env);
    }
    let mut vault = None;
    let mut author = None;
    let mut updates: Option<String> = None;
    let mut read_only = false;
    let mut http = false;
    let mut port: Option<String> = None;
    let mut token_flag: Option<String> = None;
    let mut token_file: Option<String> = None;

    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(Command::Help),
            "-V" | "--version" => return Ok(Command::Version),
            "--read-only" => read_only = true,
            "--http" => http = true,
            _ => {
                if let Some(value) = value_of(&arg, "--vault", &mut rest) {
                    vault = Some(value?);
                } else if let Some(value) = value_of(&arg, "--author", &mut rest) {
                    author = Some(value?);
                } else if let Some(value) = value_of(&arg, "--updates", &mut rest) {
                    updates = Some(value?);
                } else if let Some(value) = value_of(&arg, "--port", &mut rest) {
                    port = Some(value?);
                } else if let Some(value) = value_of(&arg, "--token", &mut rest) {
                    token_flag = Some(value?);
                } else if let Some(value) = value_of(&arg, "--token-file", &mut rest) {
                    token_file = Some(value?);
                } else if arg.starts_with('-') {
                    return Err(ArgsError::UnknownOption(arg));
                } else {
                    return Err(ArgsError::UnexpectedArgument(arg));
                }
            }
        }
    }

    let updates = match updates.as_deref() {
        None | Some("watch") => UpdatesMode::Watch,
        Some("channel") => UpdatesMode::Channel,
        Some("off") => UpdatesMode::Off,
        Some(other) => {
            return Err(ArgsError::InvalidValue {
                flag: "--updates".into(),
                message: format!("\"{other}\" is not a mode: use watch, channel or off"),
            });
        }
    };
    if http && updates == UpdatesMode::Channel {
        return Err(ArgsError::ChannelNeedsStdio);
    }
    let options = Options {
        vault: vault.or_else(|| non_empty("OPROJECTS_VAULT")),
        read_only,
        author: author.or_else(|| non_empty("OPROJECTS_AUTHOR")).unwrap_or_else(|| DEFAULT_AUTHOR.to_string()),
        updates,
    };

    if !http {
        for (flag, given) in
            [("--port", port.is_some()), ("--token", token_flag.is_some()), ("--token-file", token_file.is_some())]
        {
            if given {
                return Err(ArgsError::HttpOnly(flag.to_string()));
            }
        }
        return Ok(Command::Run(options));
    }

    let port = match port {
        None => DEFAULT_PORT,
        Some(text) => text.parse::<u16>().map_err(|_| ArgsError::InvalidValue {
            flag: "--port".into(),
            message: format!("\"{text}\" is not a port: use a number from 0 to 65535 (0 picks a free one)"),
        })?,
    };
    if token_flag.is_some() && token_file.is_some() {
        return Err(ArgsError::TokenAndFile);
    }
    // The flag wins over the environment; a token file wins over the environment too (it was asked for explicitly).
    let token = match (&token_flag, &token_file) {
        (Some(secret), _) => Some((secret.clone(), "--token")),
        (None, Some(_)) => None,
        (None, None) => non_empty("OPROJECTS_MCP_TOKEN").map(|secret| (secret, "$OPROJECTS_MCP_TOKEN")),
    };
    if let Some((secret, origin)) = &token {
        token::validate(secret)
            .map_err(|e| ArgsError::InvalidValue { flag: (*origin).to_string(), message: e.to_string() })?;
    }
    Ok(Command::Http {
        options,
        http: HttpArgs { port, token: token.map(|(secret, _)| secret), token_file: token_file.map(PathBuf::from) },
    })
}

/// The arguments of `watch`, after the word itself.
fn parse_watch(
    mut rest: impl Iterator<Item = String>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Command, ArgsError> {
    let non_empty = |name: &str| env(name).filter(|v| !v.is_empty());
    let (mut vault, mut author, mut settle) = (None, None, None::<String>);
    let mut keys = Vec::new();
    while let Some(arg) = rest.next() {
        if arg == "-h" || arg == "--help" {
            return Ok(Command::Help);
        } else if let Some(value) = value_of(&arg, "--vault", &mut rest) {
            vault = Some(value?);
        } else if let Some(value) = value_of(&arg, "--author", &mut rest) {
            author = Some(value?);
        } else if let Some(value) = value_of(&arg, "--settle", &mut rest) {
            settle = Some(value?);
        } else if arg.starts_with('-') {
            return Err(ArgsError::UnknownOption(arg));
        } else {
            keys.push(arg);
        }
    }
    if keys.is_empty() {
        return Err(ArgsError::WatchNeedsKey);
    }
    let settle = match settle {
        None => SETTLE,
        Some(text) => match text.parse::<f64>() {
            Ok(seconds) if seconds > 0.0 && seconds <= 3600.0 => Duration::from_secs_f64(seconds),
            _ => {
                return Err(ArgsError::InvalidValue {
                    flag: "--settle".into(),
                    message: format!("\"{text}\" is not a number of seconds from 0 to 3600 (for example 3 or 0.5)"),
                });
            }
        },
    };
    Ok(Command::Watch(WatchArgs {
        keys,
        vault: vault.or_else(|| non_empty("OPROJECTS_VAULT")),
        author: author.or_else(|| non_empty("OPROJECTS_AUTHOR")).unwrap_or_else(|| DEFAULT_AUTHOR.to_string()),
        settle,
    }))
}

/// The text of `--help`.
pub fn usage(version: &str) -> String {
    format!(
        "oprojects-mcp {version}: an MCP server for the cards of an Obsidian vault (Obsidian Projects)

Usage: oprojects-mcp [--vault <path>] [--read-only] [--author <name>] [--updates <mode>]
       oprojects-mcp --http [--port <n>] [--token <secret> | --token-file <path>] [--vault <path>] ...
       oprojects-mcp watch <key>... [--vault <path>] [--author <name>] [--settle <seconds>]

Options:
  --vault <path>   The vault to serve. Default: $OPROJECTS_VAULT, else the nearest folder
                   above the current one that has an .obsidian folder.
  --read-only      Offer only the tools that read: the agent cannot change anything.
  --author <name>  Who the comments added by the agent are signed by when the call does not
                   say. Default: $OPROJECTS_AUTHOR, else \"{DEFAULT_AUTHOR}\".
  --updates <mode> How the agent hears about the cards it takes (moving one out of the first
                   column, or assigning it to the agent): watch (default) tells it, in the result
                   of that write, to follow the card with the Monitor tool and `watch`; channel
                   follows the card inside the server and pushes updates to Claude Code as
                   channel messages (stdin/stdout only; Claude Code must be allowed to listen,
                   see the README); off does neither.
  --http           Serve over HTTP on this machine (127.0.0.1 only, there is no --host) instead of
                   stdin and stdout, so one server can be shared by several clients.
  --port <n>       With --http: the port. Default: {DEFAULT_PORT}. 0 picks a free one and prints it.
  --token <secret> With --http: the bearer token clients must send (at least 16 visible
                   characters). Default: $OPROJECTS_MCP_TOKEN. Prefer the variable or a file: a
                   command line can be read by other users' tools.
  --token-file <path>
                   With --http: keep the token in this file. It is created (readable by you only)
                   with a random token the first time, and reused after that.
  -V, --version    Print the version.
  -h, --help       Print this help.

With --http and no token at all, a random one is generated, printed once on stderr, and good
for that run only.

watch follows cards and prints one line on stdout for each thing that happens to them (a comment, a
change, done), which is what the Monitor tool of Claude Code turns into notifications, and exits when
every card is done. Comments signed by --author (default: $OPROJECTS_AUTHOR, else \"{DEFAULT_AUTHOR}\") are the
agent's own and are not reported. A change is reported after the note has stayed the same for
--settle seconds (default 3), so typing in the Obsidian editor is one line, not forty.

The server speaks the Model Context Protocol over stdin and stdout, so it is meant to be
started by an MCP client, not run by hand. To add it to Claude Code:

  claude mcp add obsidian-projects -- oprojects-mcp --vault /path/to/your/vault

For one shared server over HTTP (the exact command is printed when it starts):

  oprojects-mcp --http --token-file ~/.config/oprojects-mcp.token --vault /path/to/your/vault
  claude mcp add --transport http obsidian-projects http://127.0.0.1:{DEFAULT_PORT}/mcp \\
    --header \"Authorization: Bearer $(cat ~/.config/oprojects-mcp.token)\"

For a client that reads a JSON config (Claude Desktop, Cursor):

  {{ \"mcpServers\": {{ \"obsidian-projects\": {{
      \"command\": \"oprojects-mcp\", \"args\": [\"--vault\", \"/path/to/your/vault\"] }} }} }}
"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn run(args: &[&str]) -> Result<Command, ArgsError> {
        parse(args.iter().map(|a| a.to_string()), &no_env)
    }

    fn run_with_env(args: &[&str], vars: &[(&str, &str)]) -> Result<Command, ArgsError> {
        let env = |name: &str| vars.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string());
        parse(args.iter().map(|a| a.to_string()), &env)
    }

    fn options(args: &[&str]) -> Options {
        match run(args).unwrap() {
            Command::Run(o) => o,
            other => panic!("expected to run, got {other:?}"),
        }
    }

    #[test]
    fn no_arguments_serve_the_nearest_vault_with_everything_enabled() {
        assert_eq!(
            options(&[]),
            Options { vault: None, read_only: false, author: "Agent".into(), updates: UpdatesMode::Watch }
        );
    }

    #[test]
    fn every_flag_in_both_spellings() {
        let o = options(&["--vault", "/v", "--read-only", "--author", "Claude"]);
        assert_eq!(
            o,
            Options { vault: Some("/v".into()), read_only: true, author: "Claude".into(), updates: UpdatesMode::Watch }
        );
        let o = options(&["--vault=/other", "--author=Cursor"]);
        assert_eq!(
            o,
            Options {
                vault: Some("/other".into()),
                read_only: false,
                author: "Cursor".into(),
                updates: UpdatesMode::Watch
            }
        );
    }

    #[test]
    fn the_order_of_the_flags_does_not_matter_and_the_last_value_wins() {
        let o = options(&["--author", "A", "--read-only", "--vault", "/one", "--vault=/two", "--author", "B"]);
        assert_eq!(o.vault.as_deref(), Some("/two"));
        assert_eq!(o.author, "B");
        assert!(o.read_only);
    }

    #[test]
    fn values_may_look_like_flags_or_contain_spaces_and_equals_signs() {
        assert_eq!(options(&["--author", "--read-only"]).author, "--read-only");
        assert_eq!(options(&["--author=Ana Maria"]).author, "Ana Maria");
        assert_eq!(options(&["--vault=/a=b/c"]).vault.as_deref(), Some("/a=b/c"));
    }

    #[test]
    fn the_environment_fills_in_what_the_flags_leave_out() {
        let env = [("OPROJECTS_VAULT", "/from-env"), ("OPROJECTS_AUTHOR", "EnvBot")];
        let Command::Run(o) = run_with_env(&[], &env).unwrap() else { panic!("expected to run") };
        assert_eq!((o.vault.as_deref(), o.author.as_str()), (Some("/from-env"), "EnvBot"));
    }

    #[test]
    fn flags_beat_the_environment_and_empty_variables_count_as_unset() {
        let env = [("OPROJECTS_VAULT", "/from-env"), ("OPROJECTS_AUTHOR", "EnvBot")];
        let Command::Run(o) = run_with_env(&["--vault", "/flag", "--author", "FlagBot"], &env).unwrap() else {
            panic!("expected to run")
        };
        assert_eq!((o.vault.as_deref(), o.author.as_str()), (Some("/flag"), "FlagBot"));

        let empty = [("OPROJECTS_VAULT", ""), ("OPROJECTS_AUTHOR", "")];
        let Command::Run(o) = run_with_env(&[], &empty).unwrap() else { panic!("expected to run") };
        assert_eq!((o.vault, o.author.as_str()), (None, "Agent"));
    }

    #[test]
    fn help_and_version_win_and_stop_the_parsing() {
        assert_eq!(run(&["--help"]), Ok(Command::Help));
        assert_eq!(run(&["-h"]), Ok(Command::Help));
        assert_eq!(run(&["--version"]), Ok(Command::Version));
        assert_eq!(run(&["-V"]), Ok(Command::Version));
        assert_eq!(run(&["--read-only", "--help", "--bogus"]), Ok(Command::Help));
    }

    #[test]
    fn a_flag_without_its_value_is_an_error_that_names_the_flag() {
        assert_eq!(run(&["--vault"]), Err(ArgsError::MissingValue("--vault".into())));
        assert_eq!(run(&["--author"]), Err(ArgsError::MissingValue("--author".into())));
        assert_eq!(run(&["--vault="]), Err(ArgsError::MissingValue("--vault".into())));
        assert_eq!(run(&["--author", ""]), Err(ArgsError::MissingValue("--author".into())));
        assert_eq!(ArgsError::MissingValue("--vault".into()).to_string(), "--vault needs a value");
    }

    #[test]
    fn unknown_options_and_stray_words_are_rejected_not_ignored() {
        assert_eq!(run(&["--bogus"]), Err(ArgsError::UnknownOption("--bogus".into())));
        assert_eq!(run(&["--read-only=yes"]), Err(ArgsError::UnknownOption("--read-only=yes".into())));
        assert_eq!(run(&["--vaults", "x"]), Err(ArgsError::UnknownOption("--vaults".into())));
        assert_eq!(run(&["-x"]), Err(ArgsError::UnknownOption("-x".into())));
        assert_eq!(run(&["somewhere"]), Err(ArgsError::UnexpectedArgument("somewhere".into())));
        assert_eq!(run(&["--vault", "/v", "extra"]), Err(ArgsError::UnexpectedArgument("extra".into())));
    }

    // --- HTTP ---------------------------------------------------------------------------------------------------

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn http(args: &[&str]) -> (Options, HttpArgs) {
        http_with_env(args, &[])
    }

    fn http_with_env(args: &[&str], vars: &[(&str, &str)]) -> (Options, HttpArgs) {
        match run_with_env(args, vars).unwrap() {
            Command::Http { options, http } => (options, http),
            other => panic!("expected the HTTP server, got {other:?}"),
        }
    }

    #[test]
    fn http_alone_serves_on_the_default_port_with_no_token_given() {
        let (options, http) = http(&["--http"]);
        assert_eq!(
            options,
            Options { vault: None, read_only: false, author: "Agent".into(), updates: UpdatesMode::Watch }
        );
        assert_eq!(http, HttpArgs { port: 8765, token: None, token_file: None });
    }

    #[test]
    fn every_http_flag_in_both_spellings() {
        let (_, h) = http(&["--http", "--port", "9000", "--token", TOKEN]);
        assert_eq!(h, HttpArgs { port: 9000, token: Some(TOKEN.into()), token_file: None });
        let (_, h) = http(&["--http", "--port=0", "--token-file=/tmp/t"]);
        assert_eq!(h, HttpArgs { port: 0, token: None, token_file: Some("/tmp/t".into()) });
        let (_, h) = http(&["--token-file", "relative/token", "--http"]);
        assert_eq!(h.token_file, Some(PathBuf::from("relative/token")), "the order of the flags does not matter");
    }

    #[test]
    fn the_http_flags_combine_with_the_common_ones() {
        let (options, h) = http(&["--http", "--vault", "/v", "--read-only", "--author", "Claude", "--port", "1"]);
        assert_eq!(
            options,
            Options { vault: Some("/v".into()), read_only: true, author: "Claude".into(), updates: UpdatesMode::Watch }
        );
        assert_eq!(h.port, 1);
    }

    #[test]
    fn the_last_port_wins_and_the_whole_range_is_accepted() {
        assert_eq!(http(&["--http", "--port", "1", "--port=2"]).1.port, 2);
        assert_eq!(http(&["--http", "--port", "0"]).1.port, 0);
        assert_eq!(http(&["--http", "--port", "65535"]).1.port, 65535);
    }

    #[test]
    fn a_port_that_is_not_a_port_is_an_error_that_says_what_is_valid() {
        for bad in ["abc", "65536", "70000", "-1", "80.5", "0x50", " 80", "80 ", "+"] {
            let error = run(&["--http", "--port", bad]).unwrap_err();
            let ArgsError::InvalidValue { flag, message } = &error else { panic!("{bad}: {error:?}") };
            assert_eq!(flag, "--port", "{bad}");
            assert!(message.contains(&format!("\"{bad}\"")) && message.contains("0 to 65535"), "{bad}: {message}");
        }
        assert_eq!(run(&["--http", "--port"]), Err(ArgsError::MissingValue("--port".into())));
        assert_eq!(run(&["--http", "--port="]), Err(ArgsError::MissingValue("--port".into())));
    }

    #[test]
    fn the_http_flags_are_an_error_without_http_rather_than_silently_ignored() {
        assert_eq!(run(&["--port", "9000"]), Err(ArgsError::HttpOnly("--port".into())));
        assert_eq!(run(&["--token", TOKEN]), Err(ArgsError::HttpOnly("--token".into())));
        assert_eq!(run(&["--token-file", "/t"]), Err(ArgsError::HttpOnly("--token-file".into())));
        assert_eq!(ArgsError::HttpOnly("--port".into()).to_string(), "--port only applies with --http");
    }

    #[test]
    fn the_token_variable_is_ignored_without_http_so_it_cannot_break_the_stdio_server() {
        let Command::Run(_) = run_with_env(&[], &[("OPROJECTS_MCP_TOKEN", "short")]).unwrap() else {
            panic!("expected the stdio server")
        };
    }

    #[test]
    fn the_token_may_come_from_the_environment() {
        let (_, h) = http_with_env(&["--http"], &[("OPROJECTS_MCP_TOKEN", TOKEN)]);
        assert_eq!(h.token.as_deref(), Some(TOKEN));
    }

    #[test]
    fn the_token_flag_beats_the_environment_and_an_empty_variable_is_unset() {
        let other = "fedcba9876543210fedcba9876543210";
        let (_, h) = http_with_env(&["--http", "--token", TOKEN], &[("OPROJECTS_MCP_TOKEN", other)]);
        assert_eq!(h.token.as_deref(), Some(TOKEN));
        let (_, h) = http_with_env(&["--http"], &[("OPROJECTS_MCP_TOKEN", "")]);
        assert_eq!(h.token, None);
    }

    #[test]
    fn a_token_file_beats_the_environment_variable() {
        let (_, h) = http_with_env(&["--http", "--token-file", "/t"], &[("OPROJECTS_MCP_TOKEN", TOKEN)]);
        assert_eq!((h.token, h.token_file), (None, Some(PathBuf::from("/t"))));
    }

    #[test]
    fn a_token_and_a_token_file_together_are_refused() {
        let error = run(&["--http", "--token", TOKEN, "--token-file", "/t"]).unwrap_err();
        assert_eq!(error, ArgsError::TokenAndFile);
        assert!(error.to_string().contains("cannot be used together"));
    }

    #[test]
    fn a_weak_token_is_refused_and_the_message_names_where_it_came_from() {
        let error = run(&["--http", "--token", "short"]).unwrap_err();
        assert_eq!(error.to_string(), "--token: the token is 5 characters long; it must have at least 16");
        let error =
            run_with_env(&["--http"], &[("OPROJECTS_MCP_TOKEN", "has a space in it, long enough")]).unwrap_err();
        assert!(error.to_string().starts_with("$OPROJECTS_MCP_TOKEN: "), "{error}");
        assert!(error.to_string().contains("visible ASCII"), "{error}");
        // The secret itself must not be echoed back in an error.
        let error = run(&["--http", "--token", "tooshort"]).unwrap_err().to_string();
        assert!(!error.contains("tooshort"), "{error}");
    }

    #[test]
    fn help_still_wins_over_every_http_mistake() {
        assert_eq!(run(&["--http", "--port", "abc", "--help"]), Ok(Command::Help));
        assert_eq!(run(&["--port", "9", "--version"]), Ok(Command::Version));
    }

    #[test]
    fn unknown_http_looking_flags_are_still_rejected() {
        assert_eq!(run(&["--http", "--host", "0.0.0.0"]), Err(ArgsError::UnknownOption("--host".into())));
        assert_eq!(run(&["--http=true"]), Err(ArgsError::UnknownOption("--http=true".into())));
    }

    #[test]
    fn the_usage_documents_the_http_mode() {
        let text = usage("1.2.3");
        for needle in [
            "--http",
            "--port",
            "--token",
            "--token-file",
            "OPROJECTS_MCP_TOKEN",
            "127.0.0.1 only",
            "claude mcp add --transport http",
        ] {
            assert!(text.contains(needle), "{needle}");
        }
        assert!(text.contains("8765"));
    }

    #[test]
    fn the_usage_shows_the_command_to_add_the_server_to_claude_code() {
        let text = usage("1.2.3");
        assert!(text.starts_with("oprojects-mcp 1.2.3:"));
        assert!(text.contains("claude mcp add obsidian-projects -- oprojects-mcp --vault /path/to/your/vault"));
        for flag in ["--vault", "--read-only", "--author", "--version", "--help", "OPROJECTS_VAULT", "OPROJECTS_AUTHOR"]
        {
            assert!(text.contains(flag), "{flag}");
        }
    }

    #[test]
    fn updates_default_to_watch_and_take_the_three_modes() {
        assert_eq!(options(&[]).updates, UpdatesMode::Watch);
        assert_eq!(options(&["--updates", "watch"]).updates, UpdatesMode::Watch);
        assert_eq!(options(&["--updates=channel"]).updates, UpdatesMode::Channel);
        assert_eq!(options(&["--updates", "off"]).updates, UpdatesMode::Off);
    }

    #[test]
    fn an_unknown_updates_mode_says_what_is_valid() {
        let error = run(&["--updates", "push"]).unwrap_err().to_string();
        assert!(error.contains("--updates") && error.contains("watch, channel or off"), "{error}");
        assert_eq!(run(&["--updates"]), Err(ArgsError::MissingValue("--updates".into())));
    }

    #[test]
    fn channel_updates_need_stdio() {
        assert_eq!(run(&["--http", "--updates", "channel"]), Err(ArgsError::ChannelNeedsStdio));
        assert!(matches!(run(&["--http", "--updates", "watch"]), Ok(Command::Http { .. })));
        assert!(matches!(run(&["--http", "--updates", "off"]), Ok(Command::Http { .. })));
    }

    fn watching(args: &[&str]) -> WatchArgs {
        let mut all = vec!["watch"];
        all.extend(args);
        match run(&all).unwrap() {
            Command::Watch(w) => w,
            other => panic!("expected watch, got {other:?}"),
        }
    }

    #[test]
    fn watch_takes_card_keys_and_the_options_in_any_order() {
        let w = watching(&["OP-12", "--vault", "/v", "13", "--author=Claude", "--settle", "0.5"]);
        assert_eq!(
            w,
            WatchArgs {
                keys: vec!["OP-12".into(), "13".into()],
                vault: Some("/v".into()),
                author: "Claude".into(),
                settle: Duration::from_millis(500),
            }
        );
    }

    #[test]
    fn watch_defaults_come_from_the_environment_and_then_the_constants() {
        let w = watching(&["12"]);
        assert_eq!((w.vault, w.author.as_str(), w.settle), (None, "Agent", SETTLE));
        let env = [("OPROJECTS_VAULT", "/env"), ("OPROJECTS_AUTHOR", "Cursor")];
        let Command::Watch(w) = run_with_env(&["watch", "12"], &env).unwrap() else { panic!("watch") };
        assert_eq!((w.vault.as_deref(), w.author.as_str()), (Some("/env"), "Cursor"));
    }

    #[test]
    fn watch_without_a_key_or_with_a_bad_option_is_a_mistake() {
        assert_eq!(run(&["watch"]), Err(ArgsError::WatchNeedsKey));
        assert_eq!(run(&["watch", "--author", "A"]), Err(ArgsError::WatchNeedsKey));
        assert_eq!(run(&["watch", "12", "--port", "1"]), Err(ArgsError::UnknownOption("--port".into())));
        for bad in ["0", "-1", "abc", "nan", "3601", "inf"] {
            let error = run(&["watch", "12", "--settle", bad]).unwrap_err();
            assert!(matches!(error, ArgsError::InvalidValue { ref flag, .. } if flag == "--settle"), "{bad}: {error}");
        }
    }

    #[test]
    fn watch_help_is_the_help() {
        assert_eq!(run(&["watch", "--help"]), Ok(Command::Help));
    }

    #[test]
    fn a_key_that_looks_like_the_word_watch_later_in_the_line_is_still_unexpected() {
        assert_eq!(run(&["--read-only", "watch"]), Err(ArgsError::UnexpectedArgument("watch".into())));
    }
}
