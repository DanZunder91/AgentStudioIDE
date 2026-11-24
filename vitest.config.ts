/**
 * Vitest config — the frontend test harness.
 *
 * Deliberately a SEPARATE file from `vite.config.ts`: that file is tailored to
 * `tauri dev`/`tauri build` (fixed port 1420, strictPort, HMR host wiring) and
 * must not grow test concerns. Vitest prefers `vitest.config.ts` when present,
 * so this file fully replaces it for test runs — hence the React plugin below
 * (needed for JSX in `src/components/*.test.tsx`) is re-declared here.
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  test: {
    // jsdom: the components under test are DOM components. Note jsdom has no
    // layout engine and no ResizeObserver — see `src/test/setup.ts` for shims.
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],

    // Frontend tests only. `src-tauri/**` is Rust (`cargo test` owns it).
    // Plus `scripts/**`: the repo's Node gate scripts (currently the waiver-aware
    // dependency audit, `scripts/audit.mjs`). Their tests live next to them
    // rather than under `src/` — they are not frontend code and `tsconfig.json`
    // only covers `src` — but they MUST run under `npm test`, and a test outside
    // this glob would silently never run (a test that gates nothing is worse than
    // no test). They are deliberately NOT in `coverage.include`:
    // half of a gate script is the shell-out runner, which is not unit-testable,
    // so measuring the file would force lowering the global 100% line/function
    // thresholds, which is never allowed. The pure decision function is what the
    // tests pin, exhaustively.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.{test,spec}.mjs"],
    exclude: [
      "src-tauri/**",
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "src/__probe__/**",
      // Layer 5 (testing-strategy §1): these need a real layout engine and a
      // real ResizeObserver, so they run under `vitest.browser.config.ts`
      // (`npm run test:browser`). Under jsdom they would not merely fail — the
      // sizing they assert on is unmeasurable here, which is the whole reason
      // that tier exists. One file, one tier.
      "src/**/*.browser.test.{ts,tsx}",
    ],

    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",

      /**
       * Scoped to the code this suite actually exercises: the layout store and
       * the pane components. Coverage **ratchets up, never down** —
       * so this list grows as each area gains its own tests. Notably
       * absent and intentionally so:
       *   - `src/features/terminal/**` — browser-tier (real xterm), and
       *     `vi.mock()`ed at the module boundary here (no real xterm in jsdom).
       *   - `src/app/ipc.ts` — thin `invoke()` wrappers; covered by the terminal
       *     suite that drives them (see `src/test/tauri-mock.ts`).
       *   - `src/App.tsx` / `src/main.tsx` — M0 static shell + bootstrap.
       */
      // Widened for M2: bridge.ts (the agent://event reducers) and features/fleet
      // (the left rail) were UNMEASURED, so their tests existed but gated
      // nothing — the thresholds below were only ever describing store.ts.
      // An untested-but-unmeasured file is worse than an untested one: it looks
      // covered.
      // features/workspace (the right-rail file tree) joins the set
      // for the same reason fleet did — its tests must gate, not just exist.
      // The pure language-detection module + the editor's grammar map
      // join too, and so does the editor's React surface (CodeEditor.tsx,
      // UnsavedChangesDialog.tsx) — jsdom-testable with the registry mocked. The
      // CM6/Shiki files (EditorRegistry.ts, highlight.ts, shiki.ts) stay absent:
      // like features/terminal they need a real DOM and are covered by the
      // browser tier (`*.browser.test.tsx`), where v8 coverage does not run.
      include: [
        "src/app/store.ts",
        "src/app/bridge.ts",
        // The shared folder-order primitive + the layout-prefs IPC wrapper —
        // pure/jsdom-testable, so their tests gate (not merely exist).
        "src/app/folderOrder.ts",
        "src/app/layoutPrefsIpc.ts",
        // The pure path logic behind "Reveal active file" (root ownership +
        // ancestor chain) — pure, property-tested, so its tests gate.
        "src/app/revealPath.ts",
        // The window-level guard against the webview's Back/Forward page menu
        // (a bug seen on Ubuntu). jsdom-testable (the observable is
        // `defaultPrevented`; selection geometry stubbed), measured 100% on all
        // four metrics before joining so it cannot dilute the ratchet.
        "src/app/nativeContextMenu.ts",
        // Tab tear-off: the move protocol, the gesture geometry, the window boot and the
        // detached shell. Measured 100/100/100/100 before joining.
        "src/app/tearoff/**/*.{ts,tsx}",
        "src/TearoffApp.tsx",
        // The one reader of the `"<code>: <detail>"` wire shape, unified from three per-feature
        // copies. Measured explicitly: collapsing three covered copies into one
        // unmeasured file would be a net loss (unmeasured is worse than untested).
        "src/lib/wireCode.ts",
        // The one home for path splitting/joining/comparing on both separators
        // (Windows too) — every Git / editor / find / logs path site goes through it.
        "src/lib/paths.ts",
        // The one OS answer for every UI platform branch (macos / windows / linux / other),
        // and the home dir the agent rail abbreviates to `~`.
        "src/lib/platform.ts",
        "src/lib/homeDir.ts",
        // Terminal copy/paste: Windows-Terminal keys off-mac, untouched on macOS.
        "src/features/terminal/terminalClipboard.ts",
        // In-file find — the pure match model, the panel DOM, and the
        // extension bundle are all jsdom-tested; measured so the tests gate.
        // The test-only cmTestKit harness is excluded below.
        "src/features/editor/find/**/*.ts",
        // Git blame — the pure label/popover model + the IPC wrapper are
        // jsdom-tested and measured. blameGutter.ts stays browser-tier (CM6/DOM
        // glue, same rule as the lsp views — real hover/geometry in Chromium).
        "src/features/editor/blame/blame.ts",
        "src/features/editor/blame/blameIpc.ts",
        // The editor right-click tools menu builder + clipboard actions —
        // pure/jsdom-testable, verified 100% before joining the measured set.
        "src/features/editor/editorMenu.ts",
        // "Recover session": the picker surface + its pure date/size model +
        // IPC wrapper — all jsdom-tested at 100%, so they gate.
        "src/features/sessions/**/*.{ts,tsx}",
        "src/components/**/*.{ts,tsx}",
        "src/features/fleet/**/*.{ts,tsx}",
        "src/features/workspace/**/*.{ts,tsx}",
        // The Find-in-Files panel + its IPC wrapper. Added to the
        // measured set so its tests gate, not merely exist (same rule as fleet
        // and workspace above).
        "src/features/find/**/*.{ts,tsx}",
        // The keyboard-shortcuts reference overlay — pure data + a self-contained
        // jsdom-testable panel (store-driven open state).
        "src/features/shortcuts/**/*.{ts,tsx}",
        // Focus-follows-agent: the titlebar settings menu + its switch. Fully
        // jsdom-testable (local open state, store-bound toggle). Measured so its
        // tests gate, not merely exist (unmeasured is worse than untested).
        "src/features/settings/**/*.{ts,tsx}",
        // Diagnostics log: the dedicated log store + the titlebar button + the
        // overlay panel. Fully jsdom-testable (own Zustand store, clipboard mocked).
        // Measured so its tests gate, not merely exist.
        "src/features/logs/**/*.{ts,tsx}",
        // The built-in API client — the request view + its titlebar
        // launcher + the IPC wrapper. jsdom-testable with `http_send` mocked.
        "src/features/api/**/*.{ts,tsx}",
        "src/features/editor/grammar.ts",
        // The Shiki bridge. Both are transitively executed by the browser tier,
        // but never asserted there. They are jsdom-testable after all: `shiki.ts` needs no
        // DOM (the engine is mocked), and `highlight.ts` needs CM6 *state*, not
        // layout, so the `find/cmTestKit` harness covers it. Measured, so the
        // tests gate rather than merely exist.
        "src/features/editor/shiki.ts",
        "src/features/editor/highlight.ts",
        "src/features/editor/CodeEditor.tsx",
        // Undo across save/close: the snapshot cache is a
        // pure path-keyed map with a doc-identity guard and two bounds — no DOM, no
        // CM6 layout — so it is jsdom-testable and belongs in the gate rather than
        // merely having tests (unmeasured is worse than untested).
        "src/features/editor/undoHistory.ts",
        // The Markdown/CSV rendered-preview surface — pure components
        // (mermaid mocked in tests) + the pure CSV parser, all jsdom-testable.
        "src/features/editor/MarkdownPreview.tsx",
        // Find in the rendered preview.
        // 🔴 Added because `coverage.include` is a PER-FILE list, not a directory
        // glob — a new file beside a measured one is NOT measured, so its tests
        // would gate nothing (unmeasured is worse than untested).
        // Both measured 100% on all four metrics before joining, so neither can
        // dilute the ratchet.
        "src/features/editor/previewFind.ts",
        "src/features/editor/PreviewFindBar.tsx",
        "src/features/editor/previewZoom.ts",
        // Previews: images, SVG and HTML join the preview family. `previewKinds.ts` is a
        // pure extension table (and the mirror of Rust's `image_mime`), `ImageViewer`
        // is a pure component over one `src`, and `HtmlPreview` is the iframe host —
        // its ATTRIBUTES are jsdom-assertable even though what the frame renders is
        // browser-tier. 🔴 Listed here because `coverage.include` is a PER-FILE
        // allowlist: a new file beside a measured one is NOT measured, so its tests
        // would gate nothing.
        // Terminal-close confirm. `src/features/terminal/**`
        // is otherwise absent from this allowlist on purpose (xterm.js needs a
        // real DOM, so that surface is browser-tier) — but the IPC wrapper and
        // the dialog are plain jsdom-testable units, and an unmeasured gate is
        // the one thing worse than no gate.
        "src/features/terminal/terminalBusyIpc.ts",
        "src/features/terminal/CloseTerminalDialog.tsx",
        // The settle repaint: a pure timer/listener unit
        // tested in jsdom; its real-xterm behaviour is browser-tier.
        "src/features/terminal/settleRepaint.ts",
        "src/features/editor/previewKinds.ts",
        "src/features/editor/ImageViewer.tsx",
        "src/features/editor/HtmlPreview.tsx",
        "src/features/editor/CsvTable.tsx",
        "src/features/editor/csvParse.ts",
        "src/features/editor/UnsavedChangesDialog.tsx",
        "src/features/editor/LspStatus.tsx",
        // The find-usages results panel — jsdom-testable off the
        // `lspReferences` store seam (the LSP request that fills it is browser-tier).
        "src/features/editor/ReferencesPanel.tsx",
        // The deterministic, mockable LSP core. Absent by design:
        // client.ts (its initialize-handshake rejection path is only reachable
        // against a live/fake server), workspace.ts + definition.ts (CM6 views),
        // and the EditorRegistry wiring — all browser-tier tested, not measured
        // here. client.ts still has jsdom tests gating its caching + install-hint.
        "src/features/editor/lsp/lspIpc.ts",
        "src/features/editor/lsp/uri.ts",
        "src/features/editor/lsp/transport.ts",
        // The language→server set (mirrors the Rust registry) — pure, jsdom-testable.
        "src/features/editor/lsp/languages.ts",
        "src/lib/language/**/*.{ts,tsx}",
        // The usage panel: the pure formatters, the polling store, the panel, and
        // the IPC wrapper — all jsdom-testable (the fetch itself lives in Rust, so
        // nothing here needs a network). Measured so its tests gate rather than
        // merely exist.
        "src/features/usage/**/*.{ts,tsx}",
        // The metrics dashboard: the pure formatters, the polling store, the
        // panel and the IPC wrapper. The heavy transcript scan lives in Rust, so all of
        // this is jsdom-testable. Measured at 100/100/100/100 before joining, so it
        // cannot dilute the ratchet.
        "src/features/metrics/**/*.{ts,tsx}",
        // Context-window card: ipc + format + store + card. Measured 100% on
        // all four metrics out-of-band before joining, so it cannot dilute the ratchet.
        "src/features/context/**/*.{ts,tsx}",
        // Fleet views (Agent Logs + Network). Agent Logs measured 100/100/100/100
        // before joining; Network measured the same (its types-only file is excluded
        // below).
        "src/features/agentlogs/**/*.{ts,tsx}",
        "src/features/network/**/*.{ts,tsx}",
        // Agent Village. Added WITH the feature (the Tools-line discipline below):
        // every file is measured at 100% before it joins.
        "src/features/village/**/*.{ts,tsx}",
        "src/features/procs/**/*.{ts,tsx}", // dev apps: measured 100% on all four metrics before joining
        // The database client: the engine-field logic, the connection dialog, the IPC
        // wrapper, the error mapper and the rail panel. `types.ts` is excluded below —
        // types-only files erase at runtime and read as 0-of-0, which drags the average
        // without meaning anything.
        "src/features/db/**/*.{ts,tsx}",
        // 🔴 Shareable config bundles. Per-feature globs: every feature must be listed.
        // `src/features/**` is NOT measured as a whole, so a feature missing from this list
        // gates NOTHING while its tests pass, and unmeasured reads as covered. Measured at
        // 100% across all four metrics before joining, so adding it moved no threshold.
        "src/features/portability/**/*.{ts,tsx}",
        // The Tools rail tab (the epoch ⇄ date converter). Added WITH the feature, not
        // after it: a per-feature include list means a new feature gates NOTHING until
        // someone remembers this line, and a suite that gates nothing reads as covered.
        // Every file measured 100% on all four metrics out-of-band before joining, so it
        // cannot dilute the ratchet.
        "src/features/tools/**/*.{ts,tsx}",
        // The Git rail tab (working-tree changes + open PRs). Added WITH the
        // feature, same discipline as the Tools line above: every file was measured at
        // 100% on all four metrics out-of-band before this line joined it to the gate.
        "src/features/git/**/*.{ts,tsx}",
        // The file-type icon system (docs/design/file-icons.md): the §3 resolver
        // ladder + the sprite/FileIcon components. The *.generated.ts artifacts are
        // excluded below — they are data emitted by scripts/icons/generate.mjs, guarded
        // by that script's own byte-identical drift test, not by line coverage.
        "src/lib/fileIcons/**/*.{ts,tsx}",
      ],
      exclude: [
        // Types-only: erased at runtime, so v8 reports them as 0%-of-0.
        "src/app/types.ts",
        "src/vite-env.d.ts",
        // Pure inline SVG markup — no logic to cover.
        "src/components/icons.tsx",
        // The tests themselves and their harness.
        "src/**/*.{test,spec}.{ts,tsx}",
        "src/test/**",
        // In-file find's jsdom view harness (geometry stubs) — imported only by tests.
        "src/features/editor/find/cmTestKit.ts",
        // Types-only (erased at runtime, so v8 reports 0-of-0), same as app/types.ts.
        "src/features/db/types.ts",
        "src/features/network/networkTypes.ts",
        "src/features/village/villageTypes.ts",
        // Test-only engine descriptors, imported by the dialog's tests.
        "src/features/db/dbFixtures.ts",
        // Types-only (the config-bundle wire contract), and its test-only fixtures — same reasons as above.
        "src/features/portability/types.ts",
        "src/features/portability/portabilityFixtures.ts",
        // Generated data (the icon sprite + lookup tables, emitted by
        // scripts/icons/generate.mjs). Their integrity gate is that script's
        // byte-identical regeneration test, not line coverage — measuring a
        // thousand lines of generated literals would pad the average (the inverse
        // rule: measured-but-meaningless reads as covered).
        "src/lib/fileIcons/*.generated.ts",
      ],

      /**
       * MEASURED, not aspired. These are exactly what the suite achieves today
       * (`npm run test:coverage`). Thresholds ratchet up, never
       * down. Raise them when you add tests; never lower one to make a run go
       * green — an uncovered line is the finding, not the threshold.
       *
       * The global branch number is not 100% because a handful of defensive
       * guards in `store.ts` are unreachable through its own public actions (e.g.
       * `detachTab`'s `indexOf === -1` bail-out, `targetLeaf`'s first-leaf
       * fallback — `focusedPaneId` always names a live leaf, guaranteed by the
       * tree invariant). They are correct to keep and not worth faking a call
       * site for.
       */
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        // The global branch ratio is ratcheted UP (99 -> 99.93 so far), each raise
        // landing with the code that earned it: an area joins `include` only once its files
        // measure 100%, so measuring more code moves the gate up, never down. Two things
        // worth knowing when the number moves:
        //   - Deleting COVERED branches (removing a feature or a dead guard) shrinks the
        //     denominator, so the ratio can dip with no regression at all. The uncovered SET
        //     is what matters, and it is still the documented `store.ts` defensive guards
        //     plus JsonBodyEditor's.
        //   - When a first measurement comes in below the gate, the fix is the code (test the
        //     path, or design the unreachable arm out), never the threshold.
        // If a change drops below these, the uncovered line is the finding — do not lower
        // these.
        branches: 99.93,

        // Pinned separately so that broad component coverage can never mask a
        // regression in the highest-value file in the frontend (pane-tree
        // canonicalization is the logic to test hardest).
        "src/app/store.ts": {
          lines: 100,
          functions: 100,
          statements: 100,
          // Ratcheted only upward, like the global number. The uncovered branches are the
          // same documented defensive guards; a dip only ever came from deleting covered
          // branches (a smaller denominator), never from new uncovered code.
          branches: 99.68,
        },
      },
    },
  },
});
