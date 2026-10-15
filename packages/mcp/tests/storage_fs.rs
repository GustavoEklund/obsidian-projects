//! `FsStorage` against a real disk: the behavior the TypeScript `fs-storage.edge.test.ts` pins down, plus races between
//! threads and between real processes, which is where the TypeScript version had its bugs.
use oprojects_mcp::Error;
use oprojects_mcp::storage::{FsStorage, Storage, modify_with, pending_note_locks_under};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn vault() -> (TempDir, FsStorage) {
    let dir = tempfile::Builder::new().prefix("oprojects-fs-").tempdir().unwrap();
    fs::create_dir(dir.path().join(".obsidian")).unwrap();
    let storage = FsStorage::new(dir.path());
    (dir, storage)
}

fn on_disk(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

fn names(root: &Path, rel: &str) -> Vec<String> {
    let mut list: Vec<String> =
        fs::read_dir(root.join(rel)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    list.sort();
    list
}

fn append(suffix: &str) -> impl FnOnce(&str) -> oprojects_mcp::Result<String> + '_ {
    move |c| Ok(format!("{c}{suffix}"))
}

// --- create ---------------------------------------------------------------------------------------------------------

#[test]
fn create_writes_the_file_creating_every_missing_folder() {
    let (dir, s) = vault();
    s.create("Deep/Er/Folder/note.md", "hello").unwrap();
    assert_eq!(on_disk(dir.path(), "Deep/Er/Folder/note.md"), "hello");
}

#[test]
fn create_refuses_to_overwrite_and_names_the_path() {
    let (dir, s) = vault();
    s.create("a.md", "first").unwrap();
    let error = s.create("a.md", "second").unwrap_err();
    assert!(matches!(&error, Error::FileExists(p) if p == "a.md"));
    assert_eq!(error.to_string(), "File already exists: a.md");
    assert_eq!(on_disk(dir.path(), "a.md"), "first");
}

#[test]
fn create_over_an_existing_folder_is_file_exists_too() {
    let (_dir, s) = vault();
    s.create("Cards/a.md", "x").unwrap();
    assert!(matches!(s.create("Cards", "x"), Err(Error::FileExists(_))));
}

#[test]
fn create_where_a_parent_is_a_file_fails_with_an_io_error() {
    let (_dir, s) = vault();
    s.create("file", "i am a file").unwrap();
    assert!(matches!(s.create("file/inside.md", "x"), Err(Error::Io { .. })));
}

#[test]
fn exactly_one_of_many_threads_racing_for_a_path_wins() {
    let (dir, s) = vault();
    for round in 0..20 {
        let path = format!("race{round}.md");
        let barrier = std::sync::Barrier::new(12);
        let results: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..12)
                .map(|i| {
                    let (s, barrier, path) = (&s, &barrier, &path);
                    scope.spawn(move || {
                        barrier.wait();
                        s.create(path, &format!("writer {i}"))
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1, "round {round}");
        assert!(results.iter().filter_map(|r| r.as_ref().err()).all(|e| matches!(e, Error::FileExists(_))));
        assert!(on_disk(dir.path(), &path).starts_with("writer "));
    }
}

#[test]
fn unicode_names_empty_and_large_content_survive_byte_for_byte() {
    let (dir, s) = vault();
    let big = "línea larga ünïcode 日本語 🙂\r\n".repeat(20_000);
    s.create("日本語 note ✓.md", &big).unwrap();
    s.create("empty.md", "").unwrap();
    assert_eq!(on_disk(dir.path(), "日本語 note ✓.md"), big);
    assert_eq!(on_disk(dir.path(), "empty.md"), "");
    assert_eq!(s.read("日本語 note ✓.md").unwrap(), big);
    assert_eq!(s.read("empty.md").unwrap(), "");
}

// --- read / exists --------------------------------------------------------------------------------------------------

#[test]
fn reading_a_missing_file_is_not_found_and_names_it() {
    let (_dir, s) = vault();
    let error = s.read("nope.md").unwrap_err();
    assert!(matches!(&error, Error::NotFound(p) if p == "nope.md"));
    assert_eq!(error.to_string(), "nope.md not found");
}

#[test]
fn reading_a_folder_fails_with_the_underlying_io_error_not_not_found() {
    let (dir, s) = vault();
    fs::create_dir(dir.path().join("folder")).unwrap();
    assert!(matches!(s.read("folder"), Err(Error::Io { .. })));
}

#[test]
fn exists_is_true_for_files_and_folders_and_false_for_missing_paths() {
    let (_dir, s) = vault();
    s.create("Cards/a.md", "x").unwrap();
    assert!(s.exists("Cards/a.md"));
    assert!(s.exists("Cards"));
    assert!(!s.exists("Cards/b.md"));
}

#[test]
fn bytes_that_are_not_utf8_read_back_as_replacement_characters_like_node() {
    let (dir, s) = vault();
    fs::write(dir.path().join("latin1.md"), b"caf\xe9 ok").unwrap();
    assert_eq!(s.read("latin1.md").unwrap(), "caf\u{fffd} ok");
}

#[test]
fn a_bom_and_crlf_are_kept_exactly() {
    let (_dir, s) = vault();
    let content = "\u{feff}---\r\nkey: OP-1\r\n---\r\ncafé 日本語 🙂\r\n";
    s.create("a.md", content).unwrap();
    assert_eq!(s.read("a.md").unwrap(), content);
    assert_eq!(modify_with(&s, "a.md", |c| Ok(c.to_owned())).unwrap(), content);
    assert_eq!(s.read("a.md").unwrap(), content);
}

// --- path safety ----------------------------------------------------------------------------------------------------

#[test]
fn paths_that_climb_out_of_the_vault_are_refused_by_every_operation() {
    let (dir, s) = vault();
    let outside_name = format!("outside-{}.md", std::process::id());
    let parent = dir.path().parent().unwrap().to_owned();
    for rel in [
        format!("../{outside_name}"),
        format!("a/../../{outside_name}"),
        format!("a/b/../../../{outside_name}"),
        format!("./../{outside_name}"),
        format!("a//../../{outside_name}"),
        format!("a/./b/../../../{outside_name}"),
        "..".to_owned(),
        "../..".to_owned(),
    ] {
        let escapes = |e: Error| matches!(&e, Error::Validation(m) if m.contains("escapes the vault"));
        assert!(escapes(s.read(&rel).unwrap_err()), "read {rel}");
        assert!(escapes(s.create(&rel, "x").unwrap_err()), "create {rel}");
        assert!(escapes(modify_with(&s, &rel, |c| Ok(c.to_owned())).unwrap_err()), "modify {rel}");
        assert!(escapes(s.remove(&rel).unwrap_err()), "remove {rel}");
        assert!(escapes(s.list_markdown(&rel).unwrap_err()), "list {rel}");
        assert!(!s.exists(&rel), "exists {rel}");
    }
    assert!(!parent.join(&outside_name).exists(), "nothing was written outside the vault");
    assert!(!dir.path().join(".trash").exists() || names(dir.path(), ".trash").is_empty());
}

#[test]
fn a_leading_slash_is_relative_to_the_vault() {
    let (dir, s) = vault();
    s.create("/abs/inside.md", "x").unwrap();
    assert_eq!(on_disk(dir.path(), "abs/inside.md"), "x");
    assert!(s.exists("abs/inside.md"));
}

#[test]
fn a_path_that_leaves_the_vault_and_comes_straight_back_in_is_fine_like_in_node() {
    // `path.resolve` collapses `../<vault name>/` back to the vault, and the TypeScript only checks the result.
    let (dir, s) = vault();
    let name = dir.path().file_name().unwrap().to_string_lossy().into_owned();
    s.create(&format!("../{name}/back-inside.md"), "x").unwrap();
    assert_eq!(on_disk(dir.path(), "back-inside.md"), "x");
}

#[test]
fn backslashes_and_percent_escapes_are_ordinary_file_name_characters_on_unix() {
    let (dir, s) = vault();
    if cfg!(unix) {
        s.create("..\\x.md", "back").unwrap();
        s.create("%2e%2e/y.md", "pct").unwrap();
        assert_eq!(on_disk(dir.path(), "..\\x.md"), "back");
        assert_eq!(on_disk(dir.path(), "%2e%2e/y.md"), "pct");
    }
}

#[test]
fn a_path_with_a_nul_byte_is_an_error_not_a_panic() {
    let (_dir, s) = vault();
    assert!(s.read("a\0b.md").is_err());
    assert!(s.create("a\0b.md", "x").is_err());
    assert!(!s.exists("a\0b.md"));
}

#[test]
fn the_root_is_resolved_lexically() {
    let (dir, _s) = vault();
    assert_eq!(
        FsStorage::new(dir.path().join("x").join("..")).root(),
        dir.path().canonicalize().map(|_| dir.path()).unwrap()
    );
    let relative = FsStorage::new("some/relative/../vault");
    assert!(relative.root().is_absolute());
    assert!(relative.root().ends_with("some/vault"));
}

// --- list_markdown --------------------------------------------------------------------------------------------------

#[test]
fn listing_walks_folders_recursively_with_forward_slashes_in_ascending_order() {
    let (_dir, s) = vault();
    for p in ["Cards/b.md", "Cards/a.md", "Cards/sub/b.md", "Cards/sub/deeper/c.md"] {
        s.create(p, "").unwrap();
    }
    assert_eq!(
        s.list_markdown("Cards").unwrap(),
        ["Cards/a.md", "Cards/b.md", "Cards/sub/b.md", "Cards/sub/deeper/c.md"]
    );
}

#[test]
fn listing_skips_hidden_files_and_folders_temp_files_and_anything_not_markdown() {
    let (_dir, s) = vault();
    for p in [
        "Cards/a.md",
        "Cards/.hidden.md",
        "Cards/.git/inside.md",
        "Cards/readme.txt",
        "Cards/image.png",
        "Cards/noext",
        "Cards/upper.MD",
        "Cards/.a.md.123.1.tmp",
    ] {
        s.create(p, "").unwrap();
    }
    assert_eq!(s.list_markdown("Cards").unwrap(), ["Cards/a.md"]);
}

#[test]
fn listing_a_folder_that_does_not_exist_yet_is_an_empty_list() {
    let (_dir, s) = vault();
    assert!(s.list_markdown("Nope/Deeper").unwrap().is_empty());
}

#[test]
fn listing_the_whole_vault_still_skips_obsidian_and_trash() {
    let (dir, s) = vault();
    s.create("top.md", "").unwrap();
    s.create("Cards/a.md", "").unwrap();
    fs::create_dir(dir.path().join(".trash")).unwrap();
    fs::write(dir.path().join(".trash/gone.md"), "").unwrap();
    fs::write(dir.path().join(".obsidian/workspace.md"), "").unwrap();
    assert_eq!(s.list_markdown("").unwrap(), ["Cards/a.md", "top.md"]);
}

#[test]
fn listing_fails_rather_than_pretending_when_the_folder_is_a_file() {
    let (_dir, s) = vault();
    s.create("Cards", "i am a file").unwrap();
    assert!(matches!(s.list_markdown("Cards"), Err(Error::Io { .. })));
}

#[cfg(unix)]
#[test]
fn listing_does_not_follow_symbolic_links() {
    let (dir, s) = vault();
    s.create("Cards/real.md", "").unwrap();
    std::os::unix::fs::symlink(dir.path().join("Cards/real.md"), dir.path().join("Cards/link.md")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("Cards"), dir.path().join("Cards/loop")).unwrap();
    assert_eq!(s.list_markdown("Cards").unwrap(), ["Cards/real.md"]);
}

#[test]
fn a_trailing_slash_on_the_folder_gives_double_slashes_in_the_paths_like_the_typescript() {
    let (_dir, s) = vault();
    s.create("Cards/a.md", "").unwrap();
    let listed = s.list_markdown("Cards/").unwrap();
    assert_eq!(listed, ["Cards//a.md"]);
    assert_eq!(s.read(&listed[0]).unwrap(), ""); // and it still reads
}

#[test]
fn five_thousand_notes_list_correctly_and_fast() {
    let (dir, s) = vault();
    fs::create_dir(dir.path().join("Cards")).unwrap();
    for i in 0..5000 {
        fs::write(dir.path().join(format!("Cards/n{i:04}.md")), format!("# {i}")).unwrap();
    }
    fs::write(dir.path().join("Cards/.ignored.md"), "").unwrap();
    let started = std::time::Instant::now();
    let listed = s.list_markdown("Cards").unwrap();
    let elapsed = started.elapsed();
    assert_eq!(listed.len(), 5000);
    assert_eq!(listed.first().unwrap(), "Cards/n0000.md");
    assert_eq!(listed.last().unwrap(), "Cards/n4999.md");
    assert!(listed.windows(2).all(|w| w[0] < w[1]));
    assert!(elapsed.as_secs() < 5, "listing 5,000 notes took {elapsed:?}");
}

#[test]
fn file_names_that_are_not_utf8_do_not_break_the_listing() {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let (dir, s) = vault();
        s.create("Cards/ok.md", "").unwrap();
        let odd = std::ffi::OsStr::from_bytes(b"Cards/bad-\xff.md");
        fs::write(dir.path().join(odd), "").unwrap();
        let listed = s.list_markdown("Cards").unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.contains(&"Cards/ok.md".to_owned()));
    }
}

// --- modify ---------------------------------------------------------------------------------------------------------

#[test]
fn modify_returns_the_new_content_writes_it_and_hands_over_the_current_one() {
    let (dir, s) = vault();
    s.create("a.md", "one").unwrap();
    let mut seen = Vec::new();
    let out = s
        .modify("a.md", &mut |c| {
            seen.push(c.to_owned());
            Ok(format!("{c} two"))
        })
        .unwrap();
    assert_eq!(out, "one two");
    assert_eq!(seen, ["one"]);
    assert_eq!(on_disk(dir.path(), "a.md"), "one two");
}

#[test]
fn a_failing_callback_leaves_the_note_untouched_and_no_temp_file_behind() {
    let (dir, s) = vault();
    s.create("Cards/a.md", "keep me").unwrap();
    let error = modify_with(&s, "Cards/a.md", |_| Err(Error::Format("callback failed".into()))).unwrap_err();
    assert_eq!(error.to_string(), "callback failed");
    assert_eq!(on_disk(dir.path(), "Cards/a.md"), "keep me");
    assert_eq!(names(dir.path(), "Cards"), ["a.md"]);
}

#[test]
fn modifying_a_missing_note_is_not_found_and_creates_nothing() {
    let (dir, s) = vault();
    fs::create_dir(dir.path().join("Cards")).unwrap();
    assert!(matches!(modify_with(&s, "Cards/missing.md", append("x")), Err(Error::NotFound(_))));
    assert!(names(dir.path(), "Cards").is_empty());
}

#[test]
fn no_temp_files_are_left_after_a_burst_of_edits() {
    let (dir, s) = vault();
    s.create("Cards/a.md", "0").unwrap();
    std::thread::scope(|scope| {
        for _ in 0..25 {
            scope.spawn(|| modify_with(&s, "Cards/a.md", append(".")).unwrap());
        }
    });
    assert_eq!(names(dir.path(), "Cards"), ["a.md"]);
    assert_eq!(on_disk(dir.path(), "Cards/a.md").len(), 26);
}

#[test]
fn concurrent_edits_of_one_note_all_land_and_none_fails() {
    // The TypeScript lost updates here before it got a per-file queue.
    let (dir, s) = vault();
    s.create("Cards/a.md", "start").unwrap();
    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = ['A', 'B', 'C', 'D', 'E', 'F']
            .into_iter()
            .map(|letter| {
                let s = &s;
                scope.spawn(move || modify_with(s, "Cards/a.md", append(&letter.to_string())))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert!(results.iter().all(Result::is_ok));
    let end = on_disk(dir.path(), "Cards/a.md");
    assert!(end.starts_with("start"));
    let mut letters: Vec<char> = end[5..].chars().collect();
    letters.sort_unstable();
    assert_eq!(letters.into_iter().collect::<String>(), "ABCDEF");
}

#[test]
fn many_threads_appending_to_one_note_lose_nothing_even_through_separate_storage_values() {
    let (dir, _s) = vault();
    let root = dir.path().to_owned();
    FsStorage::new(&root).create("a.md", "").unwrap();
    std::thread::scope(|scope| {
        for t in 0..16 {
            let root = root.clone();
            scope.spawn(move || {
                let s = FsStorage::new(&root); // each thread has its own value over the same vault
                for n in 0..40 {
                    modify_with(&s, "a.md", append(&format!("t{t:02}n{n:02};"))).unwrap();
                }
            });
        }
    });
    let content = on_disk(dir.path(), "a.md");
    let entries: Vec<&str> = content.split_terminator(';').collect();
    assert_eq!(entries.len(), 16 * 40);
    let unique: BTreeSet<&&str> = entries.iter().collect();
    assert_eq!(unique.len(), 16 * 40, "no entry was lost or duplicated");
    for t in 0..16 {
        let mine: Vec<&&str> = entries.iter().filter(|e| e.starts_with(&format!("t{t:02}"))).collect();
        assert!(mine.windows(2).all(|w| w[0] < w[1]), "thread {t}'s edits ran in the order it made them");
    }
    assert_eq!(names(dir.path(), "."), [".obsidian", "a.md"]);
}

#[test]
fn readers_never_see_a_half_written_note_while_it_is_being_rewritten() {
    let (dir, s) = vault();
    s.create("a.md", "x").unwrap();
    let stop = std::sync::atomic::AtomicBool::new(false);
    std::thread::scope(|scope| {
        let reader = scope.spawn(|| {
            let mut reads = 0u32;
            let mut longest = 0;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let content = fs::read_to_string(dir.path().join("a.md")).unwrap();
                assert!(!content.is_empty(), "a reader saw an empty (truncated) note");
                assert!(content.chars().all(|c| c == 'x'), "a reader saw torn content");
                assert!(content.len() >= longest, "the note went backwards in time");
                longest = content.len();
                reads += 1;
            }
            reads
        });
        for _ in 0..300 {
            modify_with(&s, "a.md", |c| Ok(format!("{c}{}", "x".repeat(2000)))).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(reader.join().unwrap() > 0);
    });
}

#[test]
fn a_failed_edit_does_not_block_or_poison_the_edits_behind_it() {
    let (dir, s) = vault();
    s.create("a.md", "x").unwrap();
    assert!(modify_with(&s, "a.md", |_| Err(Error::Format("boom".into()))).is_err());
    modify_with(&s, "a.md", append("1")).unwrap();
    // a panicking callback poisons nothing either
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = modify_with(&s, "a.md", |_| -> oprojects_mcp::Result<String> { panic!("callback panicked") });
    }));
    assert!(panicked.is_err());
    modify_with(&s, "a.md", append("2")).unwrap();
    assert_eq!(on_disk(dir.path(), "a.md"), "x12");
    assert_eq!(pending_note_locks_under(dir.path()), 0);
}

#[test]
fn edits_of_different_notes_are_independent() {
    let (dir, s) = vault();
    for i in 0..20 {
        s.create(&format!("Cards/n{i}.md"), "x").unwrap();
    }
    std::thread::scope(|scope| {
        for i in 0..20 {
            let s = &s;
            scope.spawn(move || modify_with(s, &format!("Cards/n{i}.md"), append(&i.to_string())).unwrap());
        }
    });
    for i in 0..20 {
        assert_eq!(on_disk(dir.path(), &format!("Cards/n{i}.md")), format!("x{i}"));
    }
}

#[test]
fn the_per_note_locks_are_given_back_when_the_edits_are_done() {
    let (dir, s) = vault();
    s.create("a.md", "").unwrap();
    s.create("b.md", "").unwrap();
    std::thread::scope(|scope| {
        for n in 0..32 {
            let s = &s;
            scope.spawn(move || modify_with(s, if n % 2 == 0 { "a.md" } else { "b.md" }, append("."))).join().ok();
        }
    });
    assert_eq!(pending_note_locks_under(dir.path()), 0);
    // also after a failure
    let _ = modify_with(&s, "missing.md", append("."));
    assert_eq!(pending_note_locks_under(dir.path()), 0);
}

#[cfg(unix)]
#[test]
fn an_unwritable_folder_reports_the_error_leaves_the_folder_as_it_was_and_the_queue_usable() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, s) = vault();
    fs::create_dir(dir.path().join("Cards")).unwrap();
    s.create("Cards/a.md", "x").unwrap();
    fs::set_permissions(dir.path().join("Cards"), fs::Permissions::from_mode(0o500)).unwrap();
    let writable_anyway = fs::write(dir.path().join("Cards/probe"), "").is_ok(); // running as root
    let failure = modify_with(&s, "Cards/a.md", append("y"));
    fs::set_permissions(dir.path().join("Cards"), fs::Permissions::from_mode(0o700)).unwrap();
    if writable_anyway {
        let _ = fs::remove_file(dir.path().join("Cards/probe"));
        return;
    }
    assert!(matches!(failure, Err(Error::Io { .. })));
    assert_eq!(names(dir.path(), "Cards"), ["a.md"]);
    assert_eq!(on_disk(dir.path(), "Cards/a.md"), "x");
    assert_eq!(modify_with(&s, "Cards/a.md", append("z")).unwrap(), "xz");
}

#[test]
fn a_rename_that_fails_removes_the_temp_file_and_keeps_the_note() {
    // The callback swaps the note for a folder of the same name, so the final rename (file onto folder) must fail.
    let (dir, s) = vault();
    fs::create_dir(dir.path().join("Cards")).unwrap();
    s.create("Cards/a.md", "original").unwrap();
    let swap = dir.path().join("Cards/a.md");
    let result = modify_with(&s, "Cards/a.md", |c| {
        fs::remove_file(&swap).unwrap();
        fs::create_dir(&swap).unwrap();
        Ok(format!("{c} changed"))
    });
    assert!(matches!(result, Err(Error::Io { .. })));
    assert_eq!(names(dir.path(), "Cards"), ["a.md"], "no temp file is left behind");
    assert!(swap.is_dir());
    fs::remove_dir(&swap).unwrap();
    s.create("Cards/a.md", "again").unwrap();
    assert_eq!(modify_with(&s, "Cards/a.md", append("!")).unwrap(), "again!"); // the queue is not stuck
}

// --- remove (to .trash) ---------------------------------------------------------------------------------------------

#[test]
fn removing_moves_the_note_to_trash_keeping_its_content() {
    let (dir, s) = vault();
    s.create("Cards/OP-1.md", "precious").unwrap();
    s.remove("Cards/OP-1.md").unwrap();
    assert!(!s.exists("Cards/OP-1.md"));
    assert_eq!(on_disk(dir.path(), ".trash/OP-1.md"), "precious");
}

#[test]
fn removing_a_missing_note_is_not_found_and_leaves_no_placeholder_in_the_trash() {
    let (dir, s) = vault();
    assert!(matches!(s.remove("Cards/ghost.md"), Err(Error::NotFound(p)) if p == "Cards/ghost.md"));
    assert!(names(dir.path(), ".trash").is_empty());
}

#[test]
fn a_trashed_note_never_overwrites_an_earlier_one_of_the_same_name() {
    let (dir, s) = vault();
    for version in ["v1", "v2", "v3"] {
        s.create("Cards/same.md", version).unwrap();
        s.remove("Cards/same.md").unwrap();
    }
    let trashed = names(dir.path(), ".trash");
    assert_eq!(trashed.len(), 3);
    let mut contents: Vec<String> = trashed.iter().map(|n| on_disk(dir.path(), &format!(".trash/{n}"))).collect();
    contents.sort();
    assert_eq!(contents, ["v1", "v2", "v3"]);
    assert!(trashed.contains(&"same.md".to_owned()));
    assert!(trashed.iter().all(|n| n.ends_with(".md") && n.starts_with("same")));
}

#[test]
fn many_notes_trashed_in_the_same_millisecond_are_all_kept() {
    // The TypeScript used to name the fallback `name <timestamp>.md`: equal timestamps overwrote each other.
    let (dir, s) = vault();
    for i in 0..60 {
        s.create("Cards/same.md", &format!("v{i}")).unwrap();
        s.remove("Cards/same.md").unwrap();
    }
    let trashed = names(dir.path(), ".trash");
    assert_eq!(trashed.len(), 60);
    let contents: BTreeSet<String> = trashed.iter().map(|n| on_disk(dir.path(), &format!(".trash/{n}"))).collect();
    assert_eq!(contents.len(), 60, "every version is still there");
}

#[test]
fn notes_with_the_same_file_name_removed_at_the_same_time_from_different_folders_are_all_kept() {
    let (dir, s) = vault();
    for i in 0..16 {
        s.create(&format!("Folder{i}/x.md"), &format!("note {i}")).unwrap();
    }
    let barrier = std::sync::Barrier::new(16);
    std::thread::scope(|scope| {
        for i in 0..16 {
            let (s, barrier) = (&s, &barrier);
            scope.spawn(move || {
                barrier.wait();
                s.remove(&format!("Folder{i}/x.md")).unwrap();
            });
        }
    });
    let contents: BTreeSet<String> =
        names(dir.path(), ".trash").iter().map(|n| on_disk(dir.path(), &format!(".trash/{n}"))).collect();
    assert_eq!(contents.len(), 16);
    for i in 0..16 {
        assert!(contents.contains(&format!("note {i}")), "note {i} survived");
    }
}

#[test]
fn only_one_of_two_threads_removing_the_same_note_succeeds() {
    let (dir, s) = vault();
    for round in 0..30 {
        let path = format!("Cards/n{round}.md");
        s.create(&path, "x").unwrap();
        let barrier = std::sync::Barrier::new(4);
        let results: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    let (s, barrier, path) = (&s, &barrier, &path);
                    scope.spawn(move || {
                        barrier.wait();
                        s.remove(path)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1, "round {round}");
        assert!(results.iter().filter_map(|r| r.as_ref().err()).all(|e| matches!(e, Error::NotFound(_))));
    }
    // the losers left no placeholder behind: exactly one file per round
    assert_eq!(names(dir.path(), ".trash").len(), 30);
}

#[test]
fn trashing_keeps_notes_out_of_listings() {
    let (_dir, s) = vault();
    s.create("Cards/a.md", "").unwrap();
    s.create("Cards/b.md", "").unwrap();
    s.remove("Cards/a.md").unwrap();
    assert_eq!(s.list_markdown("Cards").unwrap(), ["Cards/b.md"]);
    assert_eq!(s.list_markdown("").unwrap(), ["Cards/b.md"]);
}

#[test]
fn trashed_names_keep_the_extension_and_dotted_names_split_like_node() {
    let (dir, s) = vault();
    for name in ["Cards/a.b.md", "Cards/noext"] {
        for n in 0..3 {
            s.create(name, &n.to_string()).unwrap();
            s.remove(name).unwrap();
        }
    }
    let trashed = names(dir.path(), ".trash");
    assert!(trashed.contains(&"a.b.md".to_owned()));
    assert!(trashed.contains(&"noext".to_owned()));
    assert_eq!(trashed.iter().filter(|n| n.starts_with("a.b ") && n.ends_with(".md")).count(), 2);
    assert_eq!(trashed.iter().filter(|n| n.starts_with("noext ") && !n.contains('.')).count(), 2);
}

#[test]
fn removing_works_for_unicode_names() {
    let (dir, s) = vault();
    s.create("Cards/日本語 ✓.md", "x").unwrap();
    s.remove("Cards/日本語 ✓.md").unwrap();
    assert_eq!(on_disk(dir.path(), ".trash/日本語 ✓.md"), "x");
}

#[test]
fn a_folder_can_be_removed_too_like_in_the_typescript_but_it_is_not_a_card() {
    // `remove` is a rename into the trash, so it moves a folder as readily as a note. Nothing in the server asks it to.
    let (dir, s) = vault();
    s.create("Gone/a.md", "x").unwrap();
    s.remove("Gone").unwrap();
    assert!(!s.exists("Gone"));
    assert_eq!(on_disk(dir.path(), ".trash/Gone/a.md"), "x");
}

// --- real processes ---------------------------------------------------------------------------------------------------
//
// These re-run this very test binary as child processes (the `child_*` tests below do nothing unless the environment
// asks them to), so the races are between operating-system processes, not just threads.

fn spawn_children(mode: &str, root: &Path, count: usize) -> Vec<std::process::Child> {
    (0..count)
        .map(|id| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "child_entry", "--nocapture", "--test-threads=1"])
                .env("OPROJECTS_STORAGE_CHILD", mode)
                .env("OPROJECTS_STORAGE_ROOT", root)
                .env("OPROJECTS_STORAGE_ID", id.to_string())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn a child")
        })
        .collect()
}

fn release_and_collect(root: &Path, children: Vec<std::process::Child>) -> Vec<i32> {
    fs::write(root.join(".go"), "").unwrap(); // the children spin until this file exists
    children.into_iter().map(|mut c| c.wait().unwrap().code().unwrap_or(-1)).collect()
}

#[test]
fn child_entry() {
    let Ok(mode) = std::env::var("OPROJECTS_STORAGE_CHILD") else { return };
    let root = std::path::PathBuf::from(std::env::var("OPROJECTS_STORAGE_ROOT").unwrap());
    let id = std::env::var("OPROJECTS_STORAGE_ID").unwrap();
    while !root.join(".go").exists() {
        std::thread::yield_now();
    }
    let s = FsStorage::new(&root);
    let code = match mode.as_str() {
        "create" => match s.create("race.md", &format!("writer {id}")) {
            Ok(()) => 0,
            Err(Error::FileExists(_)) => 10,
            Err(_) => 20,
        },
        "trash" => {
            let path = format!("Child{id}/x.md");
            s.create(&path, &format!("child {id}")).unwrap();
            match s.remove(&path) {
                Ok(()) => 0,
                Err(_) => 20,
            }
        }
        "modify" => {
            let mut failures = 0;
            for n in 0..60 {
                // each child owns its own note, so this measures the rename, not cross-process queueing
                if modify_with(&s, &format!("own{id}.md"), append(&format!("line {n}\n"))).is_err() {
                    failures += 1;
                }
            }
            failures
        }
        other => panic!("unknown child mode {other}"),
    };
    std::process::exit(code);
}

#[test]
fn exactly_one_of_many_processes_racing_to_create_a_note_wins() {
    for round in 0..5 {
        let (dir, _s) = vault();
        let children = spawn_children("create", dir.path(), 8);
        let codes = release_and_collect(dir.path(), children);
        assert_eq!(codes.iter().filter(|c| **c == 0).count(), 1, "round {round}: {codes:?}");
        assert_eq!(codes.iter().filter(|c| **c == 10).count(), 7, "round {round}: {codes:?}");
        assert!(on_disk(dir.path(), "race.md").starts_with("writer "));
    }
}

#[test]
fn processes_trashing_same_named_notes_at_the_same_time_lose_none() {
    for round in 0..4 {
        let (dir, _s) = vault();
        let children = spawn_children("trash", dir.path(), 8);
        let codes = release_and_collect(dir.path(), children);
        assert!(codes.iter().all(|c| *c == 0), "round {round}: {codes:?}");
        let contents: BTreeSet<String> =
            names(dir.path(), ".trash").iter().map(|n| on_disk(dir.path(), &format!(".trash/{n}"))).collect();
        assert_eq!(contents.len(), 8, "round {round}: a trashed note was overwritten");
    }
}

#[test]
fn processes_rewriting_their_own_notes_while_this_one_reads_never_expose_a_torn_file() {
    let (dir, s) = vault();
    for id in 0..4 {
        s.create(&format!("own{id}.md"), "").unwrap();
    }
    let children = spawn_children("modify", dir.path(), 4);
    fs::write(dir.path().join(".go"), "").unwrap();
    let mut running = children;
    let mut reads = 0;
    while running.iter_mut().any(|c| c.try_wait().unwrap().is_none()) {
        for id in 0..4 {
            let content = fs::read_to_string(dir.path().join(format!("own{id}.md"))).unwrap();
            assert!(content.is_empty() || content.ends_with('\n'), "a torn note was visible: {content:?}");
            assert!(content.lines().all(|l| l.starts_with("line ")));
            reads += 1;
        }
    }
    for mut c in running {
        assert_eq!(c.wait().unwrap().code(), Some(0));
    }
    assert!(reads > 0);
    for id in 0..4 {
        assert_eq!(on_disk(dir.path(), &format!("own{id}.md")).lines().count(), 60);
    }
    assert!(names(dir.path(), ".").iter().all(|n| !n.ends_with(".tmp")));
}
