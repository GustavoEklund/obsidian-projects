//! `MemoryStorage` and `FsStorage` are two implementations of one contract. The test double has to be a faithful
//! stand-in for the real thing, so random sequences of operations are run against both and every answer must agree.
use oprojects_mcp::Error;
use oprojects_mcp::storage::{FsStorage, MemoryStorage, Storage, modify_with};
use proptest::prelude::*;
use std::sync::Arc;

const PATHS: [&str; 8] = [
    "Cards/a.md",
    "Cards/b.md",
    "Cards/sub/c.md",
    "Cards/sub/deep/d.md",
    "top.md",
    "Cards/note.txt",
    "Other/e.md",
    "Cards/UPPER.MD",
];
const FOLDERS: [&str; 6] = ["Cards", "Cards/sub", "", "Other", "Nope", "Cards/sub/deep"];

#[derive(Debug, Clone)]
enum Op {
    Create(usize, u8),
    Read(usize),
    Modify(usize, u8),
    FailingModify(usize),
    Remove(usize),
    Exists(usize),
    List(usize),
}

fn op() -> impl Strategy<Value = Op> {
    let path = 0..PATHS.len();
    prop_oneof![
        3 => (path.clone(), any::<u8>()).prop_map(|(p, c)| Op::Create(p, c)),
        2 => path.clone().prop_map(Op::Read),
        3 => (path.clone(), any::<u8>()).prop_map(|(p, c)| Op::Modify(p, c)),
        1 => path.clone().prop_map(Op::FailingModify),
        2 => path.clone().prop_map(Op::Remove),
        2 => path.prop_map(Op::Exists),
        2 => (0..FOLDERS.len()).prop_map(Op::List),
    ]
}

/// The kind of answer, which is what has to agree: success with this value, or this kind of error.
#[derive(Debug, PartialEq, Eq)]
enum Answer {
    Done,
    Text(String),
    Flag(bool),
    List(Vec<String>),
    NotFound,
    Exists,
    Other(String),
}

fn answer<T>(result: oprojects_mcp::Result<T>, ok: impl FnOnce(T) -> Answer) -> Answer {
    match result {
        Ok(value) => ok(value),
        Err(Error::NotFound(_)) => Answer::NotFound,
        Err(Error::FileExists(_)) => Answer::Exists,
        Err(other) => Answer::Other(format!("{other:?}")),
    }
}

fn run(storage: &dyn Storage, op: &Op) -> Answer {
    let letter = |c: &u8| char::from(b'a' + c % 26).to_string();
    match op {
        Op::Create(p, c) => answer(storage.create(PATHS[*p], &letter(c)), |()| Answer::Done),
        Op::Read(p) => answer(storage.read(PATHS[*p]), Answer::Text),
        Op::Modify(p, c) => {
            answer(storage.modify(PATHS[*p], &mut |current| Ok(format!("{current}{}", letter(c)))), Answer::Text)
        }
        Op::FailingModify(p) => {
            answer(storage.modify(PATHS[*p], &mut |_| Err(Error::Format("refused".into()))), Answer::Text)
        }
        Op::Remove(p) => answer(storage.remove(PATHS[*p]), |()| Answer::Done),
        Op::Exists(p) => Answer::Flag(storage.exists(PATHS[*p])),
        Op::List(f) => answer(storage.list_markdown(FOLDERS[*f]), Answer::List),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]

    #[test]
    fn disk_and_memory_agree_on_every_answer(ops in prop::collection::vec(op(), 0..45)) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".obsidian")).unwrap();
        let disk = FsStorage::new(dir.path());
        let memory = MemoryStorage::new();
        for (step, op) in ops.iter().enumerate() {
            let (on_disk, in_memory) = (run(&disk, op), run(&memory, op));
            prop_assert_eq!(&on_disk, &in_memory, "step {} ({:?})", step, op);
        }
        // and what is left is the same everywhere
        for folder in FOLDERS {
            prop_assert_eq!(disk.list_markdown(folder).unwrap(), memory.list_markdown(folder).unwrap());
        }
        for path in PATHS {
            prop_assert_eq!(disk.exists(path), memory.exists(path));
            if memory.exists(path) {
                prop_assert_eq!(disk.read(path).unwrap(), memory.read(path).unwrap());
            }
        }
    }
}

#[test]
fn memory_storage_edits_are_atomic_under_many_threads() {
    let storage = Arc::new(MemoryStorage::new());
    storage.create("a.md", "").unwrap();
    std::thread::scope(|scope| {
        for _ in 0..16 {
            let storage = Arc::clone(&storage);
            scope.spawn(move || {
                for _ in 0..200 {
                    modify_with(&*storage, "a.md", |c| Ok(format!("{c}."))).unwrap();
                }
            });
        }
    });
    assert_eq!(storage.read("a.md").unwrap().len(), 16 * 200, "a lost update would make this shorter");
}

#[test]
fn memory_storage_lets_exactly_one_of_many_creators_win() {
    let storage = Arc::new(MemoryStorage::new());
    let wins: usize = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let storage = Arc::clone(&storage);
                scope.spawn(move || storage.create("race.md", &format!("writer {i}")).is_ok())
            })
            .collect();
        handles.into_iter().map(|h| usize::from(h.join().unwrap())).sum()
    });
    assert_eq!(wins, 1);
}

#[test]
fn a_failing_closure_changes_nothing_and_a_missing_note_is_not_found() {
    let storage = MemoryStorage::new();
    storage.create("a.md", "keep").unwrap();
    assert!(modify_with(&storage, "a.md", |_| Err(Error::validation("no"))).is_err());
    assert_eq!(storage.read("a.md").unwrap(), "keep");
    assert!(
        matches!(modify_with(&storage, "nope.md", |c| Ok(c.to_owned())), Err(Error::NotFound(p)) if p == "nope.md")
    );
    assert!(storage.snapshot().len() == 1);
}

#[test]
fn memory_listing_does_not_hide_dot_files_unlike_disk_and_says_so() {
    // MemoryStorage only knows paths; hiding dot files is the disk's business. The model test avoids such paths.
    let storage = MemoryStorage::new();
    storage.insert("Cards/.hidden.md", "x");
    assert_eq!(storage.list_markdown("Cards").unwrap(), ["Cards/.hidden.md"]);
}

#[test]
fn storages_can_be_shared_behind_arc_and_box_and_references() {
    fn count(storage: &dyn Storage) -> usize {
        storage.list_markdown("").unwrap().len()
    }
    let memory = Arc::new(MemoryStorage::new());
    memory.insert("a.md", "");
    let boxed: Box<dyn Storage> = Box::new(MemoryStorage::new());
    boxed.create("b.md", "").unwrap();
    assert_eq!(count(&memory), 1);
    assert_eq!(count(&boxed), 1);
    assert_eq!(count(&&*memory), 1);
    let shared: Arc<dyn Storage> = memory;
    assert_eq!(shared.list_markdown("").unwrap(), ["a.md"]);
}
