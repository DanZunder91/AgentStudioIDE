# Tab tear-off — moving a tab into its own OS window

> **Status — built.** How the built feature differs from §7's recommendation:
> - **Both shapes together**, not "command first, drag later". Tab
>   context menu "Move to New Window" / "Move to Main Window", plus drag-out (released outside the
>   window frame → new window at the cursor) and drag-onto-another-window (merge back, via a `give` mail).
>   The gesture uses HTML5 `dragend` + `cursorPosition()`/`outerPosition()` (§5's pointer-capture
>   rewrite was not needed); `dragDropEnabled:false` is untouched. On Wayland the gesture is inert, the
>   command works.
> - **Movable kinds widened** beyond terminals: terminal, agent-terminal, editor (unsaved text + undo
>   carried as CM6 state JSON), diff, metrics, agent-logs, network, village. Not movable: api-request,
>   sequence, db-console, session-picker, agent-activity.
> - **All five §4 prerequisites done**: `tearoff-*` capability (`core:default` only; window mutation
>   only through Rust commands); `layout_prefs_save` refuses non-main windows; detached windows run no
>   app-wide pollers; Close Tab is `emit_to` the focused window AND the JS listener passes its own label
>   (emit_to alone does not scope); `TerminalRegistry.abandon()` exists.
> - **The 2×1 resize prerequisite** is handled for reattach: a reattached terminal sends no resize until
>   it has been fitted once.
> - **Rehydration list** (§7 Q2): lost in a move = scrollback past the 256 KB ring, selection,
>   find query. Not done: restoring detached windows after restart; one LSP per window (LSP is
>   main-window only).
>
> The rest of this note is the design investigation, kept for its measurements.

The investigation covers three areas (Tauri mechanics, our own state, prior art), so the design
rests on measurements rather than on what the gesture looks like in Chrome.

**The requirement:** move a tab out of the main window into a separate window of its own. Today
everything lives in one window with different tabs; the goal is to drag a tab out with the
mouse, the way a Chrome tab is dragged out, and have that create a second window.

---

## 1. The organizing rule

> **Tear-off is available if and only if the tab's content lives in the OS window hierarchy rather
> than in the DOM of one renderer.**

Figma said it themselves when they moved to `BrowserView`: *"while webview is part of the DOM
hierarchy, BrowserView lives in the operating system window hierarchy… very similar to how Chrome
manages its tabs"* — and named the price: *"you can no longer use the normal HTML and CSS positioning
and layering primitives."*

Chrome, Chrome DevTools and Figma are on one side of that line. Slack, Notion, Postman and the
archived `electron-tabs` are on ours — and **all of them ship a command, not a gesture.** Our
xterm.js-in-React terminals and CodeMirror editors put us with Slack, regardless of effort.

## 2. The three facts that govern the design

1. 🔴 **Tauri cannot give a second window a shared JS context.** Every `WebviewWindow` is a separate
   realm with its own module instances and its own Zustand store. **This is why the VS Code
   implementation cannot be copied**: its floating editors are `window.open('about:blank')` auxiliary
   windows with cloned stylesheets — *the same renderer, a second document* — which is why their
   release notes can say edits "automatically sync" with no machinery at all. Every torn-off tab here
   crosses a serialization boundary.
2. ✅ **The PTY is already safe, and the scary half is already done.** The process is owned in Rust
   (`pty/mod.rs:64`, keyed at `supervisor/mod.rs:430`), and `PumpControl::Reattach`
   (`coalesce.rs:43-47`) swaps a pump's sink and replays its 256 KB ring — it is *not* webview-scoped.
   This is the same conclusion Windows Terminal reached the hard way: its 2019 spec prototyped passing
   ConPTY handles between processes, concluded *"more questions than answers… it will decrease
   reliability"*, and noted the alternative — *"all we need to relay is the information required to
   redirect the drawing/input targets."* What shipped in 1.18 was **"all instances now run in the same
   process."**
3. 🔴 **The unsafe half is the DOM-side state**, which no reference app has to solve because none of
   them tear off a half-typed buffer: scrollback position, selection, the find-bar state, and CodeMirror undo history (`undoHistory.ts:59`, a cache the new window cannot see).
   The rehydration list must be an explicit decision, not polish.

## 3. What each tab kind would cost

| Kind | Backed by | Re-create | **Lost in the move** | Needs Rust? |
|---|---|---|---|---|
| `terminal` / `agent-terminal` | xterm + `Channel`, `TerminalRegistry.ts:161` | `terminal_reattach` **exists** | scrollback past **256 KB** (xterm holds 5 000 lines), selection, find-bar state | already solved |
| `diff` | MergeView, re-fetched on mount | free | scroll position | no — cheapest |
| `session-picker`, `agent-activity` | component-local + a poller | free | nothing | no |
| `editor` | CM6 view + undo, `EditorRegistry.ts:71` | re-reads disk | 🔴 **unsaved edits**, undo stack | no, but no transfer mechanism exists |
| `metrics` | its own store singleton | free | its one-instance guarantee | no |
| `api-request` / `sequence` | store + `http_send` | copy the record | in-flight response lands in the *origin* context; live WS stream; 🔴 `sequence.captured` holds live bearer tokens | yes |
| `db-console` | a live Rust `DbSessionId` | close + reopen, or hand the handle over | the running query; "one console per connection" is enforced *per store* | yes |

**The function nobody has:** `TerminalRegistry` offers `detach` (keeps the entry) and `dispose`
(kills the PTY, `:712`). A hand-off needs **"abandon without killing"**, which does not exist.
`serializeTerminal()` (`:744-753`) is in the tree, unused, and can carry scrollback past the ring.

## 4. Five prerequisites, none of them throwaway

1. 🔴 **`capabilities/default.json` is `"windows": ["main"]`.** A window under any other label gets
   **zero** `plugin:` permissions — no `listen()` for `agent://event` or `menu://close-tab`, no
   dialog — while our own commands keep working. A silently half-dead window. Also, `core:default`
   does **not** grant `allow-create-webview-window` / `allow-set-position`; it *does* already grant
   every read a drag hit-test needs (`allow-cursor-position`, `allow-outer-position`,
   `allow-get-all-windows`, `emit-to`). Creating from **Rust** needs no ACL at all — and must be
   `async`, since `WebviewWindowBuilder::build` documents a deadlock in a synchronous command on
   Windows.
2. 🔴 **`layout-prefs.json` has exactly one writer today**, and that is the stated justification for
   its wholesale non-atomic `fs::write` (`layout_prefs.rs:151-154`). Two React roots is the classic
   lost-update shape: two writers each saving the whole blob. 17 call sites persist it.
3. 🔴 **Poller suppression.** Every poller is refcounted *per JS context*: `usageStore`, `gitStore`,
   `diskWatch`, `metricsStore`. Two windows = 2× `claude` CLI calls, 2× `git status` sweeps, 2×
   `file_stamps`. Also `store.ts:3061`'s `terminalSeq` — both windows would name the next terminal
   "Terminal 3".
4. 🔴 **`menu.rs:80` broadcasts.** `app_handle.emit(CLOSE_TAB_EVENT)` reaches every window, and
   Tauri's menu dispatch carries no focused window (`app.rs:2588-2603`), so **one Cmd+W closes a tab
   in every window.** Needs `emit_to`.
5. **`TerminalRegistry.abandon()`** — see §3.

## 5. Why the drag gesture is the expensive half, not the cheap one

- **HTML5 DnD cannot see a drop outside the window.** None of our four `dragend` handlers reads
  `clientX/Y` or `dropEffect`, and a drag released outside is today indistinguishable from a
  cancelled one. `screenX/Y` is the only screen-space signal and is frequently `0,0` on WebKit. Worse,
  `dropZone.ts:76-80` already resolves out-of-bounds coordinates to `"center"` — "past the edge" is
  *already spoken for*.
- **`dragDropEnabled: false` (`tauri.conf.json:21`) is load-bearing.** It exists
  because Tauri's interception kills HTML5 drag on Windows. Turning it on to get `tauri://drag-*`
  events re-breaks every in-window tab drag we have.
- The alternative is pointer events + `setPointerCapture` + a hand-drawn ghost + `cursorPosition()`.
  Note `@tauri-apps/api/window` is imported **nowhere** in this repo today.
- 🔴 **Linux would ship dead.** `tao-0.35.3/src/platform_impl/linux/util.rs:17-22` returns a
  hard-coded `Ok((0,0))` for `cursor_position` on **Wayland** — not an error, so nothing fails loudly
  — and GNOME defaults to Wayland on the Ubuntu box we build a `.deb` for. Chrome itself degrades to a
  drag-icon fallback there because `RunMoveLoop` is impossible on Wayland.
- For the record, Chrome's real numbers: `kMinimumDragDistance = 10` px, `kVerticalDetachMagnetism =
  15` px (touch 50), **no horizontal magnetism at all**, 750 ms hover to raise an occluded window, and
  **no ghost** — at detach it creates the real window and hands it to `RunMoveLoop()`.

## 6. What the references refuse to do

- **VS Code**: webview editors *"reload on move and may lose state"* (1.88 notes, verbatim);
  `window.setMenu(null)` so aux windows have no native menu; `// only single group supported for
  move/copy for now`; restore-on-restart shipped in **1.86, a whole release later, as its own
  milestone**. ⚠️ The published 1.85 release notes list five command ids that **do not exist** — the
  real ones are `workbench.action.moveEditorToNewWindow` / `copyEditorToNewWindow` /
  `moveEditorGroupToNewWindow` / `copyEditorGroupToNewWindow` / `newEmptyEditorWindow` /
  `restoreEditorsToMainWindow`.
- **Windows Terminal** accepts a **15 MiB leak per window close** as the price of its single-process
  design, and its shipped tear-out broke on dragging a whole split (`terminal#18572`, *"lost all
  panels besides the first"*).
- **WezTerm** ships detach; its merge-back gesture is **still an open issue** (#5976). Tear-off is two
  features and the second is the one that gets dropped.
- **Tauri**: nobody has shipped tab tear-off. `Webview::reparent` is a real native view move, but it
  is behind the `unstable` feature and has a dedicated error variant, `CannotReparentWebviewWindow`,
  for refusing to do it to a `WebviewWindow`. Our `Cargo.toml:21` is `features = []`.

## 7. Recommendation

**Reject Chrome-parity drag tear-off for v1. Adopt the VS Code shape: a command first**
(`Move Terminal into New Window`, `Restore into Main Window`), with the drag gesture as a separate,
later, optional slice. The command is not a consolation prize — it is *better* for this app, because
it can be invoked from the **fleet tree's context menu on an agent node** ("put this agent on my other
monitor"), which Chrome has no equivalent of, because Chrome has no tree.

**Two questions the design depends on:**

1. Every reference app ships an in-window split *alongside* the window feature — **and we already have
   splittable panes.** So the concrete thing tear-off adds is **a second physical monitor**. If that
   is the real goal, it narrows the whole design.
2. The rehydration list (§3) is a product decision: which of scrollback, selection, find state and
   undo are allowed to be lost in the move.

**Hard prerequisite for tear-off:** fix the 2×1 PTY resize. A tear-off mounts
a terminal into a window that has no size yet — the exact worst case — and would reflow a live
`claude` TUI to 2 columns on every move.
