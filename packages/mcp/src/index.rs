//! The in-memory index of the cards: what makes reads fast and small.
//!
//! An agent asks for lists all day; parsing every note to answer each one costs hundreds of milliseconds of CPU on a big
//! vault, and even stat-ing every file per call is too slow. So the server keeps the parsed cards in memory and keeps
//! them current:
//!
//! - **Started in the background.** [`CardIndex::start`] returns at once and loads the vault on a worker thread, so the
//!   MCP `initialize` is never delayed. [`CardIndex::snapshot`] waits for that first load (with a timeout, then returns
//!   what it has).
//! - **File-system events** (the `notify` crate) say which notes changed. Events arrive in bursts (an editor saving, a
//!   sync client writing fifty notes), so they are debounced: the worker waits for a quiet moment and then looks at each
//!   changed path once.
//! - **Periodic reconciliation** is the safety net that makes missed events harmless: it lists the folder with each
//!   note's [`Stamp`] (modification time and length) and re-reads only what differs from what the index holds. It runs
//!   every minute by default, when the watcher reports an error or an overflow, and on demand. Without a watcher at all
//!   (a vault on a network drive, say) it is the whole mechanism.
//! - **A cards folder that does not exist yet** (a fresh vault, before its first card) is not a reason to go blind: the
//!   closest folder above it is watched until it appears, and the cards folder is then watched and looked at in full. The
//!   same goes for a cards folder that is deleted and made again.
//! - **Read your writes.** The service tells the index about its own writes ([`CardIndex::refresh_path`]), which looks at
//!   that note right away; the event that follows finds nothing new and changes nothing.
//! - **No torn reads.** Everything is updated under one lock, and a snapshot is taken under it: a reader sees the index
//!   as it was before or after a change, never half of it.
//! - **Racy timestamps.** Two edits within one clock tick can leave the same modification time and length, so a note
//!   read less than two seconds after it was modified is never trusted as unchanged (the rule git uses for the same
//!   reason): it is looked at again next time.
//!
//! A note that cannot be parsed as a card is simply not in the index. Memory is the point of this server: a card holds
//! its own copy of its text (nothing keeps a whole note alive), and the board order is sorted once and reused until
//! something changes.
use crate::card::parse_card;
use crate::error::Error;
use crate::query::sort_cards;
use crate::service::CardSource;
use crate::storage::{Stamp, Storage};
use crate::types::{BoardConfig, Card};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher, event::ModifyKind};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long the worker keeps waiting for a burst of events to end before it looks at the paths, at most.
const MAX_DEBOUNCE_WAIT: Duration = Duration::from_secs(1);
/// A note modified less than this long before it was read cannot be trusted to look different when it changes again.
const RACY_WINDOW_NS: u128 = 2_000_000_000;
/// Notes at or above this many are read by several threads.
const PARALLEL_READ_FROM: usize = 64;

#[derive(Debug, Clone)]
pub struct IndexOptions {
    /// How often to reconcile with the storage, to catch what events missed.
    pub reconcile_every: Duration,
    /// How long events must stay quiet before the changed notes are looked at.
    pub debounce: Duration,
    /// The vault's root on disk, to watch its cards folder for changes. `None` means no watcher: only the periodic
    /// reconciliation and [`CardIndex::refresh_path`] keep the index current.
    pub watch_vault_root: Option<PathBuf>,
    /// How long [`CardIndex::snapshot`] waits for the first load before giving up and returning what is there.
    pub first_load_timeout: Duration,
}

impl Default for IndexOptions {
    fn default() -> Self {
        Self {
            reconcile_every: Duration::from_secs(60),
            debounce: Duration::from_millis(100),
            watch_vault_root: None,
            first_load_timeout: Duration::from_secs(30),
        }
    }
}

/// Counters for tests and diagnostics.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexStats {
    /// Notes read from the storage since the index started.
    pub notes_read: u64,
    /// Reconciliations run (the first load is one).
    pub reconciles: u64,
    /// Changed paths the worker looked at after events.
    pub events_applied: u64,
    /// Whether a file-system watcher is running.
    pub watching: bool,
}

struct Entry {
    card: Arc<Card>,
    stamp: Option<Stamp>,
    /// Newer reads win over older ones that finish later.
    ticket: u64,
    /// Read too soon after the note was modified for an equal stamp to prove anything.
    racy: bool,
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    /// The cards in board order, shared by every snapshot taken until the next change.
    sorted: Option<Arc<Vec<Arc<Card>>>>,
    /// The ticket of the read that removed a note: a slower read of the same note that started earlier must not bring it
    /// back. Dropped by the next reconciliation.
    removed: HashMap<String, u64>,
    loaded: bool,
    notes_read: u64,
    reconciles: u64,
    events_applied: u64,
    watching: bool,
}

struct Shared {
    storage: Arc<dyn Storage>,
    config: BoardConfig,
    state: Mutex<State>,
    loaded: Condvar,
    tickets: AtomicU64,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `Instant::now() + d`, or a year from now when `d` is too long to add (a "never" in disguise).
fn after(d: Duration) -> Instant {
    Instant::now().checked_add(d).unwrap_or_else(|| Instant::now() + Duration::from_secs(365 * 24 * 3600))
}

fn now_ns() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos())
}

/// What the worker is told.
enum Message {
    /// Paths the watcher reported as touched.
    Changed(Vec<PathBuf>),
    /// The watcher failed or lost events: look at everything.
    Rescan,
    Shutdown,
}

pub struct CardIndex {
    shared: Arc<Shared>,
    sender: Sender<Message>,
    worker: Mutex<Option<JoinHandle<()>>>,
    first_load_timeout: Duration,
}

/// The file-system watcher and what it is watching. It lives on the worker thread, so it stops with it.
struct Watching {
    watcher: RecommendedWatcher,
    /// The cards folder, as the vault spells it.
    folder: PathBuf,
    /// Whether the cards folder itself is being watched. Until it exists (a vault whose first card is yet to be made), the
    /// closest folder above it is watched instead, only to hear it appear.
    attached: bool,
    /// The folder above the cards folder that is being watched while it does not exist.
    above: Option<PathBuf>,
    /// The spellings of the cards folder that events may report (the vault path and its canonical form).
    roots: Vec<PathBuf>,
}

impl Watching {
    /// Brings the watches in line with the disk: watches the cards folder when it exists and is not watched yet, forgets it
    /// when it was deleted. Returns `true` when the cards folder has just become watched, which means notes may have been
    /// written before the watch began and the caller should look at everything.
    fn follow_folder(&mut self) -> bool {
        if self.attached && !self.folder.is_dir() {
            self.attached = false;
        }
        if self.attached {
            return false;
        }
        if !self.try_attach() {
            // Not there: listen one level up so its creation is noticed, then check again in case it came in between.
            self.watch_above();
            if !self.try_attach() {
                return false;
            }
        }
        true
    }

    fn try_attach(&mut self) -> bool {
        if self.watcher.watch(&self.folder, RecursiveMode::Recursive).is_err() {
            return false;
        }
        self.roots = vec![self.folder.clone()];
        if let Ok(canonical) = self.folder.canonicalize()
            && canonical != self.folder
        {
            self.roots.push(canonical);
        }
        self.attached = true;
        true
    }

    fn watch_above(&mut self) {
        let Some(nearest) = self.folder.ancestors().skip(1).find(|dir| dir.is_dir()) else {
            return;
        };
        if self.above.as_deref() != Some(nearest) && self.watcher.watch(nearest, RecursiveMode::NonRecursive).is_ok() {
            self.above = Some(nearest.to_path_buf());
        }
    }
}

/// One note read from the storage, ready to be put into the index.
struct Loaded {
    path: String,
    card: Option<Arc<Card>>,
    stamp: Option<Stamp>,
    ticket: u64,
    racy: bool,
}

impl Shared {
    fn next_ticket(&self) -> u64 {
        self.tickets.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Reads and parses one note. `Err(())` when it could not be read for a reason that says nothing about whether it
    /// exists (permissions, a read error): then the index keeps whatever it has.
    fn load(&self, path: &str, stamp: Option<Stamp>) -> Result<Loaded, ()> {
        let ticket = self.next_ticket();
        let racy = stamp.is_some_and(|s| {
            let now = now_ns();
            s.modified_ns <= now && now - s.modified_ns < RACY_WINDOW_NS
        });
        match self.storage.read(path) {
            Ok(content) => {
                locked(&self.state).notes_read += 1;
                Ok(Loaded {
                    path: path.to_string(),
                    card: parse_card(path, &content).map(Arc::new),
                    stamp,
                    ticket,
                    racy,
                })
            }
            Err(Error::NotFound(_)) => {
                Ok(Loaded { path: path.to_string(), card: None, stamp: None, ticket, racy: false })
            }
            Err(_) => Err(()),
        }
    }

    /// Puts what was read into the index, unless a newer read of the same note got there first.
    fn apply(&self, loaded: Loaded) {
        let mut state = locked(&self.state);
        let newest = state.entries.get(&loaded.path).map(|e| e.ticket).max(state.removed.get(&loaded.path).copied());
        if newest.is_some_and(|ticket| ticket > loaded.ticket) {
            return;
        }
        let changed = match loaded.card {
            Some(card) => {
                let same = state.entries.get(&loaded.path).is_some_and(|e| *e.card == *card);
                state.removed.remove(&loaded.path);
                state
                    .entries
                    .insert(loaded.path, Entry { card, stamp: loaded.stamp, ticket: loaded.ticket, racy: loaded.racy });
                !same
            }
            None => {
                state.removed.insert(loaded.path.clone(), loaded.ticket);
                state.entries.remove(&loaded.path).is_some()
            }
        };
        if changed {
            state.sorted = None;
        }
    }

    /// Looks at one note again, if it may have changed.
    fn refresh(&self, path: &str) {
        let stamp = self.storage.stamp(path);
        let unchanged = {
            let state = locked(&self.state);
            match (state.entries.get(path), stamp) {
                (Some(entry), Some(now)) => entry.stamp == Some(now) && !entry.racy,
                _ => false,
            }
        };
        if unchanged {
            return;
        }
        if let Ok(loaded) = self.load(path, stamp) {
            self.apply(loaded);
        }
    }

    /// Reads many notes, on several threads when there are many.
    fn load_many(&self, wanted: &[(String, Option<Stamp>)]) -> Vec<Loaded> {
        if wanted.len() < PARALLEL_READ_FROM {
            return wanted.iter().filter_map(|(path, stamp)| self.load(path, *stamp).ok()).collect();
        }
        let workers = std::thread::available_parallelism().map_or(2, usize::from).clamp(2, 4);
        let next = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..workers)
                .map(|_| {
                    scope.spawn(|| {
                        let mut found = Vec::new();
                        loop {
                            let i = next.fetch_add(1, Ordering::Relaxed);
                            let Some((path, stamp)) = wanted.get(i) else { break };
                            found.extend(self.load(path, *stamp).ok());
                        }
                        found
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        })
    }

    /// Lists the cards folder with stamps and brings the index in line with it, reading only what differs.
    fn reconcile(&self) {
        let started = self.tickets.load(Ordering::SeqCst);
        let Ok(listing) = self.storage.list_stamped(&self.config.folder) else {
            return;
        };
        let wanted: Vec<(String, Option<Stamp>)>;
        let gone: Vec<String>;
        {
            let state = locked(&self.state);
            wanted = listing
                .iter()
                .filter(|(path, stamp)| match state.entries.get(path) {
                    Some(entry) => stamp.is_none() || entry.stamp != *stamp || entry.racy,
                    None => true,
                })
                .cloned()
                .collect();
            let present: HashSet<&str> = listing.iter().map(|(p, _)| p.as_str()).collect();
            gone = state.entries.keys().filter(|p| !present.contains(p.as_str())).cloned().collect();
        }
        for loaded in self.load_many(&wanted) {
            self.apply(loaded);
        }
        for path in gone {
            // it may have come back since the listing: ask again before forgetting it
            self.refresh(&path);
        }
        let mut state = locked(&self.state);
        state.reconciles += 1;
        state.removed.retain(|_, ticket| *ticket > started);
    }

    fn finish_first_load(&self) {
        let mut state = locked(&self.state);
        state.loaded = true;
        drop(state);
        self.loaded.notify_all();
    }
}

/// The vault-relative path (`Cards/OP-1.md`) of a path the watcher reported, or `None` when it is not a note the index
/// cares about: not markdown, hidden (editors' temp files, `.trash`), or outside the cards folder.
fn relative_note(path: &Path, roots: &[PathBuf], folder: &str) -> Option<String> {
    let rest = roots.iter().find_map(|root| path.strip_prefix(root).ok())?;
    let mut parts = Vec::new();
    for component in rest.components() {
        let name = component.as_os_str().to_str()?;
        if name.starts_with('.') {
            return None;
        }
        parts.push(name);
    }
    let file = parts.last()?;
    if !file.ends_with(".md") {
        return None;
    }
    Some(format!("{folder}/{}", parts.join("/")))
}

fn worker(shared: &Shared, receiver: &mpsc::Receiver<Message>, options: &IndexOptions, mut watching: Option<Watching>) {
    shared.reconcile(); // the first load
    shared.finish_first_load();

    let mut pending: HashSet<String> = HashSet::new();
    let mut rescan = false;
    let mut first_pending_at: Option<Instant> = None;
    let mut next_reconcile = after(options.reconcile_every);
    loop {
        let busy = rescan || !pending.is_empty();
        let wait = if busy { options.debounce } else { next_reconcile.saturating_duration_since(Instant::now()) };
        match receiver.recv_timeout(wait) {
            Ok(Message::Changed(paths)) => {
                if let Some(w) = watching.as_mut() {
                    rescan |= follow_folder(shared, w);
                    pending.extend(paths.iter().filter_map(|p| relative_note(p, &w.roots, &shared.config.folder)));
                }
                if !pending.is_empty() || rescan {
                    first_pending_at.get_or_insert_with(Instant::now);
                }
                // A steady stream of events must not postpone the work forever.
                if first_pending_at.is_some_and(|t| t.elapsed() >= MAX_DEBOUNCE_WAIT) {
                    flush(shared, &mut pending, &mut rescan, &mut first_pending_at);
                }
            }
            Ok(Message::Rescan) => {
                if let Some(w) = watching.as_mut() {
                    follow_folder(shared, w);
                }
                rescan = true;
            }
            Ok(Message::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {
                if busy {
                    flush(shared, &mut pending, &mut rescan, &mut first_pending_at);
                    next_reconcile = after(options.reconcile_every);
                } else {
                    shared.reconcile();
                    next_reconcile = after(options.reconcile_every);
                }
            }
        }
    }
}

/// [`Watching::follow_folder`], keeping the `watching` statistic true to what happened. Returns whether the notes
/// should be looked at again: the cards folder has just become watched (notes may have been written before the watch
/// began) or has just gone away (the notes in it are gone, and some back ends do not say so note by note).
fn follow_folder(shared: &Shared, watching: &mut Watching) -> bool {
    let attached_before = watching.attached;
    let just_attached = watching.follow_folder();
    let changed = watching.attached != attached_before;
    if changed {
        locked(&shared.state).watching = watching.attached;
    }
    just_attached || changed
}

/// Whether an event means "look at everything". Some back ends (FSEvents on macOS) report a deleted, created or renamed
/// folder as one event, with none for the notes inside it, so what it held would be kept after a deletion or missed after
/// a move. Events about a note, or about a hidden file (the temporary files of atomic writes), are the ordinary kind,
/// handled note by note.
fn needs_rescan(kind: &EventKind, paths: &[PathBuf]) -> bool {
    let structural = matches!(
        kind,
        EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Any
            | EventKind::Other
    );
    structural && paths.iter().any(|path| is_folder_like(path))
}

/// A path that is neither a note nor a hidden file: most likely a folder.
fn is_folder_like(path: &Path) -> bool {
    match path.file_name().and_then(|name| name.to_str()) {
        Some(name) => !name.starts_with('.') && !name.ends_with(".md"),
        None => true,
    }
}

fn flush(shared: &Shared, pending: &mut HashSet<String>, rescan: &mut bool, first_pending_at: &mut Option<Instant>) {
    if std::mem::take(rescan) {
        shared.reconcile();
        pending.clear();
    } else {
        let paths: Vec<String> = pending.drain().collect();
        locked(&shared.state).events_applied += paths.len() as u64;
        for path in paths {
            shared.refresh(&path);
        }
    }
    *first_pending_at = None;
}

impl CardIndex {
    /// Starts watching and loading, and returns immediately. `storage` is where the notes live; the index only reads
    /// from it (the service does the writing and calls [`CardIndex::refresh_path`] afterwards).
    pub fn start<S: Storage + 'static>(storage: Arc<S>, config: BoardConfig, options: IndexOptions) -> Arc<Self> {
        let shared = Arc::new(Shared {
            storage,
            config,
            state: Mutex::new(State::default()),
            loaded: Condvar::new(),
            tickets: AtomicU64::new(0),
        });
        let (sender, receiver) = mpsc::channel();

        // The watcher goes first, so a change made while the vault loads is not lost: it queues up behind the load.
        let watching = options.watch_vault_root.as_deref().and_then(|vault| {
            let events = sender.clone();
            let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
                Ok(event) if event.need_rescan() => drop(events.send(Message::Rescan)),
                Ok(event) if !matches!(event.kind, EventKind::Access(_)) => {
                    let look_at_everything = needs_rescan(&event.kind, &event.paths);
                    drop(events.send(Message::Changed(event.paths)));
                    if look_at_everything {
                        drop(events.send(Message::Rescan));
                    }
                }
                Ok(_) => {}
                Err(_) => drop(events.send(Message::Rescan)),
            })
            .ok()?;
            let mut watching = Watching {
                watcher,
                folder: vault.join(&shared.config.folder),
                attached: false,
                above: None,
                roots: Vec::new(),
            };
            watching.follow_folder();
            Some(watching)
        });
        locked(&shared.state).watching = watching.as_ref().is_some_and(|w| w.attached);

        let handle = {
            let shared = Arc::clone(&shared);
            let options = options.clone();
            std::thread::Builder::new()
                .name("oprojects-index".into())
                .spawn(move || worker(&shared, &receiver, &options, watching))
                .ok()
        };
        if handle.is_none() {
            // No thread, no background load: do it here so the index still works.
            shared.reconcile();
            shared.finish_first_load();
        }
        Arc::new(Self { shared, sender, worker: Mutex::new(handle), first_load_timeout: options.first_load_timeout })
    }

    /// Waits until the first load is done; `false` when `timeout` ran out first.
    pub fn wait_until_loaded(&self, timeout: Duration) -> bool {
        let state = locked(&self.shared.state);
        let (state, _) = self
            .shared
            .loaded
            .wait_timeout_while(state, timeout, |s| !s.loaded)
            .unwrap_or_else(PoisonError::into_inner);
        state.loaded
    }

    pub fn is_loaded(&self) -> bool {
        locked(&self.shared.state).loaded
    }

    /// How many cards the index holds.
    pub fn len(&self) -> usize {
        locked(&self.shared.state).entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Every card in board order, as one consistent set. Waits for the first load (up to the configured timeout).
    pub fn snapshot(&self) -> Vec<Arc<Card>> {
        self.wait_until_loaded(self.first_load_timeout);
        let mut state = locked(&self.shared.state);
        if state.sorted.is_none() {
            let cards: Vec<Arc<Card>> = state.entries.values().map(|e| Arc::clone(&e.card)).collect();
            state.sorted = Some(Arc::new(sort_cards(&cards, &self.shared.config)));
        }
        state.sorted.as_ref().map(|s| s.as_ref().clone()).unwrap_or_default()
    }

    /// Looks at the note at `path` (vault-relative) now, because the caller just wrote or removed it.
    pub fn refresh_path(&self, path: &str) {
        self.shared.refresh(path);
    }

    /// Drops the note at `path` from the index, because the caller just removed it.
    pub fn forget_path(&self, path: &str) {
        let ticket = self.shared.next_ticket();
        let mut state = locked(&self.shared.state);
        state.removed.insert(path.to_string(), ticket);
        if state.entries.remove(path).is_some() {
            state.sorted = None;
        }
    }

    /// Reconciles with the storage now, on the calling thread.
    pub fn reconcile(&self) {
        self.shared.reconcile();
    }

    pub fn stats(&self) -> IndexStats {
        let state = locked(&self.shared.state);
        IndexStats {
            notes_read: state.notes_read,
            reconciles: state.reconciles,
            events_applied: state.events_applied,
            watching: state.watching,
        }
    }
}

impl CardSource for CardIndex {
    fn cards(&self) -> Vec<Arc<Card>> {
        self.snapshot()
    }

    fn refresh_path(&self, path: &str) {
        CardIndex::refresh_path(self, path);
    }

    fn forget_path(&self, path: &str) {
        CardIndex::forget_path(self, path);
    }
}

impl Drop for CardIndex {
    fn drop(&mut self) {
        let _ = self.sender.send(Message::Shutdown);
        if let Some(handle) = locked(&self.worker).take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod folder_event_tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, MetadataKind, RemoveKind, RenameMode};

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn a_folder_that_is_removed_created_or_renamed_means_look_at_everything() {
        assert!(needs_rescan(&EventKind::Remove(RemoveKind::Folder), &paths(&["/v/Cards"])));
        assert!(needs_rescan(&EventKind::Create(CreateKind::Folder), &paths(&["/v/Cards/Sub"])));
        assert!(needs_rescan(&EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &paths(&["/v/Old", "/v/Cards"])));
        assert!(needs_rescan(&EventKind::Remove(RemoveKind::Any), &paths(&["/v/Cards"])));
        assert!(needs_rescan(&EventKind::Any, &paths(&["/v/Cards"])));
    }

    #[test]
    fn a_note_or_a_hidden_file_is_the_ordinary_per_note_case() {
        assert!(!needs_rescan(&EventKind::Remove(RemoveKind::File), &paths(&["/v/Cards/OP-1.md"])));
        assert!(!needs_rescan(&EventKind::Create(CreateKind::File), &paths(&["/v/Cards/OP-2.md"])));
        assert!(!needs_rescan(&EventKind::Create(CreateKind::File), &paths(&["/v/Cards/.OP-2.md.123.4.tmp"])));
        assert!(!needs_rescan(&EventKind::Remove(RemoveKind::File), &paths(&["/v/Cards/.OP-2.md.123.4.tmp"])));
        assert!(!needs_rescan(
            &EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &paths(&["/v/Cards/.a.tmp", "/v/Cards/a.md"])
        ));
    }

    #[test]
    fn a_change_of_content_or_metadata_is_never_structural() {
        assert!(!needs_rescan(&EventKind::Modify(ModifyKind::Data(DataChange::Content)), &paths(&["/v/Cards"])));
        assert!(!needs_rescan(&EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)), &paths(&["/v/Cards"])));
        assert!(!needs_rescan(&EventKind::Access(notify::event::AccessKind::Any), &paths(&["/v/Cards"])));
    }

    #[test]
    fn one_folder_like_path_among_notes_is_enough_and_a_root_counts_as_one() {
        assert!(needs_rescan(&EventKind::Remove(RemoveKind::Any), &paths(&["/v/Cards/OP-1.md", "/v/Cards/Sub"])));
        assert!(needs_rescan(&EventKind::Remove(RemoveKind::Any), &paths(&["/"])));
        assert!(!needs_rescan(&EventKind::Remove(RemoveKind::Any), &paths(&[])));
    }

    #[test]
    fn a_visible_file_that_is_not_a_note_costs_one_harmless_rescan() {
        assert!(is_folder_like(Path::new("/v/Cards/cover.png")));
        assert!(!is_folder_like(Path::new("/v/Cards/.hidden")));
        assert!(!is_folder_like(Path::new("/v/Cards/OP-1.md")));
    }
}
