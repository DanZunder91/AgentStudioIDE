//! One spawned language server: piped-stdio process + the framing tasks around it.
//!
//! **Not a PTY**: LSP speaks plain stdio pipes; a TTY's echo/line
//! discipline would corrupt the protocol. We use `tokio::process` with stdin/stdout
//! piped and four tasks:
//!   - **read**: server stdout → [`FrameDecoder`] → `Channel<String>` (deframed bodies)
//!   - **write**: client bodies (mpsc) → [`framing::encode`] → server stdin
//!   - **stderr**: drained + logged (an unread pipe would eventually block the server)
//!   - **wait**: reaps the child on natural exit *or* an explicit stop, then reports
//!     `ServerExited` to the actor exactly once — so a server that dies mid-session
//!     is surfaced, never a zombie or a hang.
//!
//! The relay stays dumb: it frames bytes and manages the process. It never parses a
//! JSON-RPC message.

use std::path::Path;
use std::process::Stdio;

use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, Command};
use tokio::sync::{mpsc, oneshot};

use super::LspMsg;
use crate::lsp::framing::{self, FrameDecoder};
use crate::spawn::NoWindow as _;

/// Client→server body queue depth. `lsp_send` is low-frequency; this is slack.
const STDIN_QUEUE: usize = 256;
/// Server stdout read granularity.
const READ_CHUNK: usize = 8192;

/// A live server the actor owns: a handle to its stdin writer + a kill switch.
pub struct LspServer {
    /// Which language this server serves (for a snapshot / debugging).
    #[allow(dead_code)]
    pub language_id: String,
    /// Client→server bodies; the write task frames + writes them.
    stdin_tx: mpsc::Sender<String>,
    /// Fires the wait task's kill path. `None` after [`Self::shutdown`].
    kill_tx: Option<oneshot::Sender<()>>,
}

impl LspServer {
    /// Enqueue one client→server JSON-RPC body (the Transport's `send`).
    ///
    /// Non-blocking so a wedged server can never stall the actor: a full queue or a
    /// closed writer is a plain `Err`, not backpressure.
    pub fn send(&self, message: String) -> Result<(), String> {
        use mpsc::error::TrySendError;
        self.stdin_tx.try_send(message).map_err(|e| match e {
            TrySendError::Full(_) => "lsp server input queue is full".to_string(),
            TrySendError::Closed(_) => "lsp server is no longer accepting input".to_string(),
        })
    }

    /// Ask the child to die. Signals the wait task to kill+reap; dropping `self` then
    /// drops `stdin_tx`, which ends the write task and closes the child's stdin.
    pub fn shutdown(mut self) {
        if let Some(kill) = self.kill_tx.take() {
            let _ = kill.send(());
        }
    }
}

/// The language server's command, ready to spawn: piped stdio, cwd `cwd` (the project root).
///
/// **Windows: no program is ever looked up in the project folder.** A `.bat` server
/// (`registry::launch_for`) runs under `cmd.exe`, and cmd looks for
/// every bare command the script runs (`java` in Gradle's start script, when `JAVA_HOME` is
/// unset) in the current directory before `PATH`. That directory is the opened repo, so a
/// repo could ship a `java.exe` and have it run on opening a `.kt` file.
/// `NoDefaultCurrentDirectoryInExePath` turns that lookup off in cmd and in `CreateProcess`'s
/// search. It is set for every server, not only batch ones: a server that starts helpers by
/// bare name gets the same protection where its runtime honours it.
pub(crate) fn command(bin: &Path, args: &[String], cwd: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // If the wait task is ever dropped (runtime teardown / app exit), the child
        // still dies — no orphaned language servers.
        .kill_on_drop(true)
        .no_window();
    if cfg!(windows) {
        cmd.env("NoDefaultCurrentDirectoryInExePath", "1");
    }
    cmd
}

/// Spawn `bin args` with cwd `cwd`, wire up the framing tasks, and return the handle.
///
/// `channel` receives deframed server→client bodies; `notify` receives exactly one
/// [`LspMsg::ServerExited`] when the child ends (naturally or via [`LspServer::shutdown`]).
pub fn spawn(
    bin: &Path,
    args: &[String],
    cwd: &Path,
    server_id: String,
    language_id: String,
    channel: Channel<String>,
    notify: mpsc::Sender<LspMsg>,
) -> std::io::Result<LspServer> {
    let mut child = command(bin, args, cwd).spawn()?;

    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take();

    let (stdin_tx, stdin_rx) = mpsc::channel::<String>(STDIN_QUEUE);
    tauri::async_runtime::spawn(write_loop(stdin, stdin_rx));
    tauri::async_runtime::spawn(read_loop(stdout, channel));
    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(log_stderr(stderr, server_id.clone()));
    }

    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(wait_loop(child, kill_rx, notify, server_id));

    Ok(LspServer {
        language_id,
        stdin_tx,
        kill_tx: Some(kill_tx),
    })
}

/// Server stdout → deframe → `Channel`. Generic over the reader so it is testable
/// against an in-memory pipe without spawning a process.
async fn read_loop<R: AsyncRead + Unpin>(mut stdout: R, channel: Channel<String>) {
    let mut decoder = FrameDecoder::new();
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        match stdout.read(&mut buf).await {
            // EOF or a read error: the server closed stdout (i.e. it exited).
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for body in decoder.push(&buf[..n]) {
                    // Webview gone → send errors; ignore, like the terminal coalescer.
                    let _ = channel.send(body);
                }
            }
        }
    }
}

/// Client bodies → frame → server stdin. Generic over the writer for testability.
async fn write_loop<W: AsyncWrite + Unpin>(mut stdin: W, mut rx: mpsc::Receiver<String>) {
    while let Some(body) = rx.recv().await {
        let framed = framing::encode(&body);
        if stdin.write_all(&framed).await.is_err() || stdin.flush().await.is_err() {
            break; // server closed stdin
        }
    }
    // rx closed (server stopped): dropping `stdin` closes the child's stdin.
}

/// Drain the server's stderr so its pipe never fills (which would block the server),
/// logging each line.
async fn log_stderr(stderr: ChildStderr, server_id: String) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        eprintln!("[lsp {server_id}] {line}");
    }
}

/// Reap the child on natural exit or an explicit kill, then report `ServerExited`
/// once. This is the single place a dead server is surfaced to the actor.
async fn wait_loop(
    mut child: Child,
    kill_rx: oneshot::Receiver<()>,
    notify: mpsc::Sender<LspMsg>,
    server_id: String,
) {
    let code = tokio::select! {
        status = child.wait() => status.ok().and_then(|s| s.code()),
        // Stop requested (or the kill sender dropped): kill, then reap.
        _ = kill_rx => {
            let _ = child.start_kill();
            child.wait().await.ok().and_then(|s| s.code())
        }
    };
    let _ = notify.send(LspMsg::ServerExited { server_id, code }).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::test_support::string_channel;

    /// A `.bat` server runs under cmd, which looks for the script's bare commands in the cwd (the
    /// opened repo) before `PATH`. A repo-planted `planted.bat` must not run. The real cmd.exe,
    /// through the real command builder.
    #[cfg(windows)]
    #[tokio::test]
    async fn on_windows_a_batch_server_never_runs_a_program_from_the_project_folder() {
        let root = std::env::temp_dir().join(format!("lsp-cwd-search-{}", ulid::Ulid::new()));
        let (tools, project) = (root.join("tools"), root.join("project"));
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        // The server: runs a bare command, as Gradle's start script runs `java`.
        let server = tools.join("server.bat");
        std::fs::write(&server, "@echo off\r\nplanted\r\necho server-ran\r\n").unwrap();
        // The repo's plant, in the cwd the server is started in.
        let marker = root.join("planted-ran.txt");
        std::fs::write(
            project.join("planted.bat"),
            format!("@echo off\r\necho x > \"{}\"\r\n", marker.display()),
        )
        .unwrap();

        const VAR: &str = "NoDefaultCurrentDirectoryInExePath";

        // The builder sets the variable itself. Asserted on the command, because the parent's
        // environment may already carry it (this repo's own agent shells do), and then the
        // two runs below would pass without it.
        let built = command(&server, &[], &project);
        assert!(
            built
                .as_std()
                .get_envs()
                .any(|(k, v)| k == VAR && v == Some(std::ffi::OsStr::new("1"))),
            "command() must set {VAR}=1"
        );

        // Negative control: with the variable removed, cmd does run the plant.
        // Without this, a plant cmd could never have found would pass the check below.
        let mut exposed = command(&server, &[], &project);
        exposed.env_remove(VAR);
        exposed.output().await.unwrap();
        assert!(
            marker.exists(),
            "control: without {VAR}, cmd should find planted.bat in the cwd"
        );
        std::fs::remove_file(&marker).unwrap();

        let out = command(&server, &[], &project).output().await.unwrap();
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("server-ran"),
            "the server itself must run: {out:?}"
        );
        assert!(
            !marker.exists(),
            "cmd ran planted.bat from the project folder"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// The read task deframes a stream that is split byte-by-byte and packs multiple
    /// messages — driven over an in-memory pipe (no subprocess, every platform).
    #[tokio::test]
    async fn read_loop_deframes_a_split_stream_to_the_channel() {
        let (mut writer, reader) = tokio::io::duplex(16); // tiny buffer forces splits
        let (channel, recorder) = string_channel();
        let task = tauri::async_runtime::spawn(read_loop(reader, channel));

        let mut stream = framing::encode("first");
        stream.extend(framing::encode("second"));
        // One byte at a time: the worst-case split.
        for b in stream {
            writer.write_all(&[b]).await.unwrap();
            writer.flush().await.unwrap();
        }
        drop(writer); // EOF → read_loop ends
        task.await.unwrap();

        assert_eq!(recorder.take(), vec!["first", "second"]);
    }

    /// The write task frames each body onto stdin; round-trip it back through the
    /// decoder to prove the bytes are well-formed.
    #[tokio::test]
    async fn write_loop_frames_each_body_onto_stdin() {
        let (writer, mut reader) = tokio::io::duplex(1024);
        let (tx, rx) = mpsc::channel::<String>(8);
        tauri::async_runtime::spawn(write_loop(writer, rx));

        tx.send("alpha".to_string()).await.unwrap();
        tx.send("beta".to_string()).await.unwrap();
        drop(tx); // ends the write task, closes the writer

        // Read everything, then deframe.
        let mut all = Vec::new();
        let mut buf = [0u8; 256];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => all.extend_from_slice(&buf[..n]),
            }
        }
        let mut d = FrameDecoder::new();
        assert_eq!(d.push(&all), vec!["alpha", "beta"]);
    }

    /// **The end-to-end pipe through a real process** (unix): `cat` is a byte echo,
    /// so a framed message we send comes back framed and deframes to the same body —
    /// a perfect fake echo server. Then `shutdown` kills + reaps it (`ServerExited`).
    #[cfg(unix)]
    #[tokio::test]
    async fn spawns_a_process_and_round_trips_a_framed_message() {
        use crate::lsp::test_support::first_existing;
        use std::time::Duration;
        let cat = first_existing(&["/bin/cat", "/usr/bin/cat"]).expect("cat must exist on unix");
        let (channel, recorder) = string_channel();
        let (notify_tx, mut notify_rx) = mpsc::channel::<LspMsg>(8);

        let server = spawn(
            &cat,
            &[] as &[String],
            Path::new("/"),
            "srv-echo".to_string(),
            "rust".to_string(),
            channel,
            notify_tx,
        )
        .expect("spawn cat");

        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        server.send(body.to_string()).unwrap();

        // The echoed frame comes back deframed on the Channel.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if recorder.snapshot().iter().any(|m| m == body) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "echo never arrived");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        // Stop it → the child is killed and reaped exactly once.
        server.shutdown();
        let exited = tokio::time::timeout(Duration::from_secs(5), notify_rx.recv())
            .await
            .expect("wait task must report the exit")
            .expect("ServerExited");
        match exited {
            LspMsg::ServerExited { server_id, .. } => assert_eq!(server_id, "srv-echo"),
            _ => panic!("expected ServerExited"),
        }
    }
}
