# Code Intelligence — go-to-definition + find-usages (LSP)

> **Status:** Implemented: go-to-definition and find usages (completion and diagnostics are not
> built). The decision record at the bottom is accepted.
>
> **Requirement:** IntelliJ / VS-Code-style navigation — Cmd/Ctrl+Click a
> symbol → jump to its definition; **Find All Usages** for methods *and*
> variables. That is semantic, cross-file, whole-project analysis, which means
> the **Language Server Protocol (LSP)**. Regex/ripgrep find (M4 `run_find`) is a
> different, complementary feature and is **not** a substitute.
>
> **Scope of this doc:** the five design decisions, an architecture that
> fits the existing supervisor/`Channel`/CM6 model, and a sliced build plan with
> its test strategy.

---

## TL;DR — the five decisions

| # | Question | Decision |
|---|----------|----------|
| **1** | Where does the LSP client live? | **Split by concern.** Rust owns the **server process + framed byte transport** (spawn, stdio, Content-Length framing, lifecycle, crash/restart, binary detection) — a thin *relay* that fits the supervisor model. The **JSON-RPC protocol client + document sync live in JS**, inside `@codemirror/lsp-client`, because the document (text, version, UTF-16 positions) lives in CodeMirror `EditorState`. **Not** a fat Rust client exposing typed `lsp_definition`/`lsp_references` commands; **not** a dumb raw-byte proxy. |
| **2** | Which CM6 integration? | **Adopt `@codemirror/lsp-client`** (v6.2.5, **MIT**, by the CodeMirror author). It ships definition, references, hover, completion, signature help, rename, and format; presents **find-references in a native CM6 panel**; and delegates cross-file navigation to a host **`Workspace`** (`displayFile`/`requestFile`) that maps 1:1 onto our existing `openEditorTab` + `read_file`. Do **not** hand-roll the protocol. |
| **3** | Which servers, how detected? | **BYO-server, detect-on-PATH, degrade silently.** A `LanguageId → LspServerSpec` table (command + args + install hint + root markers). Detect the binary via PATH + known install dirs (reuse the `claude`-resolution approach). Absent server ⇒ feature is simply off for that file, with a calm dismissible "Install rust-analyzer" hint. **No bundling for v1.** |
| **4** | Document sync + workspace | The JS client sends `didOpen`/`didChange`/`didClose` itself, keyed to `EditorState` — Rust never shadows document text. **One server per `(workspaceRoot, languageId)`**, `rootUri` = our `workspaceRoot`, reused across all open files of that language so cross-file references work. Handle the **indexing-delay gotcha** (rust-analyzer): a `references` result before indexing completes is *incomplete, not empty* — reflect `$/progress`, never cache an empty answer as "no usages." |
| **5** | Slice plan | **0** feasibility spike · **1** go-to-definition, Rust only, Cmd+Click+F12 · **2** find-usages panel · **3+** more languages. Real servers → **integration tests** (opt-in, binary-gated in CI); a **fake stub LSP server** gives deterministic unit tests of the whole pipeline without rust-analyzer's nondeterministic indexing. |

**Recommended first language: Rust (rust-analyzer).** Rationale in §5.

---

## 1. Decision 1 — LSP client location

### The shape

```
┌──────────── RUST CORE ────────────┐        ┌──────────── REACT / WEBVIEW ────────────┐
│  LspSupervisor (actor, mpsc)       │        │  @codemirror/lsp-client (LSPClient)      │
│   owns Map<ServerId, LspServer>    │        │   • initialize handshake + capabilities  │
│   • tokio::process (piped stdio)   │        │   • didOpen / didChange / didClose       │
│   • Content-Length framing         │        │   • request/response correlation         │
│   • lifecycle / crash / restart    │        │   • UTF-16 position math (native to JS)  │
│   • server-binary detection        │        │   • definition/references/hover/…        │
│                                    │        │   • Workspace: displayFile / requestFile │
│         relays JSON-RPC bodies     │        │                                          │
└───────┬───────────────────▲───────┘        └───────┬────────────────────────▲─────────┘
        │ server→client                              │ Transport.subscribe     │
        │ Channel<String> (onMessage)  ──────────────┘                         │
        │                                                                      │
        └── client→server: #[tauri::command] lsp_send(serverId, message) ◄─────┘ Transport.send
```

Rust is a **framed-message relay + process supervisor**, nothing more. It does not
parse LSP semantics, does not hold document state, does not know what
`textDocument/definition` means. JS owns the protocol.

### Why this split, not the alternatives

**Not a fat Rust client (`lsp_definition` / `lsp_references` typed commands).**
It would re-implement, in Rust, the entire LSP client layer that
`@codemirror/lsp-client` already implements and maintains: the `initialize`
handshake, capability negotiation, request/response id correlation, document
version tracking, `$/progress`, partial-result streaming, and — the subtle one —
**position encoding**. LSP positions are UTF-16 code units by default;
CodeMirror/JS strings are UTF-16 natively. A Rust client would convert UTF-8 byte
offsets ↔ UTF-16 per document per request — a classic bug farm (silent desync
surviving to a demo). Worse, it fights
Decision 2: we're adopting a JS client that *is* the protocol layer; wrapping it
in typed Rust commands means writing a second one.

**The load-bearing argument — who holds document-sync state.** The document lives
in CodeMirror `EditorState` in the webview: its text, its edit stream, its version
counter, its UTF-16 coordinate system. `didChange` must fire on every keystroke
against *that* text, and every definition/reference position must be resolved in
*that* coordinate system. Put the JSON-RPC client next to the document and both are
trivially correct. Put it in Rust and Rust needs a perfectly-synced shadow copy of
every open buffer, converting coordinates on every hop. **The thing that owns the
text must own the sync.** That is JS.

**Not a dumb raw-byte proxy either.** LSP framing is `Content-Length: N\r\n\r\n<body>`
over a stream — it needs a stateful reassembler somewhere. Rust already has exactly
this muscle (the PTY reader + coalescer), byte handling is its job, and reassembling
frames in JS would push binary parsing into the webview for no benefit. Rust also is
the natural home for process lifecycle, crash/restart, and binary detection. So the
relay does *just enough*: frame in, frame out, keep the process alive.

### Fit, constraints, testability

- **Supervisor fit.** A new `LspSupervisor` actor mirrors `SessionSupervisor`: an
  mpsc-driven task owning a `Map<ServerId, LspServer>`, cheap-clone `LspHandle`,
  Tauri types kept out of the core so it runs headless (the PTY supervisor's discipline).
  Client→server is a low-frequency `#[tauri::command]` (`lsp_send`); server→client
  is a per-server `Channel<String>` captured at start — **the exact `terminal_open`
  pattern** (Channel out, command in), already proven and well-tested here.
- **NOT a PTY.** LSP servers speak plain stdio pipes, never a TTY — a PTY's line
  discipline/echo would corrupt the protocol. The relay uses
  `tokio::process::Command` with `stdin`/`stdout` piped (stderr → `tracing`), a
  **new spawn path distinct from `portable-pty`**. Do not reuse `pty/`.
- **WebKitGTK constraint (why not run the server in the webview).** The editor
  choice rejected Monaco precisely because its web-workers crash under WebKitGTK. Running a
  heavy language server (rust-analyzer, tsserver) in a worker/WASM would re-import
  that failure. Native child processes owned by Rust sidestep it entirely — and the
  webview can't spawn processes anyway. This is the same reason we run agents in
  real OS PTYs, not in the page.
- **Testability.** The relay's framing codec is a pure function (fixture + property
  tested like the pane-tree). The whole pipeline is exercised end-to-end against a
  **fake stub LSP server** (deterministic canned responses over real Content-Length
  framing) with zero dependency on a real toolchain. Real servers are integration-
  tested separately (§5).

---

## 2. Decision 2 — CodeMirror 6 integration

### Survey (all licenses MIT-compatible unless noted)

| Library | Latest | License | Transport | find-references | Cross-file model | Verdict |
|---|---|---|---|---|---|---|
| **`@codemirror/lsp-client`** (official, Marijn Haverbeke) | **6.2.5**, 2026-06-09 | **MIT** | Pluggable `{send, subscribe, unsubscribe}` (JSON strings) | ✅ native CM6 **Panel** (grouped, previews, keyboard nav) | ✅ **`Workspace`** abstraction (`displayFile`/`requestFile`) | **✅ PICK** |
| `@marimo-team/codemirror-languageserver` (fork of ↓) | 1.16.12, 2026-02 | BSD-3-Clause | Pluggable, WebSocket-first | partial | one client → many docs via `documentUri` | Strong **fallback** |
| `codemirror-languageserver` (FurqanSoftware, original) | — (162 commits) | BSD-3-Clause | Pluggable | ❌ **no find-references** | `documentUri` | ❌ fails the core requirement |
| Hand-roll `textDocument/definition` + `references` ourselves | — | — | — | build it all | build it all | ❌ re-invents a maintained MIT lib |

### Decision — adopt `@codemirror/lsp-client`

It is the only option that natively ships the two required features
*and* the seams an IDE needs:

- **Feature coverage out of the box:** `jumpToDefinition` (F12), `findReferences`
  (Shift-F12), `jumpToDeclaration`, `jumpToTypeDefinition`, `jumpToImplementation`,
  plus hover, completion, signature help, rename, format — the whole navigation set
  from one dependency, so slices 3+ come nearly for free once the pipe exists.
- **Find-references presents as a native CM6 `Panel`** (`showPanel`): file-grouped,
  code-context previews, arrow-key navigation, Enter to jump. This is the
  "Find All Usages" panel, already built — we don't design a results UI in slice 2.
- **Cross-file navigation via a host `Workspace`** — the client calls
  `workspace.displayFile(uri)` to switch files and `workspace.requestFile(uri)` to
  read a not-yet-open file for previews. These map **directly** onto code we already
  have: `displayFile` → `layoutActions.openEditorTab(pathFromUri(uri))` + reveal the
  target range in that view; `requestFile` → the existing scoped `read_file` command.
- **Careful async semantics** — the author explicitly reinterprets server responses
  against the *current* document version rather than the version the server saw,
  which is exactly the class of race a live-editing IDE hits.
- **Transport is a 3-method string interface** — `send(msg)`, `subscribe(handler)`,
  `unsubscribe(handler)` — trivially backed by our Tauri relay (§1, §6). The library
  does the JSON-RPC *content*; the Transport just moves message bodies.
- **Deps are additive and all MIT:** `@codemirror/{state,view,language,autocomplete,
  lint}`, `@lezer/highlight`, `marked` (hover markdown), `vscode-languageserver-
  protocol` (types). We already ship `state`/`view`/`language`. No peer-dep
  conflicts; nothing wasm/worker (WebKitGTK-safe).

**Coexistence with Shiki.** The lsp-client uses `@lezer/highlight` only
to render markdown inside *its own tooltips*, not to highlight the editor buffer.
Our Shiki `StateField` decorations (`highlight.ts`) stay the source of truth for
token colors; the LSP layer adds a *separate* set of extensions (diagnostics
underlines, hover tooltips, the references panel). The two do not collide — they
occupy different CM6 facets.

**Maturity caveat (recorded, not disqualifying).** The author notes it "hasn't seen
a lot of use yet." Mitigation: slice 0 is a real spike against rust-analyzer that
must round-trip a definition before we commit; the marimo fork is a drop-in-ish
fallback if the official client blocks us. Also note the GitHub mirror was
**archived April 2026 when Marijn moved all CodeMirror repos to his own forge**
(`code.haverbeke.berlin`) — a relocation, not abandonment; npm publishes continue
(6.2.5 on 2026-06-09).

### Cmd/Ctrl+Click

`languageServerExtensions()` binds F12/Shift-F12. IntelliJ-style **Cmd/Ctrl+Click**
is a small glue extension we add: an `EditorView.domEventHandlers` mousedown handler
that, when the platform modifier is held, resolves the click to a document position
and invokes the client's `jumpToDefinition` there. ~15 lines, no protocol code.

---

## 3. Decision 3 — language-server strategy

### Principle: bring-your-own-server, detect, degrade — never bundle (v1)

Bundling language servers would bloat the ~15 MB app by hundreds of MB (rust-analyzer
alone is ~30 MB; jdtls pulls a JRE) and entangle us in per-server licensing and
per-OS binaries. v1 detects what the user already has and turns the feature on
where present. This mirrors how we already treat `claude` (resolved from PATH, not
shipped).

### Per-language capability map (`LanguageId → LspServerSpec`)

`LanguageId` is the canonical union from `src/lib/language/ids.ts`; this table lives
in Rust (`lsp/registry.rs`) because Rust does the spawning and detection.

| `LanguageId` | Server (command) | stdio invocation | Install hint | Root markers |
|---|---|---|---|---|
| `rust` | **rust-analyzer** | `rust-analyzer` | `rustup component add rust-analyzer` | `Cargo.toml` |
| `typescript`/`tsx`/`javascript`/`jsx` | **typescript-language-server** | `typescript-language-server --stdio` | `npm i -g typescript-language-server typescript` | `package.json`, `tsconfig.json` |
| `python` | **pyright** (or `pylsp`) | `pyright-langserver --stdio` | `npm i -g pyright` | `pyproject.toml`, `setup.py`, `.git` |
| `go` | **gopls** | `gopls` | `go install golang.org/x/tools/gopls@latest` | `go.mod` |
| `c`/`cpp`/`objective-c`/`objective-cpp` | **clangd** | `clangd` | install via LLVM / distro pkg | `compile_commands.json`, `.git` |
| `java` | **jdtls** | `jdtls` (wrapper) | Eclipse JDT LS | `pom.xml`, `build.gradle` |
| `kotlin` | **kotlin-language-server** | `kotlin-language-server` | community KLS | `build.gradle(.kts)`, `settings.gradle` |
| `csharp` | OmniSharp / csharp-ls | `csharp-ls` | `dotnet tool install --global csharp-ls` | `*.sln`, `*.csproj` |
| `ruby` | ruby-lsp / solargraph | `ruby-lsp` | `gem install ruby-lsp` | `Gemfile` |
| `php` | intelephense | `intelephense --stdio` | `npm i -g intelephense` | `composer.json` |
| others | — | (unmapped ⇒ feature off) | — | — |

The spec per language is `{ command, args, install_hint, root_markers }`. Adding a
language is one row + (if needed) a fake-server integration test — no new code path.

### Detection + degradation

- **Detection.** Resolve the server binary the way we resolve `claude`: search
  `PATH`, then a small set of known install dirs (`~/.cargo/bin`, `~/.local/bin`,
  `~/go/bin`, npm global prefix, `/usr/local/bin`, …), plus `where` on Windows. A GUI
  launch inherits a thin PATH (often without `~/.local/bin`), so the extra dirs are
  load-bearing, not belt-and-braces. Detection result is cached per session and
  refreshable.
- **Graceful absence — the feature is *off*, not *broken*.** If no server resolves
  for a file's `LanguageId`, the editor opens exactly as today; no definition/
  references extensions attach. A single calm, dismissible inline hint — "Install
  rust-analyzer for go-to-definition" with the install command — appears once per
  language per session. This is the same "calm empty state, never a crash"
  philosophy as `read_file`'s out-of-scope handling. No modal, no red error.
- **Unmapped language.** `LanguageId` we have no spec for behaves identically to an
  absent binary: feature off, no hint (there is nothing to install-hint toward).

---

## 4. Decision 4 — document sync + workspace

### Sync is the JS client's job

`@codemirror/lsp-client` sends `textDocument/didOpen` when an editor's
`client.plugin(uri)` mounts, `didChange` on the CM6 update stream, and `didClose`
when the plugin is removed (tab close / `dispose`). We wire it in
`EditorRegistry.createView` right after language detection: if a server is available
for the language, add `client.plugin(fileUri)` + `languageServerExtensions()` to the
extensions array. **Rust never sees document text on this path** — only the JSON-RPC
bodies the client emits, relayed verbatim. The editor is editable-by-default today;
LSP works identically over an editable or a gated read-only buffer (navigation over a
read-only file is fine).

### Workspace root + server keying

- **`rootUri` = our `workspaceRoot`** (the store's `workspaceRoot`, from
  `default_workspace()` / recent projects). The client's `initialize` sends it as
  `rootUri` + `workspaceFolders`; the Rust process is spawned with that dir as cwd.
- **One server per `(workspaceRoot, languageId)`**, minted lazily on first open of a
  file of that language and **shared by every open file of that language in that
  root** — this is what makes cross-file find-references work (the server has indexed
  the whole project, not one file). JS holds a `Map<`${root}::${lang}`, LSPClient>`;
  Rust holds the matching `Map<ServerId, LspServer>`. ServerId is minted by JS (ULID)
  and handed to `lsp_start`.
- **The `Workspace` glue (the only real integration work):**
  - `displayFile(uri)` → `pathFromUri(uri)` → `openEditorTab(path)`; then reveal the
    target range by dispatching a selection+scroll on that path's `EditorView`
    (EditorRegistry exposes `getView(path)`). The uri↔path mapping must handle
    `file://` + **Windows drive letters** (`file:///C:/…`) — a classic gotcha; pin it
    with tests.
  - `requestFile(uri)` → the existing scoped `read_file(path)` (security scope
    already confines it to the workspace / recent roots — a server should never make
    us read outside them).

### The find-references indexing gotcha (call it out loudly)

**A `textDocument/references` result returned before the server has finished indexing
the project is incomplete, not empty — and must never be cached as "no usages."**
This is sharpest with **rust-analyzer**, which indexes the whole crate graph on
startup and can take tens of seconds on a large workspace; gopls/pyright are faster
but not instant. Handling:

1. Surface indexing state from `$/progress` / `window/workDoneProgress` so the
   references panel can show "indexing…" instead of a misleading empty list.
2. Do not memoize an empty/partial reference set as authoritative; a re-run after
   indexing completes is the correct answer.
3. First-use latency is expected UX, not a bug — the hint/label should say so.

Also: rust-analyzer emits `experimental/serverStatus`; treating `quiescent: true` as
"index ready" is a nice-to-have refinement for slice 2+.

---

## 5. Decision 5 — slice plan + testing

**Recommended first language: Rust (rust-analyzer).** Because (a) this very repo is a
Rust + TS project, so we dogfood against `src-tauri/` from day one; (b) rust-analyzer
is a single self-contained binary trivially installed via `rustup component add`
(already part of the Rust toolchain this repo builds with); (c) it is the **hardest**
case on the indexing-delay axis, so designing slice 1–2 against it means the
worst-case UX is handled first, not retrofitted; (d) no Node/JRE/venv ambiguity to
resolve about *which* project the server should target.

| Slice | Delivers | Key work | How it's tested |
|---|---|---|---|
| **0 — feasibility spike** | Proof the pipe works end-to-end; the decision is locked. | Throwaway harness: Rust relay spawns rust-analyzer, JS client `initialize`s, one `textDocument/definition` round-trips against a real `.rs` file. Confirm framing, cwd/rootUri, position encoding. | Manual/spike; the artifact is the decision record + a green round-trip, not committed tests. |
| **1 — go-to-definition** (Rust only) | Cmd/Ctrl+Click **and** F12 on a symbol in a `.rs` file jumps to its definition (same-file and cross-file). | `lsp/` module (relay, framing, registry, `lsp_start`/`lsp_send`/`lsp_stop`); FE `lsp/{transport,client,workspace,extension}`; EditorRegistry wiring; the mod-click glue; uri↔path. | **Unit:** framing codec (fixtures + property), `LanguageId→spec` map, binary detection (temp PATH), uri↔path (incl. Windows). **Integration:** full pipeline vs a **fake stub LSP server** (deterministic). **Real:** rust-analyzer integration test, **binary-gated** (skipped if absent; CI job installs it). **App:** a real Cmd+Click jump in the running IDE. |
| **2 — find-usages panel** | Shift-F12 / a "Find All Usages" action lists every reference to a method or variable, grouped by file, click-to-jump. | Enable `findReferences` + the client's references `Panel`; wire `requestFile` previews; the indexing-delay UX (§4). Optional: mirror results into the right-rail **Find** tab. | Fake-server references fixtures (deterministic count/locations); real rust-analyzer integration incl. an *indexing-in-progress* case; app-level Find-All-Usages on a real symbol. |
| **3+ — more languages** | TS/JS, Python, Go, C/C++, … each gain the same navigation. | One `LspServerSpec` row per language + detection; hover/completion/rename fall out of the shared client. | Per-language: fake-server smoke + a binary-gated real integration test. Grows the capability map, not the code. |

**Testing approach.**
- **Deterministic core, everywhere it can be.** The framing codec, the registry map,
  binary detection, and uri↔path are pure/injectable and unit-tested — the highest-
  value, most-testable surface (same reasoning as pane-tree canonicalization).
- **A fake stub LSP server is the workhorse.** A tiny committed test binary/script
  that speaks Content-Length-framed JSON-RPC with canned `initialize`/`definition`/
  `references` responses lets us test the *entire* Rust↔JS pipeline deterministically,
  with no toolchain and no indexing nondeterminism. This is the LSP analogue of the
  M3 real-JSONL fixtures.
- **Real servers are integration-only and binary-gated.** rust-analyzer's timing is
  nondeterministic, so real-server tests assert *shape* ("definition lands in
  `foo.rs` within the item's range"), run behind a "binary present?" guard so a dev
  without it isn't blocked, and get their own CI leg that installs the binary.
- **The running-app gate is non-negotiable**: a slice is not done
  until a real Cmd+Click / Find-Usages works in the real IDE, not just in tests.

---

## 6. Architecture — where the code lands

### Rust (`src-tauri/src/lsp/` — a sibling of `supervisor/`, runtime-agnostic core)

```
src-tauri/src/lsp/
├─ mod.rs        # LspSupervisor actor + LspHandle (mpsc); Map<ServerId, LspServer>
├─ server.rs     # spawn via tokio::process (piped stdio, NOT a PTY); lifecycle; restart; stderr→tracing
├─ framing.rs    # Content-Length JSON-RPC codec (encode/decode) — the pure, hard-tested core
├─ registry.rs   # LanguageId → LspServerSpec table + binary detection (PATH + known dirs + where)
└─ commands.rs   # #[tauri::command] lsp_start / lsp_send / lsp_stop
```

Registered in `lib.rs` alongside the existing handlers; the `LspHandle` is `.manage`d
like `SupervisorHandle`. Keep Tauri types out of `mod.rs`/`server.rs`/`framing.rs` so
they run headless (this is what enables the fake-server integration tests).

**Command surface (additions to ARCHITECTURE §2.4):**

| Command | Args | Returns | Notes |
|---|---|---|---|
| `lsp_start` | `{ serverId, languageId, workspaceRoot, onMessage: Channel<String> }` | `LspServerMeta` | Resolve the binary for `languageId`; spawn with cwd `workspaceRoot`; capture `onMessage` (server→client frames as JSON strings). **Unavailable server ⇒ `Ok` with `status:"unavailable"` + `installHint`** (calm, mirrors `read_file` degradation), not an `Err`; a genuinely failed spawn is an `Err`. |
| `lsp_send` | `{ serverId, message: String }` | `()` | One client→server JSON-RPC body (the Transport's `send`). Low frequency. |
| `lsp_stop` | `{ serverId }` | `()` | Terminate the child, drop the framing task. |

`LspServerMeta = { serverId, languageId, status: "running" | "unavailable", installHint?, serverName? }`.
Mirror in `model.rs` + `types.ts` with the usual serde snake↔camel discipline and a
contract test (like `terminal_meta_matches_ts_contract`).

### Frontend (`src/features/editor/lsp/`)

```
src/features/editor/lsp/
├─ transport.ts   # Tauri-backed Transport: send → invoke('lsp_send'); subscribe → onMessage Channel<String>
├─ client.ts      # LSPClient cache Map<`${root}::${lang}`, LSPClient>; lazy start via lsp_start
├─ workspace.ts   # Workspace impl: displayFile → openEditorTab + reveal; requestFile → read_file; uri↔path
└─ extension.ts   # per-editor wiring: client.plugin(fileUri) + languageServerExtensions() + Cmd/Ctrl+Click glue
```

`ipc.ts` gains `lspStart` / `lspSend` / `lspStop` wrappers (same style as
`openTerminal`). `EditorRegistry.createView` calls into `extension.ts` to attach the
LSP extensions when a server is available for the detected language — the single
integration point, behind an availability check so absence is a no-op.

### End-to-end: Cmd+Click → definition

```
User Cmd+Clicks a symbol in main.rs (CodeMirror editor)
  → mod-click glue resolves click → doc position → client.jumpToDefinition(pos)
  → @codemirror/lsp-client builds textDocument/definition JSON-RPC
  → Transport.send(json)  →  invoke('lsp_send', { serverId, message })
  → Rust relay: frame (Content-Length) → rust-analyzer stdin
  → rust-analyzer stdout → Rust reads frame → Channel<String>.send(body)
  → Transport.subscribe handler ← body  →  client resolves the response
  → same file: dispatch selection+scroll on this EditorView
    cross file: workspace.displayFile(uri) → openEditorTab(path) → reveal range
```

Diagnostics, hover, completion, references ride the identical pipe — different
JSON-RPC methods, same relay.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **`@codemirror/lsp-client` immaturity** ("not much use yet"). | Slice 0 spike must round-trip a real definition before commit; marimo fork is the fallback; the Transport seam means the client is swappable without touching Rust. |
| **rust-analyzer indexing latency** misread as "no results." | `$/progress` surfacing + never caching empty as authoritative (§4). Rust first = worst case handled first. |
| **LSP servers are a second heavy fleet the app owns** (rust-analyzer can use GBs). The app owns its child processes in-process — every server dies on app exit; a webview reload orphans the JS clients. | v1: servers are **disposable** — reaped on window close, restarted lazily on next editor open (re-indexing on reload is acceptable; unlike a running agent, nothing irreplaceable is lost). Reattach-on-reload (like terminals) is a *future* optimization, not v1. Cap concurrent servers if a fleet of workspaces is open. |
| **UTF-16 vs UTF-8 position encoding** desync. | Avoided by construction — the JS client owns positions natively; Rust never touches them. Negotiate `positionEncoding` in `initialize` where the server supports UTF-8. |
| **`file://` uri ↔ path** edge cases (Windows drive letters, spaces, symlinks). | A single tested `pathFromUri`/`uriFromPath` in `workspace.ts`; `requestFile` stays behind the scoped `read_file`, so a server can't escape the workspace. |
| **Server binary absent / thin GUI PATH** (a GUI launch often lacks `~/.local/bin`). | Detection searches known install dirs beyond PATH; absence degrades to a calm hint, never an error. |
| **Windows/Linux server-spawn parity** (stdio pipes, not ConPTY). | The relay uses ordinary piped stdio, simpler than the PTY path; still gate on the CI matrix (mac/win/ubuntu) like everything else. |

---

## Decision record

### Code intelligence via LSP: Rust relays, CodeMirror's client drives

**Status:** Accepted. Design in this document; confirmed by the slice-0 feasibility spike
(rust-analyzer definition round-trip).

**Context:** The product needs IntelliJ/VS-Code navigation — Cmd/Ctrl+Click →
go-to-definition, and Find All Usages for methods *and* variables. That is semantic,
cross-file, whole-project analysis: the Language Server Protocol. Our regex
`run_find` (M4) is complementary, not a substitute. The editor is CodeMirror 6;
the app already owns child processes behind an actor/`Channel` model, and WebKitGTK rules out webview workers/WASM for heavy servers (the same
reason Monaco was rejected).

**Decision:**
1. **Client location — split by concern.** Rust owns the **server process + framed
   byte transport** (spawn via `tokio::process` with piped stdio — *not* a PTY;
   Content-Length framing; lifecycle/restart; binary detection): a thin relay in a
   new `lsp/` actor mirroring the supervisor. The **JSON-RPC protocol client and
   document sync live in JS**, because the document (text, version, UTF-16 positions)
   lives in CodeMirror `EditorState`. Rejected: a fat Rust client with typed
   `lsp_definition`/`lsp_references` commands (duplicates a maintained lib; forces a
   Rust shadow of every buffer + UTF-8↔UTF-16 conversion), and a dumb raw-byte proxy
   (framing belongs in Rust).
2. **CM6 integration — adopt `@codemirror/lsp-client`** (MIT, by the CM6 author):
   ships definition/references/hover/completion/rename, a native find-references
   panel, and a host `Workspace` seam (`displayFile`/`requestFile`) that maps onto our
   `openEditorTab` + scoped `read_file`. Transport is a 3-method string interface
   backed by `lsp_send` (out) + a per-server `Channel<String>` (in). Fallback: the
   marimo fork.
3. **Servers — bring-your-own, detect, degrade, never bundle (v1).** A
   `LanguageId → LspServerSpec` table (command/args/install-hint/root-markers);
   detect on PATH + known install dirs; absent ⇒ feature off with a calm "install X"
   hint.
4. **Sync/workspace.** The JS client sends didOpen/didChange/didClose itself; one
   server per `(workspaceRoot, languageId)`, `rootUri` = our `workspaceRoot`, shared
   across that language's files so cross-file references resolve. **A references
   result before indexing completes is incomplete, not empty** (rust-analyzer
   especially) — reflect `$/progress`, never cache empty as "no usages."
5. **Build — sliced.** 0 feasibility spike · 1 go-to-definition (Rust/rust-analyzer,
   Cmd+Click+F12) · 2 find-usages panel · 3+ more languages. Real servers are
   integration-tested (binary-gated in CI); a committed **fake stub LSP server**
   gives deterministic pipeline tests. **First language: Rust.**

**Consequences:** A new `lsp/` Rust module + `src/features/editor/lsp/` FE module +
three commands (`lsp_start`/`lsp_send`/`lsp_stop`) added to the contract. New FE deps
(`@codemirror/lsp-client` + its MIT deps), all worker/wasm-free (WebKitGTK-safe).
LSP servers are a second heavy child-process fleet the app owns: reaped on
exit, restarted lazily after a reload in v1 (reattach is a later optimization). No
server bundling; code intelligence is present exactly where the user has the server
installed.
