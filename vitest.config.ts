/** Test config, separate from `vite.config.ts` (tailored to `tauri dev`/`build`). Vitest prefers
 * this file and it fully replaces vite.config for tests, hence the React plugin again here. */

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

    // Frontend tests plus the Node gate scripts' tests, which must run under `npm test`. Scripts
    // stay out of `coverage.include`: their shell-out runners are not unit-testable and would force
    // the 100% thresholds down; the tests pin the pure decision functions.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.{test,spec}.mjs"],
    exclude: [
      "src-tauri/**",
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "src/__probe__/**",
      // Layer 5 (testing-strategy §1) needs real layout and ResizeObserver:
      // vitest.browser.config.ts. One file, one tier.
      "src/**/*.browser.test.{ts,tsx}",
    ],

    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",

      /** Per-file allowlist that ratchets up: a file joins once it measures 100%, since an
       * unmeasured file's tests gate nothing yet look covered. Absent by design: browser-tier code
       * (terminal surface, CM6 views), `app/ipc.ts` wrappers, the App/main bootstrap. */
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
        // Guard against the webview's Back/Forward page menu; measured 100% before joining.
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
        // The Shiki bridge, jsdom-testable after all (`shiki.ts` with the engine mocked,
        // `highlight.ts` on CM6 state via `find/cmTestKit`): measured, not just run by the browser
        // tier.
        "src/features/editor/shiki.ts",
        "src/features/editor/highlight.ts",
        "src/features/editor/CodeEditor.tsx",
        // Undo across save/close: a pure path-keyed snapshot map, so jsdom-testable and gated.
        "src/features/editor/undoHistory.ts",
        // The Markdown/CSV rendered-preview surface — pure components
        // (mermaid mocked in tests) + the pure CSV parser, all jsdom-testable.
        "src/features/editor/MarkdownPreview.tsx",
        // Find in the rendered preview. `coverage.include` is PER-FILE: a new file beside a
        // measured one is not measured, so its tests would gate nothing.
        "src/features/editor/previewFind.ts",
        "src/features/editor/PreviewFindBar.tsx",
        "src/features/editor/previewZoom.ts",
        // Terminal-close confirm: plain jsdom units, though terminal/** is otherwise browser-tier
        // (xterm needs a real DOM). The preview files below are jsdom-testable too
        // (`previewKinds.ts` mirrors Rust's `image_mime`).
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
        // The deterministic LSP core. client.ts, workspace.ts, definition.ts and the EditorRegistry
        // wiring are browser-tier and unmeasured (client.ts still has gating jsdom tests).
        "src/features/editor/lsp/lspIpc.ts",
        "src/features/editor/lsp/uri.ts",
        "src/features/editor/lsp/transport.ts",
        // The language→server set (mirrors the Rust registry) — pure, jsdom-testable.
        "src/features/editor/lsp/languages.ts",
        "src/lib/language/**/*.{ts,tsx}",
        // The usage panel: jsdom-testable (the fetch lives in Rust).
        "src/features/usage/**/*.{ts,tsx}",
        // The metrics dashboard: jsdom-testable (the transcript scan lives in Rust).
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
        // The database client; types-only `types.ts` is excluded below (0-of-0 drags the average).
        "src/features/db/**/*.{ts,tsx}",
        // Per-feature globs: `src/features/**` is NOT measured as a whole, so an unlisted feature
        // gates nothing while its tests pass. Shareable config bundles:
        "src/features/portability/**/*.{ts,tsx}",
        // What agents do through the `agent-studio` command (the event listener). Added with
        // the feature, for the same reason as every line here.
        "src/features/agentctl/**/*.{ts,tsx}",
        // The Tools rail tab, added WITH the feature: a feature missing here gates nothing.
        "src/features/tools/**/*.{ts,tsx}",
        // The Git rail tab (working-tree changes + open PRs). Added WITH the
        // feature, same discipline as the Tools line above: every file was measured at
        // 100% on all four metrics out-of-band before this line joined it to the gate.
        "src/features/git/**/*.{ts,tsx}",
        // File-type icons (docs/design/file-icons.md); the *.generated.ts files are excluded below.
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
        // Generated data (scripts/icons/generate.mjs), gated by its byte-identical regeneration
        // test; measuring thousands of literal lines would only pad the average.
        "src/lib/fileIcons/*.generated.ts",
      ],

      /** MEASURED, not aspired (`npm run test:coverage`); ratchet up, never down: an uncovered line
       * is the finding, not the threshold. Branches miss 100% for unreachable defensive
       * guards, e.g. `store.ts`'s `detachTab` `indexOf === -1`. */
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        // Ratcheted up as areas join at 100%. Deleting COVERED branches can dip the ratio with no
        // regression (the uncovered set is the `store.ts` guards plus JsonBodyEditor's); below the
        // gate, fix the code, never the threshold.
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
