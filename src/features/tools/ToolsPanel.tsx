/**
 * ToolsPanel — the right rail's **Tools** tab: small, self-contained developer
 * utilities that need no connection, no project and no network.
 *
 * That last clause is the whole admission criterion, and it is what separates this tab
 * from the five beside it. Files needs a workspace, DB needs a connection, Vault needs a
 * store, Collections and History need a request. A tool in here answers a question about
 * a value the user already has on their clipboard, immediately, with nothing configured —
 * which is exactly why it can live in a 180px rail next to whatever they are actually
 * doing, instead of pulling focus into a centre tab.
 *
 * ── Adding a second tool ─────────────────────────────────────────────────────
 * Add a sibling `<section>` below `<EpochTool/>`. Each tool owns its own file, its own
 * heading and its own tests; this container owns the rail chrome (the heading, the
 * scroll, the spacing) and nothing else — note that it holds no state and passes no
 * props, so a new tool cannot be blocked on a change here.
 *
 * ── Why there is no tool registry ────────────────────────────────────────────
 * A `TOOLS = [{ id, label, Component }]` table with a `.map()` was written and thrown
 * away. With one entry it is pure indirection: it converts a two-line JSX edit into a
 * data-plus-loop indirection, adds a key/id namespace nobody needs, and — the real cost —
 * it decides *now*, on a sample of one, what every future tool must have in common. The
 * evidence for that shape does not exist yet. A table earns its keep when the rows are
 * genuinely uniform and there are enough of them that hand-writing is a maintenance cost
 * (`dbEngines`, `SHEBANG_INTERPRETERS`); two or three sibling sections is not that.
 * Speculative generality is the more expensive mistake here, because it is the one that
 * is awkward to undo.
 *
 * ⚠️ `data-testid="tools-panel"` on the root is a CONTRACT: `App.test.tsx` asserts
 * right-rail routing two-sidedly against it (clicking Tools mounts this and unmounts
 * `db-panel`). Rename anything else in this file; not that.
 */

import { EpochTool } from "./EpochTool";
import "./tools.css";

export function ToolsPanel(): React.JSX.Element {
  return (
    <div className="tools-panel" data-testid="tools-panel">
      <h2 className="tools-panel__title">Tools</h2>
      <section className="tools-panel__tool">
        <h3 className="tools-panel__toolname">Epoch ⇄ date</h3>
        {/* No props: the tool defaults to the real clock and the host's zone. Only the
            tests inject them, so nothing in the app can hand it a stale "now". */}
        <EpochTool />
      </section>
    </div>
  );
}
