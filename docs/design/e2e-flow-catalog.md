# Agent Studio — E2E Flow Catalog & Testability-Seam Audit

> **Status:** Authoritative catalog. This is the **contract** the two
> automated-test harnesses are built from — the CI/WebDriver tier and the macOS
> real-smoke tier (this doc feeds them the flows, selectors, gaps, and
> determinism seams).
>
> **Scope:** every user-facing flow in the shipped app, the selector each flow
> drives, the assertion that proves it worked, the tier it belongs to, the exact
> test hooks that are missing, and the minimal env-gated seam that makes each
> flow hermetic. **No app code is changed here** — but exact code locations for
> every seam and every hook-to-add are named.
>
> **Contract surface it builds on:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) §1–2
> (planes + command surface), [`testing-strategy.md`](./testing-strategy.md)
> (the 6-layer pyramid; §4 on why WebDriver E2E is an M4 add). This doc is the
> **layer-6** (real-app) map that §4 deferred — it exists so that when the E2E
> tier lands it has a spec, not a blank page.
>
> Verified against the source.

---

## 0. How to read this

**Two harness tiers, one catalog.** Each flow row carries a **Tier**:

| Tier | Runner | Real dependencies faked how |
|---|---|---|
| **CI** | WebDriver (`@wdio/tauri-service`, embedded provider — testing-strategy §4.1) on macOS + Ubuntu, **or** the existing layer-4/5 Vitest tier where a full app isn't needed | `claude` → stub binary (`AGENTSTUDIO_CLAUDE_BIN`); network → local `127.0.0.1` server; workspace → fixture dir launched as cwd; LSP → stub server (**seam to add**) |
| **Mac-smoke** | The manual smoke checklist on macOS (testing-strategy §4.3), later a WebDriver smoke on the packaged build | Nothing faked — real PTY bytes on the WebGL canvas, real `claude` fan-out, real rust-analyzer, real native folder picker |
| **Both** | The deterministic *shape* runs in CI (row appears, tab opens, IPC fired with right args); the *real payload* (TUI paints, transcript tree grows, definition resolves) is verified once by hand on Mac |

**Selector convention.** Prefer, in order: an existing `data-testid`, then an
`aria-label`/`role`+accessible-name, then a stable class. Every selector below is
the **actual** attribute found in the source (file:line). Where none exists the
cell says **⚠ GAP #n** and §2 lists the exact attribute to add.

**A note on layer.** Many of these flows are already covered deterministically at
layer 4 (RTL, IPC mocked) or layer 5 (browser). That coverage is cited, but this
catalog is the *end-to-end* contract: it assumes the whole app (Rust core + real
IPC + WebView) is under test unless a row says otherwise.

---

## 1. Flow catalog

Grouped by surface. `Mod` = Cmd on macOS, Ctrl elsewhere (the app checks
`e.metaKey || e.ctrlKey` everywhere — `shortcuts.ts:20`).

### 1.1 Left rail — the fleet (`src/features/fleet/**`)

| # | Flow | Entry point | Steps | Selector(s) — actual | Assertion | Tier |
|---|---|---|---|---|---|---|
| F1 | **Quick-launch agent** | ⚡ button | click ⚡ | `[aria-label="Quick-launch agent"]` (`LeftRail.tsx:52`) → row: `[role="treeitem"]` in `[role="tree"][aria-label="Agents"]` (`AgentTree.tsx:36`) | a new `treeitem` appears, selected (`aria-selected=true`); an `agent-terminal` tab opens in the focused pane; `agent_spawn` invoked with `{agentId, runtime:"claude-code", cwd}` (`fleetIpc.ts:90`) | Both |
| F2 | **Open project folder** | header `+` | click `+` → pick a folder in the OS dialog | `[aria-label="Open project folder"]` (`LeftRail.tsx:61`) | `setWorkspaceRoot(dir)` + `launchAgent(dir)` → row appears rooted at `dir`; right rail re-roots to `dir` | **Mac-smoke** (native `open({directory:true})` dialog is not WebDriver-drivable — see seam S9) |
| F3 | **New agent in folder** | per-folder `+` | expand a folder group, click its `+` | `[aria-label="New agent in {name}"]` (`FolderGroupRow.tsx:80`) | second `treeitem` appears **under the same folder header**; folder count badge increments (`[aria-label="{n} agents"]`) | Both |
| F4 | **Select agent (the pivot)** | agent row | click a row | `[role="treeitem"]` (`AgentRow.tsx:109`); active state `aria-selected` | clicked row gains `aria-selected=true`; its terminal tab activates; right-rail `workspace-tree` re-roots to that agent's cwd (`WorkspaceTree.tsx:30`) | CI |
| F5 | **Rename agent** | row title | double-click title → type → Enter | title `.fleet-row__title` (`AgentRow.tsx:166`); input `[aria-label="Rename agent {displayName}"]` (`AgentRow.tsx:157`) | after Enter the row + its tab both show the new name (agent-name is shared — `TabBar.tsx:99`); Esc cancels | CI |
| F6 | **Close / dismiss agent** | row ✕ | hover row, click ✕ | `[aria-label="Close agent {displayName}"]` (`AgentRow.tsx:197`) | row disappears from the tree; its agent-terminal tab closes; `terminal_close` fired for the agent id; agent is **tombstoned** (does not reappear on late telemetry) | Both |
| F7 | **Expand / collapse sub-agent** | disclosure caret | click ▸/▾ | `[aria-label="Expand {name}"]` / `[aria-label="Collapse {name}"]` (`AgentRow.tsx:137`) | children rows show/hide; collapsed parent shows roll-up text `.fleet-row__rollup` ("3 running · 1 done") | **Mac-smoke** (needs a real sub-agent tree — F26 seam) / CI once fan-out fixtures exist |
| F8 | **Expand / collapse folder** | folder header | click header | `[aria-label="Collapse folder {name}"]` / `[aria-label="Expand folder {name}"]` (`FolderGroupRow.tsx:60`) | agents under the folder show/hide; `aria-expanded` on the `treeitem` flips | CI |
| F9 | **Sub-agent activity view** | select a sub-agent | click a `subagent`-kind row | opens `[data-testid="activity-view"]` (`ActivityView.tsx:57`); status `.activity-view__status--{status}` | center shows the read-only activity feed (no terminal); polls `subagent_activity(agentId)` every 1.5 s | **Mac-smoke** / CI with `subagent_activity` stubbed to fixture entries |
| F10 | **Attention bubbling** | collapsed subtree w/ error | (derived — collapse a subtree with a `done`/`error` child) | `[aria-label="Attention needed below"]` (`AgentRow.tsx:181`); row class `fleet-row--attention` | attention dot renders on the collapsed ancestor; unread badge `[aria-label="{n} unread"]` bubbles up | **Mac-smoke** / CI with synthetic telemetry via store |
| F11 | **Empty fleet state** | boot, no agents | (none) | `.fleet-empty` text "No agents yet." (`AgentTree.tsx:27`) | the empty hint renders when `rootAgentIds` is empty | CI |

### 1.2 Center — panes & tabs (`src/components/PaneTree.tsx`, `Pane.tsx`, `TabBar.tsx`)

| # | Flow | Entry point | Steps | Selector(s) — actual | Assertion | Tier |
|---|---|---|---|---|---|---|
| P1 | **New terminal (empty pane)** | empty-pane button | click "New terminal" in an empty pane | button text "New terminal", class `.pane__button` — **⚠ GAP #1** (no testid/aria) | a `terminal`-kind tab appears; `terminal_open` fired; host `[data-terminal-id]` mounts (`TerminalView.tsx:37`) | Both |
| P2 | **New terminal tab (`+`)** | tab strip `+` | click `+` at end of strip | `[aria-label="New terminal tab"]` (`TabBar.tsx:273`) | a second `[role="tab"]` appears in the `[role="tablist"]` and becomes active | CI |
| P3 | **Switch tab** | a tab | click an inactive tab | `[role="tab"]` w/ accessible name = title (`TabBar.tsx:149`) | clicked tab gets `aria-selected=true`; its view shows in `.pane__body` | CI |
| P4 | **Close tab** | tab ✕ | click ✕ on a tab | `[aria-label="Close {displayName}"]` (`TabBar.tsx:188`) | tab removed; if it was the last tab the leaf collapses to the "New terminal" placeholder; PTY `terminal_close` fired | Both |
| P5 | **Middle-click close** | tab body | middle-click a tab | `[role="tab"]` `onAuxClick` (`TabBar.tsx:158`) | same as P4 | CI |
| P6 | **Rename tab** | tab title | double-click title → type → Enter | title `.pane-tab__title` (`TabBar.tsx:174`); input `[aria-label="Rename tab {displayName}"]` (`TabBar.tsx:167`) | tab shows new title; Esc reverts | CI |
| P7 | **Split pane right** | toolbar | click split-right | `[aria-label="Split pane right"]` (`Pane.tsx:36`) | two side-by-side panes render (an `allotment` split, `orientation:"row"`); the new leaf is empty + focused | CI |
| P8 | **Split pane down** | toolbar | click split-down | `[aria-label="Split pane down"]` (`Pane.tsx:44`) | two stacked panes (`orientation:"column"`) | CI |
| P9 | **Close pane** | toolbar | click close-pane | `[aria-label="Close pane"]` (`Pane.tsx:53`) | that leaf + its tabs close; siblings expand to fill; last pane becomes empty rather than vanishing | CI |
| P10 | **Drag tab → edge = split** | tab → pane edge | drag a tab, drop on a pane's left/right/top/bottom quarter | drag source `[role="tab"]` (mime `application/x-agentstudio-tab`, `TabBar.tsx:19`); preview `[data-testid="drop-zone"][data-zone]` (`PaneTree.tsx:122`) | a new split forms with the tab in a new leaf on that edge; `[data-zone]` matched the drop edge during hover | **Mac-smoke** (HTML5 DnD is unreliable under WebDriver) / layer-5 browser tier covers the geometry |
| P11 | **Drag tab → center = move** | tab → pane body | drop on a pane's center | same mime; center zone (`dropZone.ts` via `Pane.tsx:157`) | tab moves into the target pane, no split | **Mac-smoke** / layer-5 |
| P12 | **Reorder tab in strip** | tab → strip | drag a tab over the tab strip | strip `.pane__tabbar` `[role="tablist"]`; insertion line `.pane-tab--insert-before/after` | tab lands at the drop index, no split (strip wins the hit-test — `Pane.tsx:150`) | **Mac-smoke** / layer-5 |

### 1.3 Terminals (`src/features/terminal/**`)

| # | Flow | Entry point | Steps | Selector(s) — actual | Assertion | Tier |
|---|---|---|---|---|---|---|
| T1 | **Type into terminal** | focused terminal | type `echo hi⏎` | host `[data-terminal-id="{id}"]` (`TerminalView.tsx:37`) | `terminal_write` fired with the keystroke bytes; child echoes | **Mac-smoke** (canvas has no assertable DOM text — see below) |
| T2 | **Output renders** | any command | run a command with output | (canvas — no DOM text under WebGL) | output visible; scrollback intact; assert via `@xterm/addon-serialize` (`serializeTerminal()`, `TerminalRegistry.ts:724`) or force DOM renderer | **Mac-smoke** (see testing-strategy §4.2 pt.2) |
| T3 | **Resize / fit** | split or window resize | split a pane, or resize window | (ResizeObserver-driven) | `terminal_resize` fired with post-fit rows/cols; **never** the 2-col clamp floor (`applyFit`, `TerminalRegistry.ts:300`) | Layer-5 browser (`terminalFit.browser.test.tsx`) — the jsdom-invisible bug class |
| T4 | **Scrollback wheel under TUI** | mouse-tracking app | run `claude`, wheel-up | (custom wheel handler, `TerminalRegistry.ts:214`) | scrollback scrolls even while the app has grabbed the mouse | **Mac-smoke** (needs a real mouse-tracking TUI) |
| T5 | **Reattach after reload** | webview reload | reload the window while a PTY is live | `terminal_reattach` (`ipc.ts:132`); rebuilt via `rebuildTerminalTabs` (`store.ts`) | tabs come back; live PTY re-subscribes (`status:"live"`), dead one shows `[process exited]` | **Mac-smoke** (Rust core must survive a real reload) |

### 1.4 Editor (`src/features/editor/**`, opened from `src/features/workspace/**`)

| # | Flow | Entry point | Steps | Selector(s) — actual | Assertion | Tier |
|---|---|---|---|---|---|---|
| E1 | **Open file** | workspace tree | click a file node | file node `.workspace-node--file` (name in child span, `title={name}`) — **⚠ GAP #6** (no per-node testid/path attr); result `[data-testid="code-editor"][data-path]` (`CodeEditor.tsx:42`) | an editor tab opens; `code-editor` shows the file's basename + content; `read_file` fired | CI (fixture workspace) |
| E2 | **Edit + Save (`Mod-S`)** | editor | focus editor, type, `Mod-S` | editor host `.code-editor__host`; keymap `Mod-s` (`EditorRegistry.ts:91`) | tab dirty dot appears while typing, clears on save; `write_file` fired; "Saved" flash | CI (fixture workspace; asserting the dirty dot + `write_file` args) |
| E3 | **Save button** | header | edit → click Save | button text "Save", class `.code-editor__save` — **⚠ GAP #2** (no testid/aria) (`CodeEditor.tsx:52`) | same as E2; button only present while `dirty && status==="ready"` | CI |
| E4 | **Unsaved-changes dialog** | close dirty tab | edit, click tab ✕ → Save/Discard/Cancel | dialog `[role="dialog"][aria-label="Unsaved changes"]` (`UnsavedChangesDialog.tsx:34`); buttons text "Save"/"Discard"/"Cancel" — **⚠ GAP #3** | Save writes then closes; Discard closes losing edits; Cancel keeps the tab | CI |
| E5 | **Large / binary file gate** | tree | open a >2 MB or binary file | `.code-editor__state` "Can't preview this file." (`CodeEditor.tsx:67`) | oversized/binary → read-only or "can't preview"; no crash | CI (fixture: a big/binary file) |
| E6 | **Syntax highlighting** | any code file | open a `.rs`/`.ts` file | (CM6 + Shiki spans) | tokens colorised; verify a known keyword span carries a highlight class | CI / layer-5 |

### 1.5 Code intelligence — LSP (`src/features/editor/lsp/**`)

> All five need a **running language server**. There is **no env seam** to point
> `lsp_start` at a fake server today (the `Prober` stub is unit-test-only) — see
> **⚠ GAP #10 / seam S6**. Until that lands, the full path is **Mac-smoke**; the
> store-driven *rendering* half (references panel, indexing indicator) is CI via
> the `lspReferences` / `lspIndexing` store seams.

| # | Flow | Entry point | Steps | Selector(s) — actual | Assertion | Tier |
|---|---|---|---|---|---|---|
| L1 | **Mod-hover underline** | symbol | hold Mod, move mouse over a symbol | decoration class `.cm-lsp-underline` (`hoverDefinition.ts:48`) | the symbol under the cursor underlines once a definition resolves; releasing Mod removes it | **Mac-smoke** (real rust-analyzer) |
| L2 | **Mod-Click go-to-def** | symbol | Mod+Click a use | `mousedown` handler (`definition.ts:129`) | cursor jumps to the declaration (same or other file via `revealInEditor`) | **Mac-smoke** |
| L3 | **F12 go-to-def** | cursor on symbol | press F12 | keymap `F12` (`definition.ts:124`) | same jump as L2, at the caret | **Mac-smoke** |
| L4 | **Shift+F12 find usages** | cursor on symbol | press Shift+F12 | keymap `Shift-F12` (`definition.ts:125`) | references panel opens (`[data-testid="references-panel"]`) with usages | **Mac-smoke** for the query; **CI** for the panel via `lspActions.setReferences` |
| L5 | **References panel — open a hit** | references panel | click a usage row | `[data-testid="references-panel"]`, `[data-testid="reference-file"]`, `[data-testid="reference-hit"]` (`ReferencesPanel.tsx:104,142,159`) | clicking a hit reveals it in the editor **and closes the panel**; Esc/✕ (`[aria-label="Close usages"]`) also close | CI (drive `setReferences` with fixture hits, then click) |
| L6 | **Indexing indicator** | cold server | trigger a query while rust-analyzer indexes | `.lsp-status--indexing` "…: indexing…" (`LspStatus.tsx:23`) — **⚠ GAP #11** (no testid) | indicator shows while `lspIndexing` includes the language; clears when resolved | CI (drive `setLspIndexing`) |
| L7 | **Install hint + dismiss** | server absent | open a file whose server isn't installed | `.lsp-status--hint` + `[aria-label="Dismiss"]` (`LspStatus.tsx:31`) | calm "install <server>" hint; dismiss hides it for the session | CI (drive `setLspInstallHint`) |

### 1.6 Workspace tree (`src/features/workspace/**`)

| # | Flow | Entry point | Steps | Selector(s) — actual | Assertion | Tier |
|---|---|---|---|---|---|---|
| W1 | **Expand folder (lazy)** | dir node | click a folder | dir node `.workspace-node--dir` `[role="treeitem"][aria-expanded]` (`WorkspaceTree.tsx:140`) — **⚠ GAP #6** (no path/testid) | `read_dir` fires on first expand only; children render; `aria-expanded` flips | CI (fixture workspace) |
| W2 | **Collapse folder** | dir node | click an open folder | same | children hide; no second `read_dir` (cached) | CI |
| W3 | **Re-root on select** | agent select | select a different agent | root header `.workspace-tree__root`; container `[data-testid="workspace-tree"]` (`WorkspaceTree.tsx:165`) | tree re-roots to the new agent's cwd (keyed remount) | CI |
| W4 | **Failed-read note** | unreadable dir | expand a dir that errors | `.workspace-tree__note` "Can't read this folder." | calm inline note; rest of the tree survives | CI (fixture: a perms-denied or out-of-scope dir) |
| W5 | **Empty / no-selection state** | boot | no agent selected, no root | `[data-testid="workspace-tree"]` "Select an agent…" (`WorkspaceTree.tsx:53`) | placeholder renders when `workspaceRoot` is null | CI |

### 1.7 Find in files (`src/features/find/**`)

| # | Flow | Entry point | Steps | Selector(s) — actual | Assertion | Tier |
|---|---|---|---|---|---|---|
| S1 | **Open Find** | `Mod+Shift+F` | press the hotkey | overlay `[data-testid="find-in-files"]` `[role="dialog"][aria-label="Find in files"]` (`FindInFiles.tsx:198`) | overlay appears; input `[aria-label="Search in files"]` focused | CI |
| S2 | **Type → results** | search input | type a query | input `[aria-label="Search in files"]` (`FindInFiles.tsx:205`); count `[data-testid="find-count"]` | after debounce, `find_in_files` fired; `[data-testid="find-file"]` groups + `[data-testid="find-match"]` rows render; count text "N matches in M files" | CI (fixture workspace) |
| S3 | **Toggle case / word / regex** | toggles | click Cc / W / .* | `[aria-label="Case sensitive"]`, `[aria-label="Whole word"]`, `[aria-label="Regular expression"]` w/ `aria-pressed` (`FindInFiles.tsx:213,223,233`) | re-runs the search with the option; `aria-pressed` flips | CI |
| S4 | **File mask** | mask input | type a glob | `[aria-label="File mask"]` (`FindInFiles.tsx:244`) | results narrow to matching files | CI |
| S5 | **Collapse file group** | group header | click a file header | `[data-testid="find-file"]` `[aria-expanded]` | that file's matches hide | CI |
| S6 | **Open a match** | match row | click a match | `[data-testid="find-match"]` (`FindInFiles.tsx:356`) | opens the file at the line (`revealInEditor`) **and closes the overlay** | CI |
| S7 | **Close Find** | Esc / ✕ | press Esc, or click ✕ | `[aria-label="Close search"]` (`FindInFiles.tsx:250`) | overlay disappears | CI |
| S8 | **Truncated results** | broad query | search that exceeds caps | `[data-testid="find-truncated"]` (`FindInFiles.tsx:325`) | truncation note shows (Rust caps: 1000 matches / 500 files, `find.rs:22`) | CI (fixture with many hits) |

### 1.8 API client (`src/features/api/**`)

| # | Flow | Entry point | Steps | Selector(s) — actual | Assertion | Tier |
|---|---|---|---|---|---|---|
| A1 | **Open request tab** | titlebar globe | click the globe | `[aria-label="New API request"]` (`ApiRequestButton.tsx:14`) → `[data-testid="api-request"]` (`ApiRequestView.tsx:115`) | a GET request tab opens (globe icon) | CI |
| A2 | **GET request** | request tab | type URL → Send | method `[aria-label="HTTP method"]`, url `[aria-label="Request URL"]`, send button text "Send" class `.api-send` — **⚠ GAP #4**; response `[data-testid="api-response"]`, status `[data-testid="api-status"]`, body `[data-testid="api-response-body"]` | `http_send` fired; `api-status` shows 200; `api-response-body` shows the body; `.api-response__stat` shows ms + size | Both (CI vs a local server; Mac vs a real host) |
| A3 | **POST request** | request tab | select POST → type body → Send | method `[aria-label="HTTP method"]` (select POST), body `[aria-label="Request body"]` (only shown for POST/PUT/PATCH/DELETE) | body editor appears; `http_send` request carries `method:"POST"` + the body; response renders | CI (local echo server) |
| A4 | **Headers** | headers section | Add header → type name/value → uncheck | add button "+ Add header" `.api-add-header` — **⚠ GAP #5**; row `[data-testid="api-header-row"]` w/ `[aria-label="Header enabled/name/value"]`, `[aria-label="Remove header"]` | only enabled, named headers travel on the wire; remove drops the row | CI |
| A5 | **Mod+Enter sends** | url / body | `Mod+Enter` in URL or body | `onKeyDown` (`ApiRequestView.tsx:107`) | same as A2/A3 | CI |
| A6 | **Response error** | request tab | Send to an unreachable host | `[data-testid="api-error"]` `[role="alert"]` (`ApiRequestView.tsx:222`) | calm error block (transport failure → Rust `Err` string) | CI (point at a closed `127.0.0.1` port) |
| A7 | **Truncated response** | request tab | fetch a >8 MiB body | `[data-testid="api-truncated"]` (`ApiRequestView.tsx:242`) | "truncated" badge (Rust cap 8 MiB, `http.rs:32`) | CI (local server serving a large body) |

### 1.9 Shortcuts overlay (`src/features/shortcuts/**`)

| # | Flow | Entry point | Steps | Selector(s) — actual | Assertion | Tier |
|---|---|---|---|---|---|---|
| K1 | **Open shortcuts** | `Mod+/` or ⌨ button | press `Mod+/`, or click the button | button `[aria-label="Keyboard shortcuts"]` (`ShortcutsPanel.tsx:100`); panel `[data-testid="shortcuts-panel"]` `[role="dialog"][aria-label="Keyboard shortcuts"]` | overlay opens; grouped shortcut list renders (`Mod+/` toggles) | CI (already: `ShortcutsPanel.test.tsx`) |
| K2 | **Close shortcuts** | Esc / ✕ / backdrop | press Esc, click ✕, or click backdrop | close `[aria-label="Close shortcuts"]`; backdrop `[data-testid="shortcuts-backdrop"]` | overlay closes; a click **inside** the card does not close | CI (already covered) |

### 1.10 Boot & global

| # | Flow | Entry point | Steps | Selector(s) — actual | Assertion | Tier |
|---|---|---|---|---|---|---|
| B1 | **App boots to 3-pane shell** | launch | start the app | left `[data-testid="left-rail"]`; center `.center` → `.pane-tree`; right `[data-testid="workspace-tree"]`; titlebar `.titlebar` — **⚠ GAP #12** (no app-root testid) | all three rails paint; center shows one empty pane with "New terminal" | Both (Mac: real window; CI: DOM present) |
| B2 | **Workspace seeded** | boot | (automatic) | (bridge → `default_workspace`) | `workspaceRoot` set to git-root-of-launch; new terminals/agents open there | CI (launch in a fixture git repo) |
| B3 | **Snapshot rebuild** | reload | reload with live PTYs | (bridge → `fleet_snapshot` → `rebuildTerminalTabs`) | agents + terminal tabs reappear after a reload | **Mac-smoke** |

---

## 2. Test-hook gap list (punch list)

Every element a flow above must target that **lacks a stable, semantic hook
today**. Additions are minimal — one attribute each — and should reuse the
existing `data-testid` / `aria-label` conventions already dense in this codebase.

| # | Element | File · component | Problem | Add (minimal, semantic) |
|---|---|---|---|---|
| **1** | Empty-pane **"New terminal"** button (P1) | `src/components/Pane.tsx:101` `EmptyPane` | Only a text label, and "New terminal" collides with the TabBar `+` (`aria-label="New terminal tab"`). No unique hook. | `data-testid="empty-pane-new-terminal"` (or `aria-label="New terminal"`) on the button |
| **2** | Editor **Save** button (E3) | `src/features/editor/CodeEditor.tsx:52` | Text-only; save is a headline flow ("Cmd/Ctrl+S"). | `data-testid="editor-save"` + `aria-label="Save file"` |
| **3** | Unsaved-changes **Save/Discard/Cancel** (E4) | `src/features/editor/UnsavedChangesDialog.tsx:39-50` | Text-only buttons; drivable via `getByRole('button',{name})` but brittle across copy changes. | `data-testid="dialog-save"` / `"dialog-discard"` / `"dialog-cancel"` |
| **4** | API **Send** button (A2/A3) | `src/features/api/ApiRequestView.tsx:138` | Text flips "Send"↔"Sending…", so name-based lookup is racy. | `data-testid="api-send"` + `aria-label="Send request"` |
| **5** | API **+ Add header** button (A4) | `src/features/api/ApiRequestView.tsx:146` | Text-only. | `aria-label="Add header"` |
| **6** | Workspace **file/dir nodes** (E1, W1) | `src/features/workspace/WorkspaceTree.tsx:121,145` | The clickable node div has **no accessible name** (name is a nested span) and **no path attribute**, so "open file X" can't be targeted deterministically — only `title={name}` exists. | `data-path={entry.path}` on the `.workspace-node` div (+ optional `data-testid="ws-file"`/`"ws-dir"`). Path is the natural stable key. |
| **7** | Terminal surface assertability (T2) | `src/features/terminal/TerminalView.tsx:37` | Host has `data-terminal-id` (good for *presence*), but under WebGL the content is a canvas — no text to assert. | No DOM change; document that content assertions go through `serializeTerminal(id)` (`TerminalRegistry.ts:724`) exposed to the harness, or a test-only DOM-renderer flag. |
| **8** | Right-rail **Files/Find/Vault** tabs | `src/App.tsx:44-47` | Static `<span>`s — **not interactive** (the real Find is the `Mod+Shift+F` overlay; Vault is a stub). A harness could mistake them for controls. | Either wire them or mark `aria-disabled` + `data-testid="rail-tab-{files\|find\|vault}"`; document that clicking "Find" here does nothing. |
| **9** | App root / shell (B1) | `src/App.tsx:18` | `className="app"` only; "shell painted" smoke has no single anchor. | `data-testid="app-shell"` on the root div |
| **10** | LSP **fake-server seam** (L1–L4) | `src/lsp/commands.rs:19` + `src-tauri/src/lsp/registry.rs` | `lsp_start` resolves the binary via `SystemProber` only; **no env override** exists (unlike `AGENTSTUDIO_CLAUDE_BIN`). CI cannot drive go-to-def without a real rust-analyzer. | Add an env seam, e.g. `AGENTSTUDIO_LSP_BIN_{LANG}` (or a generic `AGENTSTUDIO_LSP_BIN`) consulted in `SystemProber::which` / a new `detect_with` override, pointing at a fixture stdio LSP server. This is the **one seam the codebase is missing** for CI E2E. |
| **11** | **LspStatus** indicator (L6) | `src/features/editor/LspStatus.tsx:23,29` | Class-only (`.lsp-status--indexing`/`--hint`). | `data-testid="lsp-status"` + `data-state="indexing\|hint"` |
| **12** | **AgentStatusPill** (F1, F7) | `src/features/fleet/AgentStatusPill.tsx:24` | Class `fleet-pill--{status}` + text; a `data-status` would make status assertions robust. | `data-status={status}` on the pill span |
| **13** | **Tab** element kind (P10–P12) | `src/components/TabBar.tsx:149` | `[role="tab"]` name = title, but drag-split flows want to target a tab by kind/id. | `data-tab-id={tabId}` + `data-tab-kind={tab.kind}` on the tab div |

**Priority within the gap list:** #10 (LSP seam) unblocks an entire flow family
for CI and is the only *Rust* change; #1, #4, #6 unblock the smoke-core flows
(new terminal, API, open file). The rest are robustness upgrades.

---

## 3. Determinism seams — per real dependency

For each flow family: the **real dependency** it hits, and the **minimal
env-gated seam** that makes it hermetic in CI. Existing seams are marked
✅ (already in the code); **⚠ to-add** means the seam does not exist yet.

| Seam | Real dependency | Flows | Minimal hermetic seam · file · guard | Status |
|---|---|---|---|---|
| **S1 — fake agent binary** | `claude` CLI spawned in a PTY (needs auth + network) | F1, F3, F6 | `AGENTSTUDIO_CLAUDE_BIN` → a stub script that prints a banner and stays alive (and, for fan-out, writes a fixture transcript tree). **`src-tauri/src/agent/claude.rs:29`** (`CLAUDE_BIN_ENV`, checked first in `resolve_binary`). | ✅ exists |
| **S2 — fast fan-out poll** | 1 s transcript poll loop | F7, F9, F10 | `AGENTSTUDIO_FANOUT_POLL_MS=50`. **`src-tauri/src/supervisor/mod.rs:1240`** (`fanout_poll()`). Combine with S1 + S8. | ✅ exists |
| **S3 — ad-hoc hook** | `claude` typed in a plain shell POSTs to a localhost listener | (ad-hoc promote → F4/F6) | `AGENTSTUDIO_HOOK_URL` / `AGENTSTUDIO_HOOK_TOKEN` / `AGENTSTUDIO_TERMINAL_ID` injected into every PTY; the listener binds localhost. Drive by POSTing to it directly (Rust-integration). **`src-tauri/src/agent/hook.rs:18-29`**, `hook_listener.rs`. | ✅ exists |
| **S4 — real PTY, fixed shell** | `$SHELL` PTY | P1, P2, T1–T3 | Launch CI with `SHELL=/bin/sh`; use a deterministic command (`echo`). PTY itself is real and hermetic (no network). **`src-tauri/src/pty/mod.rs:87`** (`$SHELL` default). Output assertion needs S5. | ✅ (env is standard) |
| **S5 — terminal content readback** | WebGL canvas has no DOM text | T2 | Assert via `@xterm/addon-serialize` — `serializeTerminal(id)` (`TerminalRegistry.ts:724`), or `setRendererPreference('dom')` for the test build (note: DOM is the Linux fallback path, so this tests a path Mac/Win users don't run — hence T2 stays Mac-smoke for the *real* renderer). | partial — helper exists, not exposed to a harness |
| **S6 — fake LSP server** | rust-analyzer resolved on PATH + real ~5–9 s indexing | L1–L4 | **⚠ to-add** (gap #10): `AGENTSTUDIO_LSP_BIN` env consulted before `SystemProber::which`, pointing at a fixture stdio LSP that answers `textDocument/definition`/`references` from a canned table. **`src-tauri/src/lsp/registry.rs:151`** (`SystemProber::which`) / `commands.rs:19`. Until then L1–L4 are Mac-smoke; the panel/indicator halves (L5–L7) are CI via the `lspReferences`/`lspIndexing`/`lspInstallHints` **store seams** (`store.ts` `lspActions`). | ⚠ to-add |
| **S7 — local HTTP server** | `reqwest` to an arbitrary host | A2, A3, A6, A7 | No env needed — the URL is user input. The harness binds a `127.0.0.1:0` fixture server (canned GET body, echo POST, a >8 MiB body for A7, and a closed port for A6) and types its URL. **Pattern already proven in** `src-tauri/src/http.rs:259` (`spawn_server`). Fully CI-deterministic. | ✅ (no code change; reuse the test pattern) |
| **S8 — fixture workspace** | `read_dir`/`read_file`/`write_file`/`find_in_files` over the real FS, **scoped to `allowed_roots`** | E1–E5, W1–W5, S1–S8, B2 | Launch the app with **cwd = a fixture git repo**; `default_workspace` returns it (`workspace.rs:26`, git-root-of-launch), so `workspaceRoot` = fixture and the scope guard (`fs_tree.rs:59` `resolve_in_scope`) admits it. All fs/find/save flows then run against committed fixture files in a temp dir. `write_file` (E2/E3) is safe — it writes inside the temp workspace. | ✅ (launch-cwd, no code change) |
| **S9 — native folder picker** | `open({directory:true})` OS dialog (`tauri-plugin-dialog`) | F2 | **Not WebDriver-drivable** (OS-native modal). Two options: (a) in a Vitest/component tier, mock `@tauri-apps/plugin-dialog`'s `open`; (b) in real E2E, **avoid** the picker — use ⚡ quick-launch (F1) or per-folder `+` (F3) against the S8 fixture workspace, and cover the picker path in Mac-smoke only. **`src/features/fleet/LeftRail.tsx:33`**. | Mac-smoke for the dialog; mockable in component tier |
| **S10 — telemetry / store seams** | `agent://event` stream, `fleet_snapshot` | F10, L5–L7, and any "reducer produces the right shape" | Drive the store directly (`applyAgentEvent`, `applyFleetSnapshot`, `setReferences`, `setLspIndexing`) — layer-4, IPC-free (testing-strategy §2 seam D). This is where the *rendering* of fan-out/rollup/references is proven deterministically, independent of Rust. | ✅ exists (store actions) |

**Flows that are irreducibly Mac-smoke-only** (cannot be made deterministic in
CI, with the reason):

- **T1, T2, T4** — real PTY bytes on the WebGL canvas: no DOM text to assert; the
  serialize-addon readback is a weaker proxy, and the *renderer* itself (WebGL vs
  the DOM fallback) is exactly what a forced-DOM test would stop exercising
  (testing-strategy §4.2).
- **F7, F9, F10 (real payload)** — a genuine `claude` fan-out tree requires a real
  `claude` writing a real transcript. The *shape* (rows nest, roll-up computes) is
  CI via S1+S2+S8 with a stub that writes fixture transcripts, or via S10; the
  *real* recursive spawn is Mac-smoke.
- **L1–L4** until **S6** exists — real rust-analyzer + real indexing latency is
  nondeterministic (retries on `-32801` for 5–9 s). Add the fake-LSP seam to move
  these to CI.
- **F2 (the picker step)** — the OS-native folder dialog (S9).
- **P10–P12** — HTML5 drag-and-drop is unreliable under WebDriver; the geometry is
  already covered at layer-5 (`dropPreview.browser.test.tsx`,
  `paneLayout.browser.test.tsx`), so the E2E value is low.
- **B3, T5** — reattach requires the Rust core to survive a real webview reload,
  which only a real app exercises.

---

## 4. Priority order

### 4.1 Smoke core (the 8 highest-value flows)

These are the critical flows plus the end-to-end spine
(launch → agent → terminal → open file → go-to-def → find → API GET/POST). They
are the manual smoke checklist today and the first WebDriver specs when the
E2E tier lands (testing-strategy §4.2).

1. **B1 — App boots to the 3-pane shell.** (anchor: gap #9 `app-shell`)
2. **P1 — New terminal** → tab opens, prompt appears. (`terminal_open`; gap #1)
3. **F1 — Create agent (⚡ quick-launch)** → row appears + agent-terminal tab.
   (`agent_spawn` via seam **S1**)
4. **E1 — Open a file** from the workspace tree → editor tab with content.
   (seam **S8**; gap #6)
5. **F6 / P4 — Close them** — dismiss the agent (row ✕) and close the terminal tab;
   both tear down the PTY (`terminal_close`).
6. **S1→S6 — Find in files**: `Mod+Shift+F` → type → click a match → file opens +
   overlay closes. (seam **S8**)
7. **A2 — API GET**: globe → URL → Send → 200 + body. (seam **S7**; gap #4)
8. **A3 — API POST**: method POST → body → Send → response. (seam **S7**)

Go-to-definition (**L2/L3**) is the Cmd-hover underline flow and belongs in the
spine, but it is **gated on seam S6 (fake LSP)**; until that exists it rides the
Mac-smoke checklist rather than CI. The store-driven half (L5 references panel,
L6 indexing) can enter the CI smoke immediately via **S10**.

### 4.2 Fuller regression set (after the smoke core is green)

- **Layout depth:** P2, P3, P5–P9 (tabs, splits, close-pane) — CI, cheap.
- **Fleet depth:** F3–F5, F8, F11 (folder `+`, select-pivot, rename, folder
  disclosure, empty state) — CI.
- **Editor depth:** E2–E6 (save, dialog, large-file gate, highlighting) — CI via S8.
- **Find depth:** S3–S5, S7, S8 (toggles, mask, collapse, close, truncation) — CI.
- **API depth:** A4–A7 (headers, Mod+Enter, error, truncated) — CI via S7.
- **Shortcuts:** K1, K2 — CI (already covered by `ShortcutsPanel.test.tsx`).
- **Workspace depth:** W1–W5 — CI via S8.
- **LSP full path:** L1–L7 — enters CI regression once seam S6 lands; Mac-smoke
  until then.
- **Mac-smoke-only regression (per-milestone manual):** T1–T5 (terminal I/O,
  fit, scrollback, reattach), F2 (picker), F7/F9/F10 real fan-out, P10–P12 (drag
  splits), B3.

---

## 5. Command-surface cross-reference (what each flow really invokes)

The Rust commands each flow triggers (from `src-tauri/src/lib.rs:94` handler list)
— i.e. what the harness must fake or provision:

| Command | Flows | Real effect · determinism seam |
|---|---|---|
| `agent_spawn` | F1, F3 | Spawns `claude` in a PTY + starts fan-out tailer → **S1** (+S2 for tailer) |
| `terminal_open` | P1, P2 | Spawns `$SHELL` in a PTY → **S4** (real, hermetic) |
| `terminal_write` / `_resize` / `_close` | T1, T3, P4, F6 | Keystrokes / SIGWINCH / kill child → real PTY, hermetic |
| `terminal_reattach` | T5, B3 | Re-subscribe to a live PTY → **Mac-smoke** (needs reload) |
| `fleet_snapshot` | B3 | Initial paint / re-attach → S10 (or stub to `{agents:[],terminals:[]}`) |
| `subagent_activity` | F9 | Reads `~/.claude/.../subagents/*.jsonl` → stub to fixture entries |
| `default_workspace` / `recent_projects` / `push_recent_project` | B2, F1–F3 | git-root / persisted recents → **S8** (launch-cwd) |
| `read_dir` / `read_file` / `write_file` | E1–E5, W1–W5 | FS scoped to `allowed_roots` → **S8** (fixture workspace) |
| `find_in_files` | S1–S8 | ripgrep-libs over the tree, scoped → **S8** |
| `lsp_start` / `lsp_send` / `lsp_stop` | L1–L7 | Spawns rust-analyzer, framed JSON-RPC relay → **S6 (to-add)** |
| `http_send` | A2–A7 | `reqwest` to any host → **S7** (local `127.0.0.1` server) |

---

## 6. Summary for the harness authors

- **Existing hooks are dense and good** — `data-testid`s exist for the API view,
  find, references, activity, workspace, shortcuts, left-rail, editor, and the
  drop-zone; ARIA labels cover every fleet control, pane toolbar, tab close, and
  find/api input. The catalog above cites the actual attribute for each flow.
- **13 gaps** (§2), all one-attribute fixes, and **only one is Rust** (gap #10 /
  seam **S6**, the fake-LSP env override). The smoke-core-blocking gaps are #1
  (empty-pane New terminal), #4 (API Send), #6 (workspace node path).
- **Seams:** four determinism seams already exist in the code
  (`AGENTSTUDIO_CLAUDE_BIN`, `AGENTSTUDIO_FANOUT_POLL_MS`, the `AGENTSTUDIO_HOOK_*`
  ad-hoc trio, and launch-cwd for the workspace); HTTP needs only the local-server
  test pattern already in `http.rs`; **LSP needs a new env seam**.
- **Tiering:** the layout/tab/find/API/editor-open/save/shortcuts flows are all
  CI-deterministic (WebDriver + stub `claude` + local HTTP + fixture workspace).
  Terminal byte-output, real `claude` fan-out, real go-to-def, drag-splits, the
  native folder picker, and reattach are **Mac-smoke-only**, each for a stated
  reason (canvas/renderer, real transcript, indexing nondeterminism, HTML5 DnD,
  OS dialog, real reload).
