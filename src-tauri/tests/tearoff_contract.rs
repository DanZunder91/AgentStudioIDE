//! **Contract golden — the Rust half of the tab tear-off seam** (`src/tearoff.rs` ↔
//! `src/app/tearoff/contract.ts`; two 100%-covered halves do not add up to a working
//! feature).
//!
//! A torn-off tab is described by one realm, crosses Rust, and is rebuilt by another, so the
//! wire shape has TWO producers and TWO consumers. This file writes
//! `src/test/contract/goldens/tearoff.json` from values built by the real registry
//! (`Registry::open` / `send` / `claim` / `holdings`) and the real `TornTab::key`, serialised
//! exactly as Tauri serialises a command result — the typed structs, never a
//! `serde_json::Value`, which re-orders keys. The TS half
//! (`src/test/contract/tearoff.contract.test.ts`) feeds the same file through the page's
//! `tabKey`, its describer and its adopter. A rename, a new field or a changed spelling on
//! either side goes red on that side.
//!
//! It also proves the other direction here: every value in the golden DEserialises into the
//! Rust types and re-serialises byte for byte — so what the page sends is what Rust reads.
//!
//! Standalone rather than a module of `contract_goldens.rs`: that binary is `cfg(unix)` and
//! drives real proxies and PTYs; this one is pure data and runs everywhere.
//!
//! **Regenerate** after an intended contract change — then read the diff, and update the TS
//! side in the same change:
//!
//! ```text
//! UPDATE_GOLDENS=1 cargo test --manifest-path src-tauri/Cargo.toml --test tearoff_contract
//! ```

use std::path::PathBuf;

use agent_studio_scaffold_lib::tearoff::{
    Claim, EditorBuffer, Holding, Mail, Registry, Stamp, TornTab, MAIN,
};
use serde::{Deserialize, Serialize};

const GOLDEN: &str = "tearoff.json";
const REGEN: &str =
    "UPDATE_GOLDENS=1 cargo test --manifest-path src-tauri/Cargo.toml --test tearoff_contract";

/// A tab beside the key Rust derives for it — the TS side must derive the same.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct KeyedTab {
    tab: TornTab,
    key: String,
}

/// Everything that crosses: every tab kind with its key, every mail, a claim, the holdings.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Golden {
    tabs: Vec<KeyedTab>,
    mail: Vec<Mail>,
    claim: Claim,
    holdings: Vec<Holding>,
}

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/test/contract/goldens")
        .join(GOLDEN)
}

/// One of every kind, with every optional field exercised at least once each way.
fn every_tab() -> Vec<TornTab> {
    vec![
        TornTab::Terminal {
            terminal_id: "01J9TERM".into(),
            title: "gazelle".into(),
            custom_title: Some("build".into()),
        },
        TornTab::AgentTerminal {
            terminal_id: "01J9AGENT".into(),
            agent_id: "01J9AGENT".into(),
            title: "gazelle".into(),
            custom_title: None,
        },
        TornTab::Editor {
            path: "/Users/me/gazelle/src/main.rs".into(),
            title: "main.rs".into(),
            custom_title: None,
            buffer: Some(EditorBuffer {
                text: "fn main() {}\n// unsaved\n".into(),
                baseline: "fn main() {}\n".into(),
                // Opaque to Rust: a string, so its keys are never re-ordered.
                state: Some(
                    r#"{"doc":"fn main() {}\n// unsaved\n","history":{"done":[],"undone":[]}}"#
                        .into(),
                ),
                stamp: Some(Stamp {
                    mtime_ms: Some(1_760_000_000_000),
                    size: 13,
                }),
                stale: false,
            }),
        },
        TornTab::Editor {
            path: "/Users/me/gazelle/README.md".into(),
            title: "README.md".into(),
            custom_title: Some("notes".into()),
            // Still loading when it left: the receiver reads the file.
            buffer: None,
        },
        TornTab::Diff {
            path: "/Users/me/gazelle/src/main.rs".into(),
            title: "main.rs ↔ HEAD".into(),
        },
        TornTab::Metrics {
            cwd: Some("/Users/me/gazelle".into()),
        },
        TornTab::AgentLogs,
        TornTab::Network,
        TornTab::Village,
    ]
}

fn build() -> Golden {
    let tabs = every_tab();
    let keyed = tabs
        .iter()
        .cloned()
        .map(|tab| KeyedTab {
            key: tab.key(),
            tab,
        })
        .collect();

    // The real registry, driven through one realistic exchange: main tears two tabs into a
    // new window, the window reports an edit, then gives one back.
    let mut r = Registry::default();
    let window = r.open(MAIN, vec![tabs[0].clone(), tabs[2].clone()]);
    let _first_boot = r.claim(&window);
    r.report(&window, vec![tabs[0].clone(), tabs[2].clone()]);
    r.send(
        &window,
        MAIN,
        Mail::Adopt {
            tabs: vec![tabs[0].clone()],
        },
    )
    .expect("main is always live");
    let mail = vec![
        Mail::Adopt {
            tabs: vec![tabs[1].clone(), TornTab::Village],
        },
        Mail::Focus {
            key: "terminal:01J9AGENT".into(),
        },
        Mail::Close {
            key: "terminal:01J9AGENT".into(),
        },
        Mail::Dismissed {
            agent_id: "01J9AGENT".into(),
        },
        Mail::Give {
            tab_id: "tab-3f2a".into(),
            to: window.clone(),
        },
        Mail::Renamed {
            agent_id: "01J9AGENT".into(),
            name: Some("reviewer".into()),
        },
    ];
    // The window's reload recovery: what it holds, plus nothing posted since.
    let claim = r.claim(&window);
    Golden {
        tabs: keyed,
        mail,
        claim,
        holdings: r.holdings(),
    }
}

#[test]
fn tearoff_wire_matches_the_golden() {
    let golden = build();
    // Not a golden that is empty or degenerate by accident.
    assert_eq!(golden.tabs.len(), 9, "one of every kind");
    assert_eq!(golden.claim.tabs.len(), 1, "the window kept the editor");
    assert_eq!(golden.holdings.len(), 1);
    assert_eq!(
        golden.holdings[0].keys,
        vec!["editor:/Users/me/gazelle/src/main.rs"]
    );

    let actual = serde_json::to_string_pretty(&golden).expect("serialises") + "\n";
    let path = golden_path();
    if std::env::var("UPDATE_GOLDENS").is_ok_and(|v| v == "1") {
        std::fs::write(&path, &actual).expect("write golden");
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!(
            "missing golden {}; regenerate with: {REGEN}",
            path.display()
        )
    });
    assert_eq!(
        actual, expected,
        "the tear-off wire changed — regenerate with `{REGEN}`, read the diff, and update \
         src/app/tearoff/contract.ts in the same change"
    );
}

#[test]
fn every_value_in_the_golden_reads_back_byte_for_byte() {
    // The page sends these shapes; Rust must read exactly them.
    let text = std::fs::read_to_string(golden_path())
        .unwrap_or_else(|_| panic!("missing golden; regenerate with: {REGEN}"));
    let parsed: Golden =
        serde_json::from_str(&text).expect("the golden parses into the Rust types");
    assert_eq!(parsed, build());
    assert_eq!(serde_json::to_string_pretty(&parsed).unwrap() + "\n", text);
}
