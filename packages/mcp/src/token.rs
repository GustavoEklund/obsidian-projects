//! The secret that guards the HTTP transport: where it comes from, what it must look like, how it is checked.
//!
//! Anything that can reach `127.0.0.1` can talk to the server, and that includes every other program of the user and,
//! through a hostile page's DNS tricks or a stray request, a browser. The bearer token is what makes "reachable" not
//! mean "allowed": without it the server answers `401` before it looks at the request.
//!
//! A token comes from one of three places, in this order of preference:
//!
//! 1. the user (`--token`, `$OPROJECTS_MCP_TOKEN`): used as given and never printed back;
//! 2. a token file (`--token-file`): read when it exists, otherwise created with a fresh token, readable by its owner
//!    only (mode 0600 on Unix), so the same token survives restarts and a client can read it from the file;
//! 3. nowhere: a fresh random token, shown once on stderr when the server starts.
//!
//! The comparison is constant time (see [`ct_eq`]) so the answer does not leak how much of a guess was right.
use std::fmt::{self, Write as _};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

/// Shorter secrets are refused: a token a person types is a password, and this one guards a local door that is knocked
/// on by programs, so it has to survive guessing at machine speed.
pub const MIN_LEN: usize = 16;

/// How many random bytes a generated token carries (it is written as twice as many hex characters).
pub const GENERATED_BYTES: usize = 32;

/// A token file is a token and a newline; anything bigger is not one.
const MAX_FILE_BYTES: u64 = 1024;

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("the token is {len} characters long; it must have at least {MIN_LEN}")]
    TooShort { len: usize },
    #[error("the token may only contain visible ASCII characters (no spaces, no control characters)")]
    InvalidCharacters,
    #[error("cannot read the token file {}: {source}", path.display())]
    Unreadable { path: PathBuf, source: io::Error },
    #[error("the token file {} is not a token file: {reason}", path.display())]
    BadFile { path: PathBuf, reason: String },
    #[error("cannot write the token file {}: {source}", path.display())]
    Unwritable { path: PathBuf, source: io::Error },
    #[error("cannot generate a random token: {0}")]
    Random(String),
}

/// Where the secret came from, which decides what the server may say about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// Given by the user (flag or environment). Never printed.
    Supplied,
    /// Freshly generated and not stored anywhere: shown once at startup.
    Generated,
    /// Stored in a file. `created` is true when this start created the file.
    File { path: PathBuf, created: bool },
}

/// The secret and its origin. `Debug` never shows the secret.
#[derive(Clone, PartialEq, Eq)]
pub struct Token {
    secret: String,
    source: Source,
    /// Something the user should know about the token file, such as being readable by other users.
    warning: Option<String>,
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Token")
            .field("secret", &"<hidden>")
            .field("source", &self.source)
            .field("warning", &self.warning)
            .finish()
    }
}

impl Token {
    pub fn secret(&self) -> &str {
        &self.secret
    }

    pub fn source(&self) -> &Source {
        &self.source
    }

    pub fn warning(&self) -> Option<&str> {
        self.warning.as_deref()
    }

    /// A user-supplied token, checked.
    pub fn supplied(secret: impl Into<String>) -> Result<Self, TokenError> {
        let secret = secret.into();
        validate(&secret)?;
        Ok(Self { secret, source: Source::Supplied, warning: None })
    }

    /// A fresh random token that is not stored anywhere.
    pub fn generated() -> Result<Self, TokenError> {
        Ok(Self { secret: generate()?, source: Source::Generated, warning: None })
    }
}

/// Whether `secret` is acceptable as a token: long enough, and made only of visible ASCII (so it fits a header and a
/// command line without quoting surprises).
pub fn validate(secret: &str) -> Result<(), TokenError> {
    if secret.len() < MIN_LEN {
        return Err(TokenError::TooShort { len: secret.chars().count() });
    }
    if !secret.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(TokenError::InvalidCharacters);
    }
    Ok(())
}

/// A random token: [`GENERATED_BYTES`] bytes from the operating system, as lowercase hex.
pub fn generate() -> Result<String, TokenError> {
    let mut bytes = [0u8; GENERATED_BYTES];
    getrandom::fill(&mut bytes).map_err(|e| TokenError::Random(e.to_string()))?;
    let mut hex = String::with_capacity(GENERATED_BYTES * 2);
    for byte in bytes {
        // Writing to a String cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

/// Resolves the token for a server start: a supplied secret wins, then the file, then a fresh token.
pub fn resolve(supplied: Option<&str>, file: Option<&Path>) -> Result<Token, TokenError> {
    match (supplied, file) {
        (Some(secret), _) => Token::supplied(secret),
        (None, Some(path)) => from_file(path),
        (None, None) => Token::generated(),
    }
}

/// The token stored in `path`; the file is created with a fresh token when it does not exist yet.
pub fn from_file(path: &Path) -> Result<Token, TokenError> {
    match std::fs::metadata(path) {
        Ok(meta) => read_file(path, &meta),
        Err(e) if e.kind() == io::ErrorKind::NotFound => create_file(path),
        Err(source) => Err(TokenError::Unreadable { path: path.to_path_buf(), source }),
    }
}

fn read_file(path: &Path, meta: &std::fs::Metadata) -> Result<Token, TokenError> {
    let unreadable = |source| TokenError::Unreadable { path: path.to_path_buf(), source };
    if !meta.is_file() {
        return Err(TokenError::BadFile { path: path.to_path_buf(), reason: "it is not a regular file".into() });
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(TokenError::BadFile {
            path: path.to_path_buf(),
            reason: format!("it is {} bytes long; a token file holds one short line", meta.len()),
        });
    }
    let bytes = std::fs::read(path).map_err(unreadable)?;
    let text = String::from_utf8(bytes)
        .map_err(|_| TokenError::BadFile { path: path.to_path_buf(), reason: "it is not text".into() })?;
    let secret = text.trim();
    validate(secret).map_err(|e| TokenError::BadFile { path: path.to_path_buf(), reason: e.to_string() })?;
    Ok(Token {
        secret: secret.to_string(),
        source: Source::File { path: path.to_path_buf(), created: false },
        warning: exposure_warning(path, meta),
    })
}

fn create_file(path: &Path) -> Result<Token, TokenError> {
    let secret = generate()?;
    let unwritable = |source| TokenError::Unwritable { path: path.to_path_buf(), source };
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(secret.as_bytes()).and_then(|()| file.write_all(b"\n")).map_err(unwritable)?;
            Ok(Token { secret, source: Source::File { path: path.to_path_buf(), created: true }, warning: None })
        }
        // Another start created it between our check and our create: use theirs.
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => from_file(path),
        Err(e) => Err(unwritable(e)),
    }
}

#[cfg(unix)]
fn exposure_warning(path: &Path, meta: &std::fs::Metadata) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = meta.permissions().mode() & 0o777;
    (mode & 0o077 != 0).then(|| {
        format!(
            "the token file {} is readable by other users (mode {mode:o}); run `chmod 600 {}`",
            path.display(),
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn exposure_warning(_path: &Path, _meta: &std::fs::Metadata) -> Option<String> {
    None
}

/// Equality that takes the same time wherever two byte strings first differ: every byte is looked at and the
/// differences are accumulated, instead of stopping at the first mismatch. Strings of different lengths are never
/// equal; the time depends on the longer one, which is the length the caller chose, not the secret's.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let mut difference = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        difference |= usize::from(x ^ y);
    }
    std::hint::black_box(difference) == 0
}

/// Whether the `Authorization` header values of a request carry `secret` as a bearer token. The scheme is matched
/// without regard to case (RFC 9110), exactly one header must be present, and the token must match in full.
pub fn bearer_matches(authorization: &[&str], secret: &str) -> bool {
    let [value] = authorization else { return false };
    let Some((scheme, credentials)) = value.split_once(' ') else { return false };
    scheme.eq_ignore_ascii_case("bearer") && ct_eq(credentials.trim_start().as_bytes(), secret.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn ct_eq_agrees_with_equality_on_the_cases_that_matter() {
        assert!(ct_eq(b"", b""));
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"), "last byte");
        assert!(!ct_eq(b"xbc", b"abc"), "first byte");
        assert!(!ct_eq(b"abc", b"abcd"), "longer");
        assert!(!ct_eq(b"abcd", b"abc"), "shorter");
        assert!(!ct_eq(b"", b"a"));
        assert!(!ct_eq(b"a\0", b"a"), "a trailing NUL is not padding");
        assert!(!ct_eq(b"a", b"a\0"));
    }

    #[test]
    fn validate_enforces_length_and_visible_ascii() {
        assert!(validate(GOOD).is_ok());
        assert!(validate("A~!@#$%^&*()_+-=[]{}|;:,.<>?").is_ok());
        assert!(matches!(validate(""), Err(TokenError::TooShort { len: 0 })));
        assert!(matches!(validate("short"), Err(TokenError::TooShort { len: 5 })));
        assert!(matches!(validate(&"x".repeat(MIN_LEN - 1)), Err(TokenError::TooShort { .. })));
        assert!(validate(&"x".repeat(MIN_LEN)).is_ok());
        assert!(matches!(validate("0123456789 abcdef0123"), Err(TokenError::InvalidCharacters)));
        assert!(matches!(validate("0123456789abcdef\n"), Err(TokenError::InvalidCharacters)));
        assert!(matches!(validate("0123456789abcdéf0123"), Err(TokenError::InvalidCharacters)));
        assert!(matches!(validate("0123456789abcdef\t"), Err(TokenError::InvalidCharacters)));
    }

    #[test]
    fn the_length_error_counts_characters_not_bytes() {
        assert_eq!(
            validate("ééé").unwrap_err().to_string(),
            "the token is 3 characters long; it must have at least 16"
        );
    }

    #[test]
    fn generated_tokens_are_long_hex_and_different_every_time() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            let token = generate().unwrap();
            assert_eq!(token.len(), GENERATED_BYTES * 2);
            assert!(token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{token}");
            validate(&token).unwrap();
            assert!(seen.insert(token), "a generated token repeated");
        }
    }

    #[test]
    fn debug_never_shows_the_secret() {
        let token = Token::supplied(GOOD).unwrap();
        let text = format!("{token:?}");
        assert!(!text.contains(GOOD));
        assert!(text.contains("<hidden>"));
    }

    #[test]
    fn resolve_prefers_the_supplied_secret_then_the_file_then_a_fresh_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        let supplied = resolve(Some(GOOD), Some(&path)).unwrap();
        assert_eq!((supplied.secret(), supplied.source()), (GOOD, &Source::Supplied));
        assert!(!path.exists(), "a supplied token must not create the file");

        let from_file = resolve(None, Some(&path)).unwrap();
        assert_eq!(from_file.source(), &Source::File { path: path.clone(), created: true });

        let generated = resolve(None, None).unwrap();
        assert_eq!(generated.source(), &Source::Generated);
        assert_eq!(generated.secret().len(), 64);
    }

    #[test]
    fn a_supplied_token_is_validated() {
        assert!(matches!(resolve(Some("short"), None), Err(TokenError::TooShort { .. })));
    }

    #[test]
    fn the_token_file_is_created_once_and_then_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        let first = from_file(&path).unwrap();
        assert_eq!(first.source(), &Source::File { path: path.clone(), created: true });
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{}\n", first.secret()));

        let second = from_file(&path).unwrap();
        assert_eq!(second.secret(), first.secret());
        assert_eq!(second.source(), &Source::File { path, created: false });
    }

    #[cfg(unix)]
    #[test]
    fn a_created_token_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        let token = from_file(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(token.warning(), None);
        assert_eq!(from_file(&path).unwrap().warning(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_token_file_other_users_can_read_is_used_but_flagged() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        std::fs::write(&path, format!("{GOOD}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let token = from_file(&path).unwrap();
        assert_eq!(token.secret(), GOOD);
        let warning = token.warning().expect("a warning");
        assert!(warning.contains("readable by other users"), "{warning}");
        assert!(warning.contains("chmod 600"), "{warning}");
    }

    #[test]
    fn surrounding_whitespace_in_a_token_file_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        std::fs::write(&path, format!("\n  {GOOD}  \r\n\n")).unwrap();
        assert_eq!(from_file(&path).unwrap().secret(), GOOD);
    }

    #[test]
    fn garbage_in_a_token_file_is_rejected_and_the_file_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let cases: [(&str, &[u8]); 6] = [
            ("empty", b""),
            ("too short", b"abc\n"),
            ("inner whitespace", b"0123456789 abcdef0123456789\n"),
            ("two lines", b"0123456789abcdef0123\n0123456789abcdef0123\n"),
            (
                "not text",
                &[0xff, 0xfe, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x01],
            ),
            ("huge", &[b'a'; 4096]),
        ];
        for (name, content) in cases {
            let path = dir.path().join(name.replace(' ', "-"));
            std::fs::write(&path, content).unwrap();
            let error = from_file(&path).unwrap_err();
            assert!(matches!(error, TokenError::BadFile { .. }), "{name}: {error}");
            assert!(error.to_string().contains("is not a token file"), "{name}: {error}");
            assert_eq!(std::fs::read(&path).unwrap(), content, "{name}: the file must not be touched");
        }
    }

    #[test]
    fn a_directory_or_a_missing_parent_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(from_file(dir.path()), Err(TokenError::BadFile { .. })));
        let missing_parent = dir.path().join("nowhere").join("token");
        assert!(matches!(from_file(&missing_parent), Err(TokenError::Unwritable { .. })));
    }

    #[test]
    fn bearer_matching_follows_the_rules_of_the_header() {
        let ok = |values: &[&str]| bearer_matches(values, GOOD);
        assert!(ok(&[&format!("Bearer {GOOD}")]));
        assert!(ok(&[&format!("bearer {GOOD}")]), "the scheme is case-insensitive");
        assert!(ok(&[&format!("BEARER {GOOD}")]));
        assert!(ok(&[&format!("Bearer   {GOOD}")]), "extra spaces before the token");
        assert!(!ok(&[]), "no header");
        assert!(!ok(&[GOOD]), "no scheme");
        assert!(!ok(&[&format!("Basic {GOOD}")]), "wrong scheme");
        assert!(!ok(&[&format!("Bearer{GOOD}")]), "no space");
        assert!(!ok(&["Bearer "]));
        assert!(!ok(&["Bearer"]));
        assert!(!ok(&[&format!("Bearer {}", &GOOD[1..])]), "prefix missing");
        assert!(!ok(&[&format!("Bearer {GOOD}x")]), "one character too many");
        assert!(!ok(&[&format!("Bearer {GOOD} extra")]));
        assert!(!ok(&[&format!("Bearer {GOOD}"), &format!("Bearer {GOOD}")]), "two headers are ambiguous");
        assert!(!ok(&["Bearer nope", &format!("Bearer {GOOD}")]));
    }

    mod properties {
        use super::*;
        use proptest::prelude::*;

        proptest! {
            #[test]
            fn ct_eq_is_exactly_equality(a in proptest::collection::vec(any::<u8>(), 0..64), b in proptest::collection::vec(any::<u8>(), 0..64)) {
                prop_assert_eq!(ct_eq(&a, &b), a == b);
                prop_assert!(ct_eq(&a, &a));
            }

            #[test]
            fn flipping_any_single_byte_of_the_token_is_caught(index in 0usize..32, flip in 1u8..=255) {
                let mut wrong = GOOD.as_bytes().to_vec();
                wrong[index] ^= flip;
                prop_assert!(!ct_eq(&wrong, GOOD.as_bytes()));
            }

            #[test]
            fn arbitrary_header_values_pass_only_when_they_are_a_bearer_header_with_the_exact_token(value in ".{0,80}") {
                let model = value.get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
                    && value.get(7..).map(str::trim_start) == Some(GOOD);
                prop_assert_eq!(bearer_matches(&[&value], GOOD), model);
            }

            #[test]
            fn headers_built_close_to_a_valid_one_pass_only_when_they_are_valid(
                scheme in prop::sample::select(vec!["Bearer", "bearer", "BEARER", "Basic", "Bearer2", ""]),
                padding in 0usize..3,
                token in prop::sample::select(vec![GOOD, "0123456789abcdef0123456789abcdee", "0123456789abcdef", ""]),
                suffix in prop::sample::select(vec!["", "x", " "]),
            ) {
                let value = format!("{scheme} {}{token}{suffix}", " ".repeat(padding));
                let valid = scheme.eq_ignore_ascii_case("bearer") && token == GOOD && suffix.is_empty();
                prop_assert_eq!(bearer_matches(&[&value], GOOD), valid, "{:?}", value);
            }

            #[test]
            fn any_acceptable_token_survives_a_trip_through_a_file(secret in "[!-~]{16,64}") {
                let dir = tempfile::tempdir().unwrap();
                let path = dir.path().join("token");
                std::fs::write(&path, format!("{secret}\n")).unwrap();
                let token = from_file(&path).unwrap();
                prop_assert_eq!(token.secret(), secret.as_str());
            }
        }
    }
}
