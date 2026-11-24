//! End-to-end test for terminal cwd tracking.
//!
//! Drives the **real** pipeline — a real `/bin/sh` in a real PTY, the real per-
//! terminal cwd poller, and `pty::cwd::process_cwd` against the live shell pid — to
//! prove the real scenario: open a terminal, `cd` into a repo the app never
//! explicitly opened, and the ad-hoc-detection hook is installed at that repo's git
//! root so a `claude` typed there is recognised.
//!
//! **Safety:** every path here is a throwaway temp dir; the
//! test asserts the user's global `~/.claude` is byte-identical before and after.
//! Nothing in the cwd tracker ever writes outside a repo's own `.claude/`.

mod common;

// The cwd tracker is Linux/macOS only (`process_cwd` returns `None` elsewhere), so
// the end-to-end flow is gated to the platforms that support it. `common` still
// compiles everywhere (its unused-helper `dead_code` is allowed).
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod supported {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use agent_studio_scaffold_lib::supervisor::OpenSpec;

    use super::common::{
        interactive_sh, supervisor_with_hook, test_hook_config, ChannelSink, StubAdapter, TIMEOUT,
    };

    /// Open a real shell in repo A, `cd` into repo B, and assert the poller installs
    /// B's hook at B's git root — without ever touching `~/.claude`.
    #[tokio::test]
    async fn a_cd_into_another_repo_installs_the_hook_there() {
        // Poll fast so the test doesn't wait real 1.2 s ticks (a test seam, not a
        // user knob). Set before the terminal opens: the poller reads it at start.
        std::env::set_var("AGENTSTUDIO_CWD_POLL_MS", "50");

        // Two temp repos (a bare `.git` dir is enough — `git_root` reads it
        // directly). Canonicalize so the shell's real, symlink-resolved cwd (what
        // `process_cwd` returns) matches the paths we assert against (macOS
        // `/var/folders` / `/tmp` → `/private/...`).
        let base =
            std::env::temp_dir().join(format!("agentstudio-cwd47-e2e-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&base).unwrap();
        let base = base.canonicalize().unwrap();
        let repo_a = base.join("repo-a");
        let repo_b = base.join("repo-b");
        for r in [&repo_a, &repo_b] {
            std::fs::create_dir_all(r.join(".git")).unwrap();
        }

        // The user's global config must be byte-identical before and after.
        let home = std::env::var("HOME").expect("HOME set");
        let global = std::path::Path::new(&home).join(".claude/settings.local.json");
        let global_before = std::fs::read_to_string(&global).ok();

        let (sup, _sink) =
            supervisor_with_hook(Arc::new(StubAdapter::interactive()), test_hook_config());

        // A real shell terminal, launched in repo A.
        let id = format!("cwd-term-{}", ulid::Ulid::new());
        let (_out, channel) = ChannelSink::new();
        let (program, args) = interactive_sh();
        sup.open_terminal(
            OpenSpec {
                terminal_id: id.clone(),
                program: Some(program),
                args,
                cwd: repo_a.to_string_lossy().into_owned(),
                rows: 24,
                cols: 80,
            },
            channel,
        )
        .await
        .expect("terminal_open failed");

        // The spawn-cwd install already wrote A's hook; B is untouched until the cd.
        let a_hook = repo_a.join(".claude/settings.local.json");
        let b_hook = repo_b.join(".claude/settings.local.json");
        assert!(
            a_hook.is_file(),
            "the spawn-cwd install should have written repo A's hook"
        );
        assert!(!b_hook.exists(), "repo B must not be touched before the cd");

        // The user `cd`s into repo B. The poller must notice the shell's new cwd and
        // route a `CwdChanged`, which installs B's hook at B's git root.
        sup.write(
            id.clone(),
            format!("cd {}\n", repo_b.display()).into_bytes(),
        )
        .await
        .expect("write failed");

        // Wait (bounded) for the install to land in repo B.
        let start = Instant::now();
        while !b_hook.is_file() {
            if start.elapsed() >= TIMEOUT {
                panic!("timed out: the cwd poller never installed the hook in repo B");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            std::fs::read_to_string(&b_hook)
                .unwrap()
                .contains("stub-hook-marker"),
            "repo B's hook is missing our marker"
        );

        // The whole point: the user's global config is never touched.
        let global_after = std::fs::read_to_string(&global).ok();
        assert_eq!(
            global_before, global_after,
            "the cwd tracker wrote to the user's global ~/.claude"
        );

        sup.close(id).await.ok();
        std::fs::remove_dir_all(&base).ok();
    }
}
