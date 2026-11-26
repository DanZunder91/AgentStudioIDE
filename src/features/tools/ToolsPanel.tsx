/** Tools: utilities needing no connection, project or network (the admission criterion). A new tool
 * is a sibling `<section>` with its own file and tests. `data-testid="tools-panel"` is a CONTRACT:
 * `App.test.tsx` asserts rail routing on it. */

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
