//! Finding the vault and reading and writing the plugin's `data.json`, on a real file system.
use oprojects_mcp::Error;
use oprojects_mcp::config::{
    PLUGIN_DATA_PATH, PLUGIN_ID, find_vault_root, has_board_config, load_board_config, normalize_config, resolve_path,
    save_board_config, vault_from_env,
};
use oprojects_mcp::types::BoardConfig;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

fn make_vault(dir: &Path) {
    fs::create_dir_all(dir.join(".obsidian")).unwrap();
}

fn write_data(dir: &Path, content: &str) {
    let file = dir.join(PLUGIN_DATA_PATH);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, content).unwrap();
}

fn read_data(dir: &Path) -> String {
    fs::read_to_string(dir.join(PLUGIN_DATA_PATH)).unwrap()
}

/// A temp dir whose path has no symlinks in it (macOS `/tmp` is one), so path comparisons are exact. On Windows
/// `canonicalize` gives the `\\?\C:\...` form, which no path the program works with has, so the path is used as it is.
fn temp() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(not(windows))]
    let root = dir.path().canonicalize().unwrap();
    #[cfg(windows)]
    let root = dir.path().to_path_buf();
    (dir, root)
}

/// `to` written relative to `from`, or `None` when they do not share a root (two Windows drives).
fn relative_path(from: &Path, to: &Path) -> Option<PathBuf> {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    if common == 0 {
        return None;
    }
    let mut relative = PathBuf::new();
    for _ in common..from.len() {
        relative.push("..");
    }
    for part in &to[common..] {
        relative.push(part.as_os_str());
    }
    Some(relative)
}

#[test]
fn the_plugin_constants_keep_the_data_file_where_obsidian_puts_a_plugin_with_this_id() {
    assert_eq!(PLUGIN_ID, "obsidian-projects");
    assert_eq!(PLUGIN_DATA_PATH, ".obsidian/plugins/obsidian-projects/data.json");
}

mod find_vault_root_tests {
    use super::*;

    #[test]
    fn an_explicit_vault_wins_and_relative_paths_resolve_lexically() {
        let (_keep, root) = temp();
        make_vault(&root);
        assert_eq!(find_vault_root(Path::new("/somewhere/else"), Some(root.to_str().unwrap())).unwrap(), root);
        let dotted = root.join("sub").join("..");
        assert_eq!(find_vault_root(Path::new("/somewhere/else"), Some(dotted.to_str().unwrap())).unwrap(), root);
        // A relative path is resolved against the working directory.
        let cwd = std::env::current_dir().unwrap();
        match relative_path(&cwd, &root) {
            Some(relative) => {
                assert_eq!(find_vault_root(Path::new("/"), Some(relative.to_str().unwrap())).unwrap(), root);
            }
            None => eprintln!("skipped the relative path: the temp folder and the working directory share no root"),
        }
    }

    #[test]
    fn relative_path_helper_goes_up_and_down() {
        assert_eq!(relative_path(Path::new("/a/b/c"), Path::new("/a/x/y")).unwrap(), Path::new("../../x/y"));
        assert_eq!(relative_path(Path::new("/a"), Path::new("/a/b")).unwrap(), Path::new("b"));
        assert_eq!(relative_path(Path::new("/a/b"), Path::new("/a")).unwrap(), Path::new(".."));
    }

    #[test]
    fn an_explicit_folder_that_is_not_a_vault_is_rejected_by_name() {
        let (_keep, root) = temp();
        let err = find_vault_root(&root, Some(root.to_str().unwrap())).unwrap_err();
        assert!(matches!(err, Error::VaultNotFound(_)));
        let message = err.to_string();
        assert!(message.contains(root.to_str().unwrap()) && message.contains("no .obsidian folder"), "{message}");
    }

    #[test]
    fn an_explicit_folder_that_does_not_exist_is_rejected() {
        let (_keep, root) = temp();
        let missing = root.join("missing");
        assert!(matches!(find_vault_root(&root, Some(missing.to_str().unwrap())), Err(Error::VaultNotFound(_))));
    }

    #[test]
    fn the_start_never_overrides_an_explicit_vault_even_inside_another_vault() {
        let (_keep, root) = temp();
        let (other, chosen) = (root.join("other"), root.join("chosen"));
        make_vault(&other);
        make_vault(&chosen);
        assert_eq!(find_vault_root(&other, Some(chosen.to_str().unwrap())).unwrap(), chosen);
    }

    #[test]
    fn an_empty_explicit_value_means_none() {
        let (_keep, root) = temp();
        make_vault(&root);
        assert_eq!(find_vault_root(&root, Some("")).unwrap(), root);
    }

    #[test]
    fn walks_up_from_a_nested_folder_to_the_nearest_vault() {
        let (_keep, root) = temp();
        make_vault(&root);
        let deep = root.join("a/b/c");
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(find_vault_root(&deep, None).unwrap(), root);
        assert_eq!(find_vault_root(&root, None).unwrap(), root);
    }

    #[test]
    fn prefers_the_nearest_vault_when_vaults_are_nested() {
        let (_keep, root) = temp();
        let inner = root.join("work/inner");
        make_vault(&root);
        make_vault(&inner);
        let start = inner.join("notes");
        fs::create_dir_all(&start).unwrap();
        assert_eq!(find_vault_root(&start, None).unwrap(), inner);
    }

    #[test]
    fn an_obsidian_that_is_a_file_is_ignored_and_the_walk_continues() {
        let (_keep, root) = temp();
        make_vault(&root);
        let fake = root.join("fake");
        fs::create_dir(&fake).unwrap();
        fs::write(fake.join(".obsidian"), "not a folder").unwrap();
        assert_eq!(find_vault_root(&fake, None).unwrap(), root);
    }

    #[cfg(unix)]
    #[test]
    fn an_obsidian_that_is_a_symlink_to_a_folder_counts() {
        let (_keep, root) = temp();
        let real = root.join("real-obsidian");
        fs::create_dir(&real).unwrap();
        let vault = root.join("vault");
        fs::create_dir(&vault).unwrap();
        std::os::unix::fs::symlink(&real, vault.join(".obsidian")).unwrap();
        assert_eq!(find_vault_root(&vault, None).unwrap(), vault);
    }

    #[test]
    fn dot_dot_segments_are_resolved_before_walking_up() {
        let (_keep, root) = temp();
        make_vault(&root);
        let tricky = root.join("a/../a/./b");
        fs::create_dir_all(root.join("a/b")).unwrap();
        assert_eq!(find_vault_root(&tricky, None).unwrap(), root);
    }

    #[test]
    fn says_how_to_point_at_a_vault_when_there_is_none() {
        // The temp dir is inside no vault (unless the machine has an .obsidian at / or in /tmp: skip then).
        let (_keep, root) = temp();
        if find_vault_root(&root, None).is_ok() {
            return;
        }
        let message = find_vault_root(&root, None).unwrap_err().to_string();
        assert!(message.contains("--vault") && message.contains("OPROJECTS_VAULT"), "{message}");
    }
}

#[test]
fn resolve_path_is_lexical_and_absolute() {
    #[cfg(unix)]
    {
        assert_eq!(resolve_path(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
        assert_eq!(resolve_path(Path::new("/a//b")), PathBuf::from("/a/b"));
        assert_eq!(resolve_path(Path::new("/../..")), PathBuf::from("/"));
    }
    // On Windows a path is rooted by a drive, and `..` stops at the root.
    #[cfg(windows)]
    {
        assert_eq!(resolve_path(Path::new(r"C:\a\b\..\c\.\d")), PathBuf::from(r"C:\a\c\d"));
        assert_eq!(resolve_path(Path::new(r"C:\a\\b")), PathBuf::from(r"C:\a\b"));
        assert_eq!(resolve_path(Path::new(r"C:\..\..")), PathBuf::from(r"C:\"));
    }
    assert!(resolve_path(Path::new("relative")).is_absolute());
    assert!(resolve_path(Path::new("relative")).ends_with("relative"));
}

#[test]
fn the_env_helper_ignores_an_empty_value() {
    // Only reads the environment; setting it would race with other tests, so assert the shape of the answer.
    if let Some(value) = vault_from_env() {
        assert!(!value.is_empty());
    }
}

mod load_board_config_tests {
    use super::*;

    #[test]
    fn defaults_when_there_is_no_data_file() {
        let (_keep, root) = temp();
        make_vault(&root);
        assert_eq!(load_board_config(&root), BoardConfig::default());
        assert!(!has_board_config(&root));
    }

    #[test]
    fn defaults_for_unusable_data() {
        let (_keep, root) = temp();
        for content in [
            "",
            "{ \"board\": ",
            "null",
            "42",
            "\"board\"",
            "[1, 2, 3]",
            "{ \"version\": 1 }",
            "{ \"board\": null }",
            "{ \"board\": \"nope\" }",
            "\u{feff}{ \"board\": { \"prefix\": \"BOM\" } }",
        ] {
            write_data(&root, content);
            assert_eq!(load_board_config(&root), BoardConfig::default(), "for {content:?}");
        }
    }

    #[test]
    fn data_that_is_not_utf8_is_treated_as_missing() {
        let (_keep, root) = temp();
        let file = root.join(PLUGIN_DATA_PATH);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(load_board_config(&root), BoardConfig::default());
    }

    #[test]
    fn a_hand_edited_board_is_normalised_field_by_field() {
        let (_keep, root) = temp();
        write_data(
            &root,
            &json!({"version": 1, "board": {
                "prefix": "web", "folder": "../../Work\\Board/", "me": " Ana ", "hideDoneAfterDays": -5,
                "columns": [
                    {"id": "Backlog!", "name": "Backlog"}, {"id": "backlog", "name": "dup"},
                    {"id": "done", "name": "Done", "done": true, "wip": "x"}
                ],
                "members": ["Ana", "Ana", 7]
            }})
            .to_string(),
        );
        let config = load_board_config(&root);
        assert_eq!(config.prefix, "WEB");
        assert_eq!(config.folder, "Work/Board");
        assert_eq!(config.me, "Ana");
        assert_eq!(config.hide_done_after_days, 14);
        assert_eq!(config.members, ["Ana"]);
        let columns: Vec<(&str, &str, bool)> =
            config.columns.iter().map(|c| (c.id.as_str(), c.name.as_str(), c.done)).collect();
        assert_eq!(columns, [("backlog", "Backlog", false), ("done", "Done", true)]);
    }

    #[test]
    fn crlf_is_fine_json_and_a_bom_is_not() {
        let (_keep, root) = temp();
        write_data(&root, "{\r\n  \"board\": { \"prefix\": \"CRLF\" }\r\n}\r\n");
        assert_eq!(load_board_config(&root).prefix, "CRLF");
    }

    #[test]
    fn has_board_config_is_true_only_with_a_board_key() {
        let (_keep, root) = temp();
        make_vault(&root);
        assert!(!has_board_config(&root));
        for (content, expected) in [
            ("{ \"version\": 1 }", false),
            ("garbage", false),
            ("[1]", false),
            ("{ \"board\": {} }", true),
            ("{ \"board\": null }", true),
        ] {
            write_data(&root, content);
            assert_eq!(has_board_config(&root), expected, "for {content}");
        }
    }
}

mod save_board_config_tests {
    use super::*;

    #[test]
    fn creates_the_plugin_folder_and_writes_pretty_json_ending_with_a_newline() {
        let (_keep, root) = temp();
        make_vault(&root);
        let config = normalize_config(&json!({"prefix": "SAVE", "me": "Ana"}));
        save_board_config(&root, &config).unwrap();
        let text = read_data(&root);
        assert!(text.ends_with("}\n"));
        assert!(text.contains("\n  \"board\": {"), "{text}");
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({"board": config}));
    }

    #[test]
    fn keeps_every_other_setting_in_place_and_in_order() {
        let (_keep, root) = temp();
        write_data(&root, r#"{ "version": 1, "ui": { "drawerWidth": 480 }, "board": { "prefix": "OLD" }, "z": true }"#);
        save_board_config(&root, &normalize_config(&json!({"prefix": "NEW"}))).unwrap();
        let data: Value = serde_json::from_str(&read_data(&root)).unwrap();
        let keys: Vec<&str> = data.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["version", "ui", "board", "z"], "board stays where it was");
        assert_eq!(data["ui"], json!({"drawerWidth": 480}));
        assert_eq!(data["board"]["prefix"], "NEW");
    }

    #[test]
    fn a_new_board_key_goes_last() {
        let (_keep, root) = temp();
        write_data(&root, r#"{ "version": 1, "ui": {} }"#);
        save_board_config(&root, &BoardConfig::default()).unwrap();
        let data: Value = serde_json::from_str(&read_data(&root)).unwrap();
        assert_eq!(
            data.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
            ["version", "ui", "board"]
        );
    }

    #[test]
    fn replaces_a_corrupt_data_file_instead_of_failing() {
        let (_keep, root) = temp();
        write_data(&root, "{ not json");
        save_board_config(&root, &normalize_config(&json!({"prefix": "FIX"}))).unwrap();
        assert_eq!(load_board_config(&root).prefix, "FIX");
    }

    #[test]
    fn an_array_in_the_file_is_spread_like_javascript_does() {
        let (_keep, root) = temp();
        write_data(&root, "[10, 20]");
        save_board_config(&root, &BoardConfig::default()).unwrap();
        let data: Value = serde_json::from_str(&read_data(&root)).unwrap();
        assert_eq!(data["0"], 10);
        assert_eq!(data["1"], 20);
        assert!(data["board"].is_object());
    }

    #[test]
    fn round_trips_and_is_idempotent() {
        let (_keep, root) = temp();
        let config = normalize_config(&json!({
            "prefix": "RT", "folder": "Deep/Folder", "me": "Zoë", "hideDoneAfterDays": 0, "members": ["Zoë", "Bruno"],
            "columns": [{"id": "a", "name": "A", "wip": 2}, {"id": "z", "name": "Z", "done": true}]
        }));
        save_board_config(&root, &config).unwrap();
        assert_eq!(load_board_config(&root), config);
        assert!(has_board_config(&root));
        let first = read_data(&root);
        save_board_config(&root, &config).unwrap();
        assert_eq!(read_data(&root), first);
    }

    #[test]
    fn leaves_no_temporary_file_behind() {
        let (_keep, root) = temp();
        save_board_config(&root, &BoardConfig::default()).unwrap();
        let folder = root.join(PLUGIN_DATA_PATH).parent().unwrap().to_path_buf();
        let names: Vec<String> =
            fs::read_dir(folder).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["data.json"]);
    }

    #[test]
    fn writes_unicode_as_is_like_json_stringify() {
        let (_keep, root) = temp();
        save_board_config(&root, &normalize_config(&json!({"me": "Zoë 日本 🙂"}))).unwrap();
        assert!(read_data(&root).contains("\"me\": \"Zoë 日本 🙂\""));
    }
}
