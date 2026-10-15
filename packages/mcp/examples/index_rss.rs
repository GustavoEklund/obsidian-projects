//! Measures what the server costs to hold a vault: resident memory and the time of the questions an agent asks.
//!
//! ```text
//! cargo run --release --example index_rss -- generate 5000 /tmp/vault5000
//! cargo run --release --example index_rss -- measure /tmp/vault5000
//! ```
//!
//! Generating and measuring are separate processes on purpose: the generator's own allocations must not count.
use oprojects_mcp::api::{Board, CardQuery};
use oprojects_mcp::card::new_card_content;
use oprojects_mcp::types::{Card, CardType, Checklist, Comment, Priority};
use oprojects_mcp::vault::{VaultOptions, open_vault};
use std::path::Path;
use std::time::{Duration, Instant};

fn rss_mb() -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("VmRSS:"))
                .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<f64>().ok())
        })
        .map_or(f64::NAN, |kb| kb / 1024.0)
}

fn card(i: usize, ranks: &[String]) -> Card {
    let columns = ["todo", "doing", "review", "done"];
    let key = format!("OP-{i}");
    Card {
        path: format!("Cards/{key}.md"),
        title: format!("Card number {i}{} with a reasonably long title", if i.is_multiple_of(7) { " login redirect" } else { "" }),
        status: columns[i % 4].to_string(),
        card_type: CardType::Bug,
        priority: Priority::High,
        assignee: Some(["Ana", "Bruno", "Carla", "Diego"][i % 4].to_string()),
        labels: vec!["api".into(), if i.is_multiple_of(5) { "ux".into() } else { "backend".into() }],
        due: Some(format!("2026-11-{:02}", 1 + i % 28)),
        estimate: Some((1 + i % 8) as f64),
        parent: None,
        rank: ranks[i / 4].clone(),
        created: "2026-10-01T10:00:00.000Z".into(),
        updated: "2026-10-02T10:00:00.000Z".into(),
        resolved: None,
        checklist: Checklist { done: 1, total: 3 },
        body: "The user lands on the home page instead of the page they came from after signing in through the SSO redirect. "
            .repeat(5)
            + "\n\n- [x] Reproduce\n- [ ] Fix in the gateway\n- [ ] Regression test\n",
        comments: vec![
            Comment { id: format!("{key}a"), author: "Ana".into(), at: "2026-10-02T10:00:00.000Z".into(), text: "I can only reproduce it in Safari.".into() },
            Comment { id: format!("{key}b"), author: "Bruno".into(), at: "2026-10-03T10:00:00.000Z".into(), text: "Found it: the SSO redirect drops the query string.".into() },
        ],
        key,
    }
}

fn generate(count: usize, root: &Path) {
    std::fs::create_dir_all(root.join(".obsidian")).unwrap();
    std::fs::create_dir_all(root.join("Cards")).unwrap();
    let ranks = oprojects_mcp::rank::spread_ranks(count / 4 + 1);
    for i in 1..=count {
        let c = card(i, &ranks);
        std::fs::write(root.join(&c.path), new_card_content(&c, 0).unwrap()).unwrap();
    }
    println!("wrote {count} notes under {}", root.display());
}

fn timed<T>(label: &str, work: impl FnOnce() -> T) -> T {
    let began = Instant::now();
    let out = work();
    println!("{label:<34} {:>9.2} ms", began.elapsed().as_secs_f64() * 1000.0);
    out
}

fn measure(root: &Path) {
    let idle = rss_mb();
    println!("resident memory before opening      {idle:>9.1} MB");
    let board = timed("open_vault (returns at once)", || open_vault(root, VaultOptions::default()).unwrap());
    let index = board.index().unwrap();
    let began = Instant::now();
    assert!(index.wait_until_loaded(Duration::from_secs(120)));
    println!(
        "{:<34} {:>9.2} ms  ({} cards)",
        "first load (background)",
        began.elapsed().as_secs_f64() * 1000.0,
        index.len()
    );
    let loaded = rss_mb();
    println!("resident memory after the load      {loaded:>9.1} MB  (+{:.1})", loaded - idle);
    timed("list", || board.list().unwrap().len());
    timed("find status=doing", || {
        board.find(&CardQuery { status: vec!["doing".into()], ..CardQuery::default() }).unwrap().len()
    });
    let hits = timed("find text 'redirect gateway'", || {
        board.find(&CardQuery { text: Some("redirect gateway".into()), ..CardQuery::default() }).unwrap().len()
    });
    timed("find text again", || {
        board.find(&CardQuery { text: Some("redirect gateway".into()), ..CardQuery::default() }).unwrap().len()
    });
    timed("get OP-2", || board.get("OP-2").unwrap());
    let created = timed("create_card", || {
        board.create(oprojects_mcp::types::NewCardInput { title: "Measured".into(), ..Default::default() }).unwrap()
    });
    timed("update_card", || {
        board
            .update(
                &created.key,
                oprojects_mcp::types::CardPatch { title: Some("Measured twice".into()), ..Default::default() },
            )
            .unwrap()
    });
    let after = rss_mb();
    println!("resident memory after the queries   {after:>9.1} MB  (+{:.1} over idle, {hits} text hits)", after - idle);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["generate", count, dir] => generate(count.parse().expect("a number of notes"), Path::new(dir)),
        ["measure", dir] => measure(Path::new(dir)),
        _ => eprintln!("usage: index_rss generate <count> <dir> | index_rss measure <dir>"),
    }
}
