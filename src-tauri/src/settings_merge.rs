//! Merges our hook into a project's Claude `settings.local.json`: preserve all user content,
//! never clobber an unparseable file, idempotent per event (back-fill events an older install
//! lacks), and rewrite only our marked hook's `command` in place when it changed.

use serde_json::Value;

/// What the caller should do with the result.
#[derive(Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    /// Write this content to the settings file.
    Write(String),
    /// Our hook is already installed — do nothing.
    AlreadyPresent,
    /// The existing file could not be parsed as a JSON object — do nothing, so the
    /// user's file is never destroyed.
    SkipMalformed,
}

/// Merge `additions` (`{ "hooks": { "<Event>": [entry, …] } }`) into `existing`; `marker` is a
/// substring of our hook command that identifies it as ours.
pub fn merge_hook_settings(
    existing: Option<&str>,
    additions: &Value,
    marker: &str,
) -> MergeOutcome {
    // Start from the existing object, or an empty one for a fresh file.
    let mut root = match existing.map(str::trim) {
        None | Some("") => Value::Object(serde_json::Map::new()),
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => Value::Object(map),
            // Valid JSON but not an object, or not JSON at all: refuse to clobber.
            _ => return MergeOutcome::SkipMalformed,
        },
    };

    // Ensure `root.hooks` is an object we can extend.
    let root_map = root
        .as_object_mut()
        .expect("root is an object by construction");
    let hooks = root_map
        .entry("hooks")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(hooks) = hooks.as_object_mut() else {
        // `hooks` exists but isn't an object — unexpected shape, don't touch it.
        return MergeOutcome::SkipMalformed;
    };

    // Append each of our entries under its event, preserving existing entries.
    let Some(additions_hooks) = additions.get("hooks").and_then(Value::as_object) else {
        // Nothing to add (shouldn't happen for a real adapter) — leave as-is.
        return MergeOutcome::AlreadyPresent;
    };
    // Append only to events without OUR marker; `changed` separates `AlreadyPresent` (no
    // rewrite) from a partial install upgraded in place.
    let mut changed = false;
    for (event, entries) in additions_hooks {
        let Some(entries) = entries.as_array() else {
            continue;
        };
        let slot = hooks
            .entry(event.clone())
            .or_insert_with(|| Value::Array(Vec::new()));
        let Some(arr) = slot.as_array_mut() else {
            // The user's `hooks.<event>` is not an array — don't reshape it.
            return MergeOutcome::SkipMalformed;
        };
        // Our hook already lives under this event? Leave it — no duplicate.
        let ours_present = arr.iter().any(|e| {
            serde_json::to_string(e)
                .map(|s| s.contains(marker))
                .unwrap_or(false)
        });
        if ours_present {
            // Rule 4: rewrite a stale copy of our command to the current one.
            if let Some(current) = marker_command(entries, marker) {
                for entry in arr.iter_mut() {
                    changed |= upgrade_command(entry, marker, &current);
                }
            }
            continue;
        }
        for entry in entries {
            arr.push(entry.clone());
            changed = true;
        }
    }

    if !changed {
        return MergeOutcome::AlreadyPresent;
    }

    match serde_json::to_string_pretty(&root) {
        Ok(s) => MergeOutcome::Write(s),
        Err(_) => MergeOutcome::SkipMalformed,
    }
}

/// The first `hooks[].command` in `entries` that contains `marker` — the command we install.
fn marker_command(entries: &[Value], marker: &str) -> Option<String> {
    entries
        .iter()
        .filter_map(|e| e.get("hooks")?.as_array())
        .flatten()
        .filter_map(|h| h.get("command")?.as_str())
        .find(|c| c.contains(marker))
        .map(str::to_string)
}

/// Set every marker-bearing `hooks[].command` inside `entry` to `current`. True if one changed.
fn upgrade_command(entry: &mut Value, marker: &str, current: &str) -> bool {
    let Some(hooks) = entry.get_mut("hooks").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for h in hooks {
        let Some(cmd) = h.get_mut("command") else {
            continue;
        };
        if cmd
            .as_str()
            .is_some_and(|c| c.contains(marker) && c != current)
        {
            *cmd = Value::String(current.to_string());
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Rule 4 against the REAL adapter content (a command without `--noproxy '*'`).
    /// Pure: no file I/O, so `~/.claude` cannot be touched.
    #[test]
    fn an_old_hook_command_install_is_upgraded_in_place_idempotently() {
        use crate::agent::adapter::AgentAdapter as _;
        let adapter = crate::agent::claude::ClaudeAdapter::new();
        let additions = adapter.ad_hoc_hook_settings().unwrap();
        let marker = adapter.hook_marker().unwrap();
        let current =
            |e: &str| marker_command(additions["hooks"][e].as_array().unwrap(), marker).unwrap();
        assert!(current("Stop").contains("--noproxy '*'"));
        // The command exactly as older builds (before `--noproxy`) wrote it.
        let old =
            "[ -n \"$AGENTSTUDIO_HOOK_URL\" ] && curl -sS -m 3 -X POST \"$AGENTSTUDIO_HOOK_URL\" \
                   -H \"X-AgentStudio-Token: $AGENTSTUDIO_HOOK_TOKEN\" \
                   -H \"X-AgentStudio-Terminal: $AGENTSTUDIO_TERMINAL_ID\" \
                   --data-binary @- >/dev/null 2>&1 || true  # agentstudio-hook";
        let events = [
            "SessionStart",
            "SessionEnd",
            "UserPromptSubmit",
            "Stop",
            "Notification",
        ];
        let mut hooks = serde_json::Map::new();
        for e in events {
            hooks.insert(
                e.into(),
                json!([{"matcher": "", "hooks": [{"type": "command", "command": old}]}]),
            );
        }
        hooks.insert(
            "PreToolUse".into(),
            json!([{"hooks": [{"type": "command", "command": "echo user"}]}]),
        );
        let existing = json!({"permissions": {"allow": ["Bash"]}, "hooks": hooks}).to_string();

        let MergeOutcome::Write(up) = merge_hook_settings(Some(&existing), &additions, marker)
        else {
            panic!("an old command must be upgraded");
        };
        let v: Value = serde_json::from_str(&up).unwrap();
        for e in events {
            let arr = v["hooks"][e].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{e}: upgraded in place, not duplicated");
            assert_eq!(arr[0]["hooks"][0]["command"], current(e).as_str(), "{e}");
            assert_eq!(arr[0]["matcher"], "", "{e}: the entry's other keys survive");
        }
        assert_eq!(
            v["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "echo user"
        );
        assert_eq!(v["permissions"]["allow"][0], "Bash");
        assert!(!up.contains("curl -sS -m 3"), "no stale copy left: {up}");
        assert_eq!(
            merge_hook_settings(Some(&up), &additions, marker),
            MergeOutcome::AlreadyPresent,
            "idempotent once upgraded"
        );
    }

    /// Against the REAL adapter content: only SessionStart changes, the other events stay
    /// byte-for-byte. Pure: no file I/O, so `~/.claude` cannot be touched.
    #[test]
    fn an_install_without_the_session_start_context_is_upgraded_in_place() {
        use crate::agent::adapter::AgentAdapter as _;
        let adapter = crate::agent::claude::ClaudeAdapter::new();
        let additions = adapter.ad_hoc_hook_settings().unwrap();
        let marker = adapter.hook_marker().unwrap();
        let cmd_of =
            |e: &str| marker_command(additions["hooks"][e].as_array().unwrap(), marker).unwrap();
        let plain = cmd_of("Stop");
        let start = cmd_of("SessionStart");
        assert_ne!(plain, start);
        assert!(start.contains("additionalContext"), "{start}");
        // The file an older build wrote: the plain command on every event.
        let events = [
            "SessionStart",
            "SessionEnd",
            "UserPromptSubmit",
            "Stop",
            "Notification",
        ];
        let mut hooks = serde_json::Map::new();
        for e in events {
            hooks.insert(
                e.into(),
                json!([{"hooks": [{"type": "command", "command": plain}]}]),
            );
        }
        let existing = json!({ "hooks": hooks });
        let MergeOutcome::Write(up) =
            merge_hook_settings(Some(&existing.to_string()), &additions, marker)
        else {
            panic!("the SessionStart command must be upgraded");
        };
        let v: Value = serde_json::from_str(&up).unwrap();
        assert_eq!(v["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
        assert_eq!(
            v["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            start.as_str()
        );
        for e in &events[1..] {
            assert_eq!(v["hooks"][e], existing["hooks"][e], "{e} untouched");
        }
        assert_eq!(
            merge_hook_settings(Some(&up), &additions, marker),
            MergeOutcome::AlreadyPresent
        );
    }

    /// A user's hook that does not carry our marker is never rewritten, even under an event
    /// whose (marker-bearing) entry we upgrade.
    #[test]
    fn the_upgrade_touches_only_our_hook_object() {
        let existing = json!({"hooks": {"SessionStart": [
            {"hooks": [
                {"type": "command", "command": "echo mine"},
                {"type": "command", "command": "curl old # my-marker"}
            ]}
        ]}});
        let out = merge_hook_settings(Some(&existing.to_string()), &additions(), "my-marker");
        let MergeOutcome::Write(s) = out else {
            panic!("{out:?}");
        };
        let v: Value = serde_json::from_str(&s).unwrap();
        let hooks = v["hooks"]["SessionStart"][0]["hooks"].as_array().unwrap();
        assert_eq!(hooks[0]["command"], "echo mine");
        assert_eq!(hooks[1]["command"], "curl … # my-marker");
        assert_eq!(v["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
    }

    fn additions() -> Value {
        json!({
            "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
                "SessionEnd":   [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
            }
        })
    }

    /// A fresh workspace: our hook is written for both events.
    #[test]
    fn writes_into_an_empty_file() {
        let out = merge_hook_settings(None, &additions(), "my-marker");
        let MergeOutcome::Write(s) = out else {
            panic!("expected a write, got {out:?}");
        };
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
        assert_eq!(v["hooks"]["SessionEnd"].as_array().unwrap().len(), 1);
        assert!(s.contains("my-marker"));
    }

    /// **Idempotent**: installing again is a no-op — no duplicate hooks accrue.
    #[test]
    fn is_idempotent_when_our_marker_is_present() {
        let first = match merge_hook_settings(None, &additions(), "my-marker") {
            MergeOutcome::Write(s) => s,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            merge_hook_settings(Some(&first), &additions(), "my-marker"),
            MergeOutcome::AlreadyPresent
        );
    }

    /// A whole-file marker check would call an older install "already installed" and strand it
    /// without the new events (agents stuck on Running).
    #[test]
    fn backfills_new_events_into_an_older_install() {
        let old = match merge_hook_settings(None, &additions(), "my-marker") {
            MergeOutcome::Write(s) => s,
            other => panic!("{other:?}"),
        };
        // A newer build that also installs `Stop`.
        let newer = json!({
            "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
                "SessionEnd":   [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
                "Stop":         [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
            }
        });
        let out = merge_hook_settings(Some(&old), &newer, "my-marker");
        let MergeOutcome::Write(s) = out else {
            panic!("expected an upgrade write, got {out:?}");
        };
        let v: Value = serde_json::from_str(&s).unwrap();
        // The new event was back-filled…
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 1);
        // …and the pre-existing events were NOT duplicated.
        assert_eq!(v["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
        assert_eq!(v["hooks"]["SessionEnd"].as_array().unwrap().len(), 1);
    }

    /// Once every event we install is present, a re-install with the SAME event set
    /// is a clean no-op (`AlreadyPresent`) — the upgrade path doesn't rewrite a
    /// file that needs nothing.
    #[test]
    fn fully_installed_file_needs_no_rewrite() {
        let full = json!({
            "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
                "SessionEnd":   [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
                "Stop":         [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
            }
        });
        let full = serde_json::to_string(&full).unwrap();
        let newer = json!({
            "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
                "Stop":         [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
            }
        });
        assert_eq!(
            merge_hook_settings(Some(&full), &newer, "my-marker"),
            MergeOutcome::AlreadyPresent
        );
    }

    /// A user's own hook under an event we haven't installed yet must be preserved
    /// while ours is appended alongside — the back-fill appends, never replaces.
    #[test]
    fn backfill_preserves_a_users_hook_on_the_new_event() {
        // Old install: our marker on SessionStart only. The user also has their own
        // Stop hook (no marker). Additions install Stop.
        let existing = json!({
            "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
                "Stop":         [{"hooks": [{"type": "command", "command": "echo user-stop"}]}],
            }
        });
        let newer = json!({
            "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
                "Stop":         [{"hooks": [{"type": "command", "command": "curl … # my-marker"}]}],
            }
        });
        let out = merge_hook_settings(
            Some(&serde_json::to_string(&existing).unwrap()),
            &newer,
            "my-marker",
        );
        let MergeOutcome::Write(s) = out else {
            panic!("expected a write, got {out:?}");
        };
        let v: Value = serde_json::from_str(&s).unwrap();
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "user's Stop hook preserved alongside ours");
        assert!(serde_json::to_string(&stop[0])
            .unwrap()
            .contains("user-stop"));
        assert!(serde_json::to_string(&stop[1])
            .unwrap()
            .contains("my-marker"));
        // SessionStart already had ours — untouched, still a single entry.
        assert_eq!(v["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
    }

    /// **Preserve** the user's own hooks and settings — we only append.
    #[test]
    fn preserves_existing_user_settings_and_hooks() {
        let existing = json!({
            "permissions": {"allow": ["Bash"]},
            "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "echo user-hook"}]}],
            }
        });
        let out = merge_hook_settings(
            Some(&serde_json::to_string(&existing).unwrap()),
            &additions(),
            "my-marker",
        );
        let MergeOutcome::Write(s) = out else {
            panic!("expected a write, got {out:?}");
        };
        let v: Value = serde_json::from_str(&s).unwrap();
        // The user's permission block survives.
        assert_eq!(v["permissions"]["allow"][0], "Bash");
        // Their SessionStart hook is kept AND ours is appended (2 entries).
        let start = v["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(start.len(), 2, "user hook must be preserved alongside ours");
        assert!(serde_json::to_string(&start[0])
            .unwrap()
            .contains("user-hook"));
        assert!(serde_json::to_string(&start[1])
            .unwrap()
            .contains("my-marker"));
        // We created SessionEnd (the user had none).
        assert_eq!(v["hooks"]["SessionEnd"].as_array().unwrap().len(), 1);
    }

    /// **Never clobber** an unparseable file.
    #[test]
    fn refuses_to_clobber_malformed_json() {
        assert_eq!(
            merge_hook_settings(Some("{ this is not json"), &additions(), "my-marker"),
            MergeOutcome::SkipMalformed
        );
    }

    /// Valid JSON that isn't an object is also left alone.
    #[test]
    fn refuses_a_non_object_top_level() {
        assert_eq!(
            merge_hook_settings(Some("[1, 2, 3]"), &additions(), "my-marker"),
            MergeOutcome::SkipMalformed
        );
        assert_eq!(
            merge_hook_settings(Some("\"a string\""), &additions(), "my-marker"),
            MergeOutcome::SkipMalformed
        );
    }

    /// A `hooks.SessionStart` that the user made a non-array must not be reshaped.
    #[test]
    fn refuses_to_reshape_a_non_array_hook_slot() {
        let weird = r#"{"hooks": {"SessionStart": "not-an-array"}}"#;
        assert_eq!(
            merge_hook_settings(Some(weird), &additions(), "my-marker"),
            MergeOutcome::SkipMalformed
        );
    }

    /// Whitespace-only file is treated as empty, not malformed.
    #[test]
    fn treats_blank_file_as_empty() {
        assert!(matches!(
            merge_hook_settings(Some("   \n"), &additions(), "my-marker"),
            MergeOutcome::Write(_)
        ));
    }
}
