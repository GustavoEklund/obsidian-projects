//! Reads the arguments of a command the way Node's `util.parseArgs` does in strict mode with positionals allowed, which
//! is what the TypeScript command line uses. The rules are the ones of that implementation and are not those of most
//! command line libraries: an option's value is the next argument even when that starts with a dash (and is then
//! refused as ambiguous), `-sdoing` is `-s doing`, `-abc` is three flags, and `--` ends the options.
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Flag,
}

/// One option a command accepts.
#[derive(Debug, Clone, Copy)]
pub struct Opt {
    pub name: &'static str,
    pub short: Option<char>,
    pub kind: Kind,
    /// May be given several times (every value is kept); otherwise the last one wins.
    pub multiple: bool,
}

pub const fn text(name: &'static str) -> Opt {
    Opt { name, short: None, kind: Kind::Text, multiple: false }
}

pub const fn flag(name: &'static str) -> Opt {
    Opt { name, short: None, kind: Kind::Flag, multiple: false }
}

impl Opt {
    pub const fn short(mut self, c: char) -> Self {
        self.short = Some(c);
        self
    }

    pub const fn multiple(mut self) -> Self {
        self.multiple = true;
        self
    }
}

/// What was given: the positional arguments, and the options by their long name.
#[derive(Debug, Default)]
pub struct Parsed {
    pub positionals: Vec<String>,
    values: Vec<(String, Option<String>)>,
}

impl Parsed {
    /// Was the flag given?
    pub fn flag(&self, name: &str) -> bool {
        self.values.iter().any(|(n, _)| n == name)
    }

    /// The value of a text option (the last one, when it was repeated).
    pub fn text(&self, name: &str) -> Option<&str> {
        self.values.iter().rev().find(|(n, _)| n == name).and_then(|(_, v)| v.as_deref())
    }

    /// Every value given to a text option, in order.
    pub fn list(&self, name: &str) -> Vec<&str> {
        self.values.iter().filter(|(n, _)| n == name).filter_map(|(_, v)| v.as_deref()).collect()
    }
}

enum Token {
    Option { name: String, raw: String, value: Option<String>, inline: bool },
    Positional(String),
}

fn find<'a>(options: &'a [Opt], name: &str) -> Option<&'a Opt> {
    options.iter().find(|o| o.name == name)
}

/// The long name of the option with this short one; a short one that is not declared is its own name, so it ends up
/// reported as unknown.
fn long_for_short(options: &[Opt], short: char) -> String {
    options.iter().find(|o| o.short == Some(short)).map_or_else(|| short.to_string(), |o| o.name.to_string())
}

fn is_text(options: &[Opt], name: &str) -> bool {
    find(options, name).is_some_and(|o| o.kind == Kind::Text)
}

fn tokenize(args: &[String], options: &[Opt]) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut remaining: VecDeque<String> = args.iter().cloned().collect();
    while let Some(arg) = remaining.pop_front() {
        let chars: Vec<char> = arg.chars().collect();
        if arg == "--" {
            tokens.extend(remaining.drain(..).map(Token::Positional));
            break;
        }
        let starts_dash = chars.first() == Some(&'-');
        let second_is_dash = chars.get(1) == Some(&'-');
        // `-f`
        if chars.len() == 2 && starts_dash && !second_is_dash {
            let name = long_for_short(options, chars[1]);
            let mut value = None;
            if is_text(options, &name) {
                value = remaining.pop_front();
            }
            tokens.push(Token::Option { name, raw: arg.clone(), inline: false, value });
            continue;
        }
        // `-fXzy` with `f` not taking a value: expand to `-f -X -z -y`
        if chars.len() > 2 && starts_dash && !second_is_dash && !is_text(options, &long_for_short(options, chars[1])) {
            let mut expanded: Vec<String> = Vec::new();
            for (i, &short) in chars.iter().enumerate().skip(1) {
                if !is_text(options, &long_for_short(options, short)) || i == chars.len() - 1 {
                    expanded.push(format!("-{short}"));
                } else {
                    let rest: String = chars[i..].iter().collect();
                    expanded.push(format!("-{rest}"));
                    break;
                }
            }
            for item in expanded.into_iter().rev() {
                remaining.push_front(item);
            }
            continue;
        }
        // `-fFILE`
        if chars.len() > 2 && starts_dash && !second_is_dash && is_text(options, &long_for_short(options, chars[1])) {
            let name = long_for_short(options, chars[1]);
            let value: String = chars[2..].iter().collect();
            tokens.push(Token::Option { name, raw: format!("-{}", chars[1]), value: Some(value), inline: true });
            continue;
        }
        let long = chars.len() > 2 && starts_dash && second_is_dash;
        let equals_after_name = chars.iter().skip(3).any(|&c| c == '=');
        // `--foo`
        if long && !equals_after_name {
            let name: String = chars[2..].iter().collect();
            let mut value = None;
            if is_text(options, &name) {
                value = remaining.pop_front();
            }
            tokens.push(Token::Option { name, raw: arg.clone(), inline: false, value });
            continue;
        }
        // `--foo=bar`
        if long {
            let equals = chars.iter().position(|&c| c == '=').unwrap_or(chars.len());
            let name: String = chars[2..equals].iter().collect();
            let value: String = chars.get(equals + 1..).unwrap_or(&[]).iter().collect();
            tokens.push(Token::Option { raw: format!("--{name}"), name, value: Some(value), inline: true });
            continue;
        }
        tokens.push(Token::Positional(arg));
    }
    tokens
}

/// Parses `args` against `options`. The error is the message to show, worded like Node's.
pub fn parse(args: &[String], options: &[Opt]) -> Result<Parsed, String> {
    let mut parsed = Parsed::default();
    for token in tokenize(args, options) {
        match token {
            Token::Positional(value) => parsed.positionals.push(value),
            Token::Option { name, raw, value, inline } => {
                let Some(opt) = find(options, &name) else {
                    let quoted = super::json::quote(&raw);
                    return Err(format!(
                        "Unknown option '{raw}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- {quoted}'"
                    ));
                };
                let short = opt.short.map_or_else(String::new, |s| format!("-{s}, "));
                let shown = format!("{short}--{name}");
                if opt.kind == Kind::Text && value.is_none() {
                    return Err(format!("Option '{shown} <value>' argument missing"));
                }
                if opt.kind == Kind::Flag && value.is_some() {
                    return Err(format!("Option '{shown}' does not take an argument"));
                }
                if !inline && value.as_deref().is_some_and(|v| v.chars().count() > 1 && v.starts_with('-')) {
                    let example = if raw.starts_with("--") {
                        format!("'{raw}=-XYZ'")
                    } else {
                        format!("'--{name}=-XYZ' or '{raw}-XYZ'")
                    };
                    return Err(format!(
                        "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use {example}."
                    ));
                }
                if opt.kind == Kind::Text && !opt.multiple {
                    parsed.values.retain(|(n, _)| *n != name);
                }
                parsed.values.push((name, value));
            }
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPTIONS: &[Opt] = &[
        text("vault"),
        flag("json"),
        flag("help").short('h'),
        text("status").short('s').multiple(),
        text("type").short('t'),
        flag("mine"),
        text("query").short('q'),
    ];

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    fn ok(items: &[&str]) -> Parsed {
        parse(&args(items), OPTIONS).unwrap()
    }

    fn err(items: &[&str]) -> String {
        parse(&args(items), OPTIONS).unwrap_err()
    }

    #[test]
    fn options_values_and_positionals() {
        let p = ok(&["a", "--status", "doing", "b", "-s", "todo", "--json", "-t", "bug", "-t", "story"]);
        assert_eq!(p.positionals, ["a", "b"]);
        assert_eq!(p.list("status"), ["doing", "todo"]);
        assert_eq!(p.text("type"), Some("story"), "the last value of an option given twice wins");
        assert!(p.flag("json") && !p.flag("mine"));
    }

    #[test]
    fn every_way_to_attach_a_value() {
        assert_eq!(ok(&["--status=doing"]).text("status"), Some("doing"));
        assert_eq!(ok(&["-sdoing"]).text("status"), Some("doing"));
        assert_eq!(ok(&["-s=doing"]).text("status"), Some("=doing"), "-s=x is the value =x");
        assert_eq!(ok(&["--status="]).text("status"), Some(""));
        assert_eq!(ok(&["--status=a=b"]).text("status"), Some("a=b"));
        assert_eq!(ok(&["-s", "-"]).text("status"), Some("-"), "a lone dash is a value");
        assert_eq!(ok(&["--status", "x y"]).text("status"), Some("x y"));
    }

    #[test]
    fn short_flags_group_and_the_last_one_may_take_a_value() {
        let p = ok(&["-hq", "words"]);
        assert!(p.flag("help"));
        assert_eq!(p.text("query"), Some("words"));
        assert_eq!(ok(&["-hqwords"]).text("query"), Some("words"));
        assert!(ok(&["-hh"]).flag("help"));
    }

    #[test]
    fn dashes_that_are_positionals() {
        assert_eq!(ok(&["-"]).positionals, ["-"]);
        assert_eq!(ok(&["--", "--json", "-x"]).positionals, ["--json", "-x"]);
        assert!(!ok(&["--", "--json"]).flag("json"));
        assert!(ok(&["--json", "--", "x"]).flag("json"));
        assert_eq!(ok(&["--"]).positionals, Vec::<String>::new());
    }

    #[test]
    fn unknown_options_are_named_with_the_hint() {
        assert_eq!(
            err(&["--bogus"]),
            "Unknown option '--bogus'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--bogus\"'"
        );
        assert!(err(&["-x"]).starts_with("Unknown option '-x'. "));
        assert!(err(&["-1"]).starts_with("Unknown option '-1'. "));
        assert!(err(&["-xh"]).starts_with("Unknown option '-x'. "), "the first problem in order is the one reported");
        assert!(err(&["-hx"]).starts_with("Unknown option '-x'. "));
        assert!(err(&["--Status", "x"]).starts_with("Unknown option '--Status'. "), "names are case sensitive");
        assert!(err(&["---x"]).starts_with("Unknown option '---x'. "));
        assert!(err(&["--a=b"]).starts_with("Unknown option '--a'. "));
    }

    #[test]
    fn a_missing_value() {
        assert_eq!(err(&["--vault"]), "Option '--vault <value>' argument missing");
        assert_eq!(err(&["-s"]), "Option '-s, --status <value>' argument missing");
        assert_eq!(err(&["-t"]), "Option '-t, --type <value>' argument missing");
        assert_eq!(err(&["-hq"]), "Option '-q, --query <value>' argument missing");
    }

    #[test]
    fn a_value_that_looks_like_an_option_is_ambiguous() {
        assert_eq!(
            err(&["--status", "--json"]),
            "Option '--status' argument is ambiguous.\nDid you forget to specify the option argument for '--status'?\nTo specify an option argument starting with a dash use '--status=-XYZ'."
        );
        assert_eq!(
            err(&["-s", "-x"]),
            "Option '-s' argument is ambiguous.\nDid you forget to specify the option argument for '-s'?\nTo specify an option argument starting with a dash use '--status=-XYZ' or '-s-XYZ'."
        );
        assert_eq!(ok(&["--status=-x"]).text("status"), Some("-x"));
        assert_eq!(ok(&["-s-x"]).text("status"), Some("-x"));
        assert_eq!(ok(&["-s", "-"]).text("status"), Some("-"));
    }

    #[test]
    fn a_flag_with_a_value() {
        assert_eq!(err(&["--json=1"]), "Option '--json' does not take an argument");
        assert_eq!(err(&["--help="]), "Option '-h, --help' does not take an argument");
    }

    #[test]
    fn errors_come_in_the_order_of_the_arguments() {
        assert!(err(&["--bogus", "--json=1"]).starts_with("Unknown option '--bogus'"));
        assert!(err(&["--json=1", "--bogus"]).starts_with("Option '--json' does not take"));
    }

    #[test]
    fn non_ascii_arguments() {
        assert!(err(&["-é"]).starts_with("Unknown option '-é'. "));
        assert_eq!(ok(&["--status", "日本語"]).text("status"), Some("日本語"));
        assert_eq!(ok(&["-s日本語"]).text("status"), Some("日本語"));
    }
}
