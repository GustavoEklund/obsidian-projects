//! Where the notes actually live. A port of `packages/core/src/storage.ts` and `packages/core/src/node/fs-storage.ts`.
//!
//! Paths are vault-relative with forward slashes. The server shares a vault with Obsidian (which watches the folder),
//! the plugin and the CLI, possibly all writing at once, so the contract is about not stepping on anyone:
//!
//! - `create` never overwrites: of any number of writers racing for one path, exactly one wins, even across processes
//!   (`O_EXCL`), and the losers get [`Error::FileExists`].
//! - `modify` is an atomic read-modify-write inside this process: calls on one note queue up and each one reads what the
//!   previous one wrote. The new content goes through a hidden temp file and a rename, so no reader, in or out of the
//!   process, ever sees a half-written note. (Two different processes modifying one note at the same moment can still
//!   lose an update: that needs a lock the other writers would have to honour.)
//! - `remove` moves the note to the vault's `.trash/` under a name nobody else holds, so it is recoverable and one
//!   trashed note never overwrites another.
//!
//! The functions are synchronous: a note is a few kilobytes and a call takes well under a millisecond. Callers that
//! scan thousands of notes run them on a blocking thread.
use crate::error::{Error, Result};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// The seam between the card logic and the place notes live. Implementations must be safe to share between threads.
pub trait Storage: Send + Sync {
    /// Every markdown file under `folder`, recursively, as vault-relative paths in ascending order. A folder that does
    /// not exist yet is an empty list, not an error.
    fn list_markdown(&self, folder: &str) -> Result<Vec<String>>;
    fn read(&self, path: &str) -> Result<String>;
    /// Fails with [`Error::FileExists`] when `path` already exists. Creates missing folders.
    fn create(&self, path: &str, content: &str) -> Result<()>;
    /// Atomic read-modify-write: `f` gets the current content and returns the new one (or an error, which leaves the
    /// note untouched). Returns what was written.
    fn modify(&self, path: &str, f: &mut dyn FnMut(&str) -> Result<String>) -> Result<String>;
    fn remove(&self, path: &str) -> Result<()>;
    fn exists(&self, path: &str) -> bool;
}

/// [`Storage::modify`] with a closure that runs once, which is what nearly every caller has.
pub fn modify_with<S: Storage + ?Sized>(
    storage: &S,
    path: &str,
    f: impl FnOnce(&str) -> Result<String>,
) -> Result<String> {
    let mut f = Some(f);
    storage.modify(path, &mut |content| match f.take() {
        Some(f) => f(content),
        None => Err(Error::Format("a storage called the modify closure twice".into())),
    })
}

macro_rules! forward_storage {
    ($($wrapper:ty),+) => {$(
        impl<S: Storage + ?Sized> Storage for $wrapper {
            fn list_markdown(&self, folder: &str) -> Result<Vec<String>> { (**self).list_markdown(folder) }
            fn read(&self, path: &str) -> Result<String> { (**self).read(path) }
            fn create(&self, path: &str, content: &str) -> Result<()> { (**self).create(path, content) }
            fn modify(&self, path: &str, f: &mut dyn FnMut(&str) -> Result<String>) -> Result<String> {
                (**self).modify(path, f)
            }
            fn remove(&self, path: &str) -> Result<()> { (**self).remove(path) }
            fn exists(&self, path: &str) -> bool { (**self).exists(path) }
        }
    )+};
}
forward_storage!(Arc<S>, Box<S>, &S);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding the lock cannot leave the data half-updated in a way that matters here.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// --- in memory ----------------------------------------------------------------------------------------------------

/// Tiny in-memory adapter for tests and prototypes. Unlike [`FsStorage`] it does not hide dot files or `.trash`: it
/// only knows paths and contents. Listings come back in ascending path order.
#[derive(Debug, Default)]
pub struct MemoryStorage {
    files: Mutex<BTreeMap<String, String>>,
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self::default()
    }

    /// Puts a file there, replacing whatever was at the path (setup for tests; `create` is the checked way).
    pub fn insert(&self, path: &str, content: &str) {
        locked(&self.files).insert(path.to_owned(), content.to_owned());
    }

    /// A copy of every file: path to content.
    pub fn snapshot(&self) -> BTreeMap<String, String> {
        locked(&self.files).clone()
    }
}

impl Storage for MemoryStorage {
    fn list_markdown(&self, folder: &str) -> Result<Vec<String>> {
        let prefix = if folder.is_empty() { String::new() } else { format!("{folder}/") };
        Ok(locked(&self.files).keys().filter(|p| p.starts_with(&prefix) && p.ends_with(".md")).cloned().collect())
    }

    fn read(&self, path: &str) -> Result<String> {
        locked(&self.files).get(path).cloned().ok_or_else(|| Error::NotFound(path.to_owned()))
    }

    fn create(&self, path: &str, content: &str) -> Result<()> {
        let mut files = locked(&self.files);
        if files.contains_key(path) {
            return Err(Error::FileExists(path.to_owned()));
        }
        files.insert(path.to_owned(), content.to_owned());
        Ok(())
    }

    fn modify(&self, path: &str, f: &mut dyn FnMut(&str) -> Result<String>) -> Result<String> {
        // The lock is held from the read to the write: that is what makes the read-modify-write atomic.
        let mut files = locked(&self.files);
        let next = f(files.get(path).ok_or_else(|| Error::NotFound(path.to_owned()))?)?;
        files.insert(path.to_owned(), next.clone());
        Ok(next)
    }

    fn remove(&self, path: &str) -> Result<()> {
        locked(&self.files).remove(path).map(|_| ()).ok_or_else(|| Error::NotFound(path.to_owned()))
    }

    fn exists(&self, path: &str) -> bool {
        locked(&self.files).contains_key(path)
    }
}

// --- on disk ------------------------------------------------------------------------------------------------------

/// One lock per note, shared by every `FsStorage` of the process, so two storages over the same vault queue up too.
type NoteLocks = Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>;

fn note_locks() -> &'static NoteLocks {
    static LOCKS: OnceLock<NoteLocks> = OnceLock::new();
    LOCKS.get_or_init(Mutex::default)
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A held per-note lock; the map entry is dropped again when nobody else is waiting for it.
struct NoteGuard {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl NoteGuard {
    fn acquire(path: &Path) -> Self {
        let lock = Arc::clone(locked(note_locks()).entry(path.to_owned()).or_default());
        Self { path: path.to_owned(), lock }
    }
}

impl Drop for NoteGuard {
    fn drop(&mut self) {
        let mut locks = locked(note_locks());
        // The map holds one reference and this guard the other: nobody else is queued, so the entry can go.
        if Arc::strong_count(&self.lock) == 2 {
            locks.remove(&self.path);
        }
    }
}

/// How many notes under `root` currently have a lock entry (a modify running or queued). Only for tests: it proves the
/// per-note locks are given back instead of piling up.
#[doc(hidden)]
pub fn pending_note_locks_under(root: &Path) -> usize {
    locked(note_locks()).keys().filter(|p| p.starts_with(root)).count()
}

/// `Storage` over a vault directory on disk. Paths are vault-relative, forward slashes.
#[derive(Debug)]
pub struct FsStorage {
    root: PathBuf,
    /// `root` split into components once, to check every path against it.
    root_parts: Vec<OsString>,
}

/// The components of `path` made absolute against the current directory and cleaned lexically (`.` and `..` resolved,
/// symbolic links left alone), like Node's `path.resolve`.
fn resolve(path: &Path) -> Vec<OsString> {
    let mut parts: Vec<OsString> = Vec::new();
    let absolute: PathBuf =
        if path.is_absolute() { path.to_owned() } else { std::env::current_dir().unwrap_or_default().join(path) };
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // `/..` is `/`
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            other => parts.push(other.as_os_str().to_owned()),
        }
    }
    parts
}

impl FsStorage {
    pub fn new(root: impl AsRef<Path>) -> Self {
        let root_parts = resolve(root.as_ref());
        Self { root: root_parts.iter().collect(), root_parts }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The absolute path of a vault-relative one, refusing anything that would leave the vault. Like the TypeScript, the
    /// check is on the path's text (`..` segments), not on what symbolic links inside the vault point to.
    fn abs(&self, rel: &str) -> Result<PathBuf> {
        let mut parts = self.root_parts.clone();
        let root_len = parts.len();
        for segment in rel.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    if parts.len() > 1 {
                        parts.pop();
                    }
                }
                other => parts.push(other.into()),
            }
        }
        if parts.len() < root_len || parts[..root_len] != self.root_parts[..] {
            return Err(Error::validation(format!("Path escapes the vault: {rel}")));
        }
        Ok(parts.iter().collect())
    }

    fn walk(&self, rel: &str, out: &mut Vec<String>) -> Result<()> {
        let dir = self.abs(rel)?;
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()), // no cards yet
            Err(e) => return Err(Error::io(dir, e)),
        };
        for entry in entries {
            let entry = entry.map_err(|e| Error::io(&dir, e))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue; // temp files, .trash, .obsidian
            }
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(kind) = entry.file_type() else { continue }; // vanished while we were looking
            if kind.is_dir() {
                self.walk(&child, out)?;
            } else if kind.is_file() && name.ends_with(".md") {
                out.push(child);
            }
        }
        Ok(())
    }

    /// Reads `file` (already resolved) as text; bytes that are not valid UTF-8 become U+FFFD, like Node's `'utf8'`.
    fn read_file(&self, rel: &str, file: &Path) -> Result<String> {
        match fs::read(file) {
            Ok(bytes) => {
                Ok(String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Err(Error::NotFound(rel.to_owned())),
            Err(e) => Err(Error::io(file, e)),
        }
    }

    /// Writes `next` through a hidden temp file in the same folder, then renames it over the note.
    fn replace_content(&self, file: &Path, next: &str) -> Result<()> {
        let dir = file.parent().unwrap_or(&self.root);
        let base = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
        let temp = dir.join(format!(".{base}.{}.{counter}.tmp", std::process::id()));
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .and_then(|mut f| f.write_all(next.as_bytes()))
            .and_then(|()| fs::rename(&temp, file));
        if let Err(e) = written {
            let _ = fs::remove_file(&temp);
            return Err(Error::io(file, e));
        }
        Ok(())
    }
}

/// `name` and `ext` of a file name the way Node's `path.parse` splits them: the extension starts at the LAST dot, unless
/// that dot is the first character (`.md` is a name, not an extension).
fn split_name_ext(file_name: &str) -> (&str, &str) {
    match file_name.rfind('.') {
        Some(dot) if dot > 0 => file_name.split_at(dot),
        _ => (file_name, ""),
    }
}

fn now_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

/// Attempts at a free trash name before giving up: far more than any real collision, so a loop cannot run forever.
const MAX_TRASH_ATTEMPTS: u32 = 10_000;

impl Storage for FsStorage {
    fn list_markdown(&self, folder: &str) -> Result<Vec<String>> {
        let mut out = Vec::new();
        self.walk(folder, &mut out)?;
        out.sort_unstable();
        Ok(out)
    }

    fn read(&self, path: &str) -> Result<String> {
        self.read_file(path, &self.abs(path)?)
    }

    fn create(&self, path: &str, content: &str) -> Result<()> {
        let file = self.abs(path)?;
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;
        }
        let mut handle = match OpenOptions::new().write(true).create_new(true).open(&file) {
            Ok(handle) => handle,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => return Err(Error::FileExists(path.to_owned())),
            Err(e) => return Err(Error::io(&file, e)),
        };
        if let Err(e) = handle.write_all(content.as_bytes()) {
            // A half-written card would sit there blocking its key: take it back.
            drop(handle);
            let _ = fs::remove_file(&file);
            return Err(Error::io(&file, e));
        }
        Ok(())
    }

    fn modify(&self, path: &str, f: &mut dyn FnMut(&str) -> Result<String>) -> Result<String> {
        let file = self.abs(path)?;
        // Concurrent calls on one note (an MCP client firing several tools at once) must not interleave: each reads
        // what the previous one wrote. They queue up per file; different files still run in parallel.
        let guard = NoteGuard::acquire(&file);
        let _held = locked(&guard.lock);
        let next = f(&self.read_file(path, &file)?)?;
        self.replace_content(&file, &next)?;
        Ok(next)
    }

    /// Moves to the vault's `.trash/` (what Obsidian's "move to Obsidian trash" does) so it is recoverable.
    fn remove(&self, path: &str) -> Result<()> {
        let file = self.abs(path)?;
        let trash = self.root.join(".trash");
        fs::create_dir_all(&trash).map_err(|e| Error::io(&trash, e))?;
        let file_name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let (name, ext) = split_name_ext(&file_name);

        // `name.md`, else `name <timestamp>.md`, else `name <timestamp>-2.md`, ...: never a name that is taken. The name
        // is claimed with an exclusive create, so two removals racing for it (threads or processes) cannot both get it,
        // and the rename that follows replaces our own placeholder, never somebody else's note.
        let mut attempt = 0u32;
        let target = loop {
            let label = match attempt {
                0 => name.to_owned(),
                1 => format!("{name} {}", now_millis()),
                n => format!("{name} {}-{n}", now_millis()),
            };
            let candidate = trash.join(format!("{label}{ext}"));
            match OpenOptions::new().write(true).create_new(true).open(&candidate) {
                Ok(_) => break candidate,
                Err(e) if e.kind() == ErrorKind::AlreadyExists && attempt < MAX_TRASH_ATTEMPTS => attempt += 1,
                Err(e) => return Err(Error::io(candidate, e)),
            }
        };
        // A folder cannot be renamed over a file, so a (rare) folder gives its claim up just before the move.
        if fs::symlink_metadata(&file).is_ok_and(|m| m.is_dir()) {
            let _ = fs::remove_file(&target);
        }
        match fs::rename(&file, &target) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = fs::remove_file(&target); // the placeholder (a no-op if a folder already gave it up)
                if e.kind() == ErrorKind::NotFound {
                    Err(Error::NotFound(path.to_owned()))
                } else {
                    Err(Error::io(file, e))
                }
            }
        }
    }

    fn exists(&self, path: &str) -> bool {
        self.abs(path).is_ok_and(|file| fs::metadata(file).is_ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_style_name_and_extension_split() {
        assert_eq!(split_name_ext("OP-1.md"), ("OP-1", ".md"));
        assert_eq!(split_name_ext("a.b.md"), ("a.b", ".md"));
        assert_eq!(split_name_ext(".md"), (".md", ""));
        assert_eq!(split_name_ext(".bashrc"), (".bashrc", ""));
        assert_eq!(split_name_ext("noext"), ("noext", ""));
        assert_eq!(split_name_ext("trailing."), ("trailing", "."));
        assert_eq!(split_name_ext(""), ("", ""));
    }

    #[test]
    fn resolve_cleans_paths_lexically() {
        let parts =
            |p: &str| resolve(Path::new(p)).iter().map(|s| s.to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(parts("/a/b/../c/./d"), ["/", "a", "c", "d"]);
        assert_eq!(parts("/.."), ["/"]);
        assert_eq!(parts("/a//b/"), ["/", "a", "b"]);
    }

    #[test]
    fn memory_storage_matches_the_contract() {
        let s = MemoryStorage::new();
        s.create("Cards/OP-1.md", "one").unwrap();
        assert!(matches!(s.create("Cards/OP-1.md", "again"), Err(Error::FileExists(p)) if p == "Cards/OP-1.md"));
        assert_eq!(s.read("Cards/OP-1.md").unwrap(), "one");
        assert!(matches!(s.read("Cards/OP-2.md"), Err(Error::NotFound(p)) if p == "Cards/OP-2.md"));
        assert_eq!(modify_with(&s, "Cards/OP-1.md", |c| Ok(format!("{c}!"))).unwrap(), "one!");
        assert!(modify_with(&s, "Cards/OP-1.md", |_| Err(Error::validation("no"))).is_err());
        assert_eq!(s.read("Cards/OP-1.md").unwrap(), "one!"); // a failing closure changes nothing
        s.insert("Cards/sub/OP-3.md", "x");
        s.insert("Cards/notes.txt", "x");
        s.insert("Other/OP-4.md", "x");
        assert_eq!(s.list_markdown("Cards").unwrap(), ["Cards/OP-1.md", "Cards/sub/OP-3.md"]);
        assert_eq!(s.list_markdown("").unwrap().len(), 3);
        s.remove("Cards/OP-1.md").unwrap();
        assert!(!s.exists("Cards/OP-1.md"));
        assert!(matches!(s.remove("Cards/OP-1.md"), Err(Error::NotFound(_))));
    }
}
