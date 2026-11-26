/** Links open only https URLs, only in the OS browser: xterm's default accepted any scheme and
 * called `window.open()` inside the webview. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitIpc = vi.hoisted(() => ({ urlOpen: vi.fn(() => Promise.resolve()) }));
vi.mock("../git/gitIpc", () => gitIpc);

import { openTerminalLink } from "./TerminalRegistry";

describe("openTerminalLink", () => {
  beforeEach(() => gitIpc.urlOpen.mockClear());

  it("hands https links to url_open", () => {
    openTerminalLink("https://example.com/docs");
    expect(gitIpc.urlOpen).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("drops every other scheme", () => {
    for (const uri of [
      "http://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "preview://localhost/x.html",
      "ssh://host",
    ]) {
      openTerminalLink(uri);
    }
    expect(gitIpc.urlOpen).not.toHaveBeenCalled();
  });
});
