//! The dispatcher: a request is parsed, routed to its tool, validated and answered; events carry
//! the asking terminal.
use super::*;
use std::sync::{Arc, Mutex};

/// A UI sink that records what it was told.
#[derive(Default)]
pub(crate) struct Recorder(pub Mutex<Vec<CtlEvent>>);

impl UiSink for Recorder {
    fn emit(&self, event: CtlEvent) {
        self.0.lock().unwrap().push(event);
    }
}

pub(crate) fn ctx(dir: &std::path::Path, terminal: &str) -> (ToolCtx, Arc<Recorder>) {
    let rec = Arc::new(Recorder::default());
    (
        ToolCtx {
            dir: dir.to_path_buf(),
            terminal_id: terminal.to_string(),
            ui: rec.clone(),
        },
        rec,
    )
}

fn temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("agentstudio-ctl-{}", ulid::Ulid::new()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn a_request_is_routed_validated_and_answered() {
    let dir = temp_dir();
    let (c, _) = ctx(&dir, "t1");

    let (status, r) = handle(c.clone(), b"{not json").await;
    assert_eq!(status, 400);
    assert!(!r.ok);

    let (status, r) = handle(c.clone(), br#"{"tool":"no_such_tool"}"#).await;
    assert_eq!(status, 404);
    assert!(r.message.contains("agent-studio help"), "{}", r.message);

    let (status, r) = handle(c.clone(), br#"{"tool":"db_connect","args":{}}"#).await;
    assert_eq!(status, 422);
    assert!(r.message.contains("needs `url`"), "{}", r.message);

    let (status, r) = handle(c.clone(), br#"{"tool":"db_list"}"#).await;
    assert_eq!(status, 200, "{}", r.message);
    assert!(r.ok);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_event_flattens_its_payload_beside_kind_and_terminal() {
    let rec = Arc::new(Recorder::default());
    let c = ToolCtx {
        dir: std::env::temp_dir(),
        terminal_id: "t9".into(),
        ui: rec.clone(),
    };
    c.emit(
        "dbConnection",
        serde_json::json!({"connectionId": "c1", "created": true}),
    );
    c.emit("ping", serde_json::Value::Null);
    c.emit("raw", serde_json::json!(5));
    let events = rec.0.lock().unwrap().clone();
    assert_eq!(
        serde_json::to_value(&events[0]).unwrap(),
        serde_json::json!({
            "kind": "dbConnection", "terminalId": "t9", "connectionId": "c1", "created": true
        })
    );
    assert_eq!(
        serde_json::to_value(&events[1]).unwrap(),
        serde_json::json!({"kind": "ping", "terminalId": "t9"})
    );
    assert_eq!(events[2].payload["value"], 5);
}

#[test]
fn the_wire_request_is_a_tool_name_and_its_arguments() {
    let call: CtlCall = serde_json::from_str(r#"{"tool":"db_list"}"#).unwrap();
    assert_eq!(call.tool, "db_list");
    assert!(call.args.is_empty());
}
