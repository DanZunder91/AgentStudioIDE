/**
 * WsConsole — the API client's live WebSocket console.
 *
 * `wsIpc` is mocked at the module boundary: the real `ws_*` commands cross Tauri
 * (pinned in `wsIpc.test.ts`). What is under test here is the console — the
 * connect flow (connecting → open, robust to the id/open-event ordering), the
 * streaming log (in / out / sys rows), sending, disconnecting, and the error
 * surface.
 *
 * The mocked `wsConnect` captures the `onEvent` callback so a test can drive
 * socket events, and returns a promise the test controls (resolve / reject /
 * pending) to model the connect handshake.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wsIpc = vi.hoisted(() => ({
  wsConnect: vi.fn(),
  wsSend: vi.fn(),
  wsClose: vi.fn(),
}));
vi.mock("./wsIpc", () => wsIpc);

// The header rows live on `req.headers` — the shared model — so touching them (or
// the environment picker) runs the store's persist path. Mocked so no store write
// crosses Tauri from this suite (the durable store has its own tests).
const apiStoreIpc = vi.hoisted(() => ({
  loadApiStore: vi.fn(),
  saveApiStore: vi.fn(),
}));
vi.mock("./apiStoreIpc", () => apiStoreIpc);

import { useAppStore } from "../../app/store";
import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import { resetStore } from "../../test/store-harness";
import { WsConsole } from "./WsConsole";
import type { WsEvent } from "./wsIpc";

let capturedOnEvent: ((e: WsEvent) => void) | null = null;

const urlInput = () =>
  screen.getByLabelText("WebSocket URL") as HTMLInputElement;
const messageInput = () => screen.getByLabelText("Message") as HTMLInputElement;
const connectBtn = () => screen.getByTestId("ws-connect");
const sendBtn = () => screen.getByTestId("ws-send");
const statusPill = () => screen.getByTestId("ws-status");
const logRows = () => screen.queryAllByTestId("ws-log-row");
const addHeaderBtn = () => screen.getByTestId("ws-add-header");
const headerRows = () => screen.queryAllByTestId("ws-header-row");

/** The `headers` argument the console handed `wsConnect` on its last call. */
function sentHeaders(): unknown {
  const call = wsIpc.wsConnect.mock.calls.at(-1);
  return call?.[2];
}

/** Add a header row and fill its name/value (rows append, so it is the last one). */
function addHeaderRow(name: string, value: string): HTMLElement {
  fireEvent.click(addHeaderBtn());
  const row = headerRows().at(-1)!;
  fireEvent.change(within(row).getByLabelText("Header name"), {
    target: { value: name },
  });
  fireEvent.change(within(row).getByLabelText("Header value"), {
    target: { value },
  });
  return row;
}

/**
 * Seed the Vault with a live token and make it active — via `setState`, not the
 * actions, so this is pure fixture and not a test of the env editor. The value is
 * what the secret-safety assertions look for the ABSENCE of.
 */
const SECRET = "s3cr3t-live-token";
function seedVault(): void {
  useAppStore.setState((s) => {
    s.apiEnvironments = [
      {
        id: "env-1",
        name: "Staging",
        variables: [{ key: "TOKEN", value: SECRET }],
      },
    ];
    s.activeEnvironmentId = "env-1";
  });
}

/** Create a ws request, render its console, and return the id. */
function setup(): string {
  const id = useAppStore.getState().apiActions.createApiRequest();
  useAppStore.getState().apiActions.setApiProtocol(id, "ws");
  render(<WsConsole requestId={id} />);
  return id;
}

/** Fire a socket event through the captured onEvent, inside an act window. */
function emit(e: WsEvent): void {
  act(() => capturedOnEvent!(e));
}

/** Type a url, click Connect (flushing the resolve), then fire the open event. */
async function connectAndOpen(url = "wss://echo.test"): Promise<void> {
  fireEvent.change(urlInput(), { target: { value: url } });
  await act(async () => {
    fireEvent.click(connectBtn());
  });
  emit({ kind: "open" });
}

beforeEach(() => {
  resetStore();
  capturedOnEvent = null;
  // Default: capture onEvent and resolve the connectionId on a microtask.
  wsIpc.wsConnect
    .mockReset()
    .mockImplementation((_url: string, onEvent: (e: WsEvent) => void) => {
      capturedOnEvent = onEvent;
      return Promise.resolve("conn-1");
    });
  wsIpc.wsSend.mockReset().mockResolvedValue(undefined);
  wsIpc.wsClose.mockReset().mockResolvedValue(undefined);
  apiStoreIpc.saveApiStore.mockReset().mockResolvedValue(undefined);
  apiStoreIpc.loadApiStore.mockReset().mockResolvedValue({
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    folders: [],
  });
});

afterEach(() => cleanup());

describe("WsConsole — rendering", () => {
  it("renders nothing for an unknown request id", () => {
    const { container } = render(<WsConsole requestId="nope" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("starts idle: empty log, disabled Connect (no url), disabled message input", () => {
    setup();
    expect(statusPill()).toHaveTextContent("Idle");
    expect(statusPill()).toHaveClass("ws-status--idle");
    expect(connectBtn()).toHaveTextContent("Connect");
    expect(connectBtn()).toBeDisabled(); // url empty
    expect(messageInput()).toBeDisabled(); // not open
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    expect(logRows()).toHaveLength(0);
  });
});

describe("WsConsole — connect", () => {
  it("connects: connecting (id stashed) → open, then an inbound message logs an 'in' row", async () => {
    const id = setup();
    fireEvent.change(urlInput(), { target: { value: "wss://echo.test" } });

    await act(async () => {
      fireEvent.click(connectBtn());
    });
    // Promise resolved → the id is stashed; status stays "connecting" until the
    // open EVENT arrives (the two land independently).
    expect(statusPill()).toHaveTextContent("Connecting");
    expect(statusPill()).toHaveClass("ws-status--connecting");
    expect(useAppStore.getState().apiRequests[id].ws.connectionId).toBe(
      "conn-1",
    );
    // The url input locks while a connection is up/in flight.
    expect(urlInput()).toBeDisabled();

    emit({ kind: "open" });
    expect(statusPill()).toHaveTextContent("Connected");
    expect(statusPill()).toHaveClass("ws-status--open");
    expect(connectBtn()).toHaveTextContent("Disconnect");

    emit({ kind: "message", data: "hello from server" });
    const rows = logRows();
    const last = rows[rows.length - 1];
    expect(last).toHaveClass("ws-log__row--in");
    expect(last).toHaveTextContent("hello from server");
    // Two sys rows precede it: "Connecting to …" and "Connected".
    expect(rows[0]).toHaveTextContent("Connecting to wss://echo.test");
    expect(rows[1]).toHaveTextContent("Connected");
  });

  it("shows 'Connecting…' on a disabled button while the handshake is pending", async () => {
    setup();
    wsIpc.wsConnect.mockImplementationOnce(
      (_url: string, onEvent: (e: WsEvent) => void) => {
        capturedOnEvent = onEvent;
        return new Promise<string>(() => {}); // never resolves
      },
    );
    fireEvent.change(urlInput(), { target: { value: "wss://x" } });
    await act(async () => {
      fireEvent.click(connectBtn());
    });
    expect(connectBtn()).toHaveTextContent("Connecting…");
    expect(connectBtn()).toBeDisabled();
  });

  it("surfaces a connect rejection as an error state (Error and bare string)", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "wss://x" } });

    wsIpc.wsConnect.mockRejectedValueOnce(new Error("connection refused"));
    await act(async () => {
      fireEvent.click(connectBtn());
    });
    expect(statusPill()).toHaveTextContent("Error");
    expect(statusPill()).toHaveClass("ws-status--error");
    expect(screen.getByTestId("ws-error")).toHaveTextContent(
      "connection refused",
    );

    wsIpc.wsConnect.mockRejectedValueOnce("backend gone");
    await act(async () => {
      fireEvent.click(connectBtn());
    });
    expect(screen.getByTestId("ws-error")).toHaveTextContent("backend gone");
  });
});

describe("WsConsole — send", () => {
  it("sends the draft: calls wsSend, appends an 'out' row, and clears the draft", async () => {
    const id = setup();
    await connectAndOpen();

    fireEvent.change(messageInput(), { target: { value: "ping" } });
    fireEvent.click(sendBtn());

    expect(wsIpc.wsSend).toHaveBeenCalledWith("conn-1", "ping");
    expect(useAppStore.getState().apiRequests[id].ws.draft).toBe("");
    const rows = logRows();
    const last = rows[rows.length - 1];
    expect(last).toHaveClass("ws-log__row--out");
    expect(last).toHaveTextContent("ping");
  });

  it("sends on Enter", async () => {
    setup();
    await connectAndOpen();
    fireEvent.change(messageInput(), { target: { value: "via-enter" } });
    fireEvent.keyDown(messageInput(), { key: "Enter" });
    expect(wsIpc.wsSend).toHaveBeenCalledWith("conn-1", "via-enter");
  });

  it("swallows a wsSend failure — the out row is still logged, the draft cleared", async () => {
    const id = setup();
    await connectAndOpen();
    wsIpc.wsSend.mockRejectedValueOnce(new Error("send failed"));
    fireEvent.change(messageInput(), { target: { value: "ping" } });
    await act(async () => {
      fireEvent.click(sendBtn());
    });
    expect(useAppStore.getState().apiRequests[id].ws.draft).toBe("");
    expect(
      logRows().some((r) => r.classList.contains("ws-log__row--out")),
    ).toBe(true);
  });

  it("ignores a non-Enter key, and Enter on an empty draft is a no-op", async () => {
    setup();
    await connectAndOpen();

    fireEvent.change(messageInput(), { target: { value: "x" } });
    fireEvent.keyDown(messageInput(), { key: "a" }); // wrong key: no send
    expect(wsIpc.wsSend).not.toHaveBeenCalled();

    fireEvent.change(messageInput(), { target: { value: "" } });
    fireEvent.keyDown(messageInput(), { key: "Enter" }); // empty draft: guarded no-op
    expect(wsIpc.wsSend).not.toHaveBeenCalled();
  });
});

describe("WsConsole — disconnect + lifecycle events", () => {
  it("disconnects: calls wsClose with the id and marks the socket closed", async () => {
    setup();
    await connectAndOpen();
    fireEvent.click(connectBtn()); // now labelled Disconnect
    expect(wsIpc.wsClose).toHaveBeenCalledWith("conn-1");
    expect(statusPill()).toHaveTextContent("Closed");
    expect(statusPill()).toHaveClass("ws-status--closed");
  });

  it("swallows a wsClose failure and still marks the socket closed", async () => {
    setup();
    await connectAndOpen();
    wsIpc.wsClose.mockRejectedValueOnce(new Error("close failed"));
    await act(async () => {
      fireEvent.click(connectBtn()); // Disconnect
    });
    expect(statusPill()).toHaveTextContent("Closed");
  });

  it("disconnects without an id when the open event beat the connect resolve", async () => {
    const id = setup();
    wsIpc.wsConnect.mockImplementationOnce(
      (_url: string, onEvent: (e: WsEvent) => void) => {
        capturedOnEvent = onEvent;
        return new Promise<string>(() => {}); // resolve never lands
      },
    );
    fireEvent.change(urlInput(), { target: { value: "wss://x" } });
    await act(async () => {
      fireEvent.click(connectBtn());
    });
    emit({ kind: "open" }); // status open, but connectionId still null

    expect(statusPill()).toHaveTextContent("Connected");
    expect(useAppStore.getState().apiRequests[id].ws.connectionId).toBeNull();

    fireEvent.click(connectBtn()); // Disconnect with a null id → no ws_close call
    expect(wsIpc.wsClose).not.toHaveBeenCalled();
    expect(statusPill()).toHaveTextContent("Closed");
  });

  it("logs a 'closed' event (with and without code/reason) as sys notes", async () => {
    setup();
    await connectAndOpen();

    emit({ kind: "closed", code: 1000, reason: "going away" });
    emit({ kind: "closed", code: null, reason: "" });

    const texts = logRows().map((r) => r.textContent ?? "");
    expect(
      texts.some((t) => t.includes("Disconnected (1000): going away")),
    ).toBe(true);
    // No code + empty reason → the bare note.
    expect(
      texts.some((t) => /Disconnected(?!\s*\()/.test(t) && !t.includes("1000")),
    ).toBe(true);
  });

  it("surfaces an 'error' event as the error state + a sys note", async () => {
    setup();
    await connectAndOpen();
    emit({ kind: "error", message: "socket blew up" });
    expect(statusPill()).toHaveTextContent("Error");
    expect(screen.getByTestId("ws-error")).toHaveTextContent("socket blew up");
    expect(
      within(screen.getByTestId("ws-log")).getByText(/Error: socket blew up/),
    ).toBeInTheDocument();
  });
});

/* ── handshake headers (the 401 on an authenticated upgrade) ───────────────── */

describe("WsConsole — handshake headers", () => {
  it("starts with no rows, then adds, edits and removes them", () => {
    setup();
    expect(screen.getByText("No headers")).toBeInTheDocument();
    expect(headerRows()).toHaveLength(0);

    addHeaderRow("Authorization", "Bearer abc");
    addHeaderRow("X-Scope", "read");
    expect(headerRows()).toHaveLength(2);
    expect(screen.queryByText("No headers")).not.toBeInTheDocument();

    fireEvent.click(within(headerRows()[1]).getByLabelText("Remove header"));
    const rows = headerRows();
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByLabelText("Header name")).toHaveValue(
      "Authorization",
    );
    expect(within(rows[0]).getByLabelText("Header value")).toHaveValue(
      "Bearer abc",
    );
  });

  it("sends only the enabled, NAMED rows on connect", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "wss://echo.test" } });

    addHeaderRow("Authorization", "Bearer abc");
    const unnamed = addHeaderRow("", "orphan-value"); // scaffolding: no name
    const disabled = addHeaderRow("X-Scope", "read");
    fireEvent.click(within(disabled).getByLabelText("Header enabled"));
    expect(within(unnamed).getByLabelText("Header name")).toHaveValue("");

    await act(async () => {
      fireEvent.click(connectBtn());
    });

    expect(sentHeaders()).toEqual([
      { name: "Authorization", value: "Bearer abc" },
    ]);
  });

  // 🔴 Secret-safety. The Vault holds a real token and the header names it; what leaves
  // this component must still be the TEMPLATE. Resolution happens in Rust so the
  // secret never crosses IPC — pre-resolving here would defeat the entire design.
  it("hands wsConnect the LITERAL {{VAR}} template, never the resolved secret", async () => {
    seedVault();
    setup();
    fireEvent.change(urlInput(), { target: { value: "wss://echo.test" } });
    addHeaderRow("Authorization", "Bearer {{TOKEN}}");

    await act(async () => {
      fireEvent.click(connectBtn());
    });

    expect(sentHeaders()).toEqual([
      { name: "Authorization", value: "Bearer {{TOKEN}}" },
    ]);
    // The whole call is searched, not just the row we read back — a substitution
    // smuggled in anywhere (url, a second header) fails this too.
    const call = JSON.stringify(wsIpc.wsConnect.mock.calls.at(-1));
    expect(call).toContain("{{TOKEN}}");
    expect(call).not.toContain(SECRET);
  });

  // The negative control. A build that always sent headers (even a
  // populated array) would pass every assertion above; only this one notices.
  it("sends an EMPTY list when there are no rows — today's connect, unchanged", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "wss://echo.test" } });

    await act(async () => {
      fireEvent.click(connectBtn());
    });

    expect(sentHeaders()).toEqual([]);
    expect(wsIpc.wsConnect).toHaveBeenCalledWith(
      "wss://echo.test",
      expect.any(Function),
      [],
    );
  });

  it("locks the rows and the environment while connected — they only feed the handshake", async () => {
    seedVault();
    setup();
    addHeaderRow("Authorization", "Bearer abc");
    expect(screen.queryByTestId("ws-headers-locked")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Environment")).toBeEnabled();

    await connectAndOpen();

    expect(screen.getByTestId("ws-headers-locked")).toHaveTextContent(
      "Headers are read once, when the handshake is sent",
    );
    expect(addHeaderBtn()).toBeDisabled();
    const row = headerRows()[0];
    expect(within(row).getByLabelText("Header name")).toBeDisabled();
    expect(within(row).getByLabelText("Header value")).toBeDisabled();
    expect(within(row).getByLabelText("Header enabled")).toBeDisabled();
    expect(within(row).getByLabelText("Remove header")).toBeDisabled();
    expect(screen.getByLabelText("Environment")).toBeDisabled();

    fireEvent.click(connectBtn()); // Disconnect
    expect(screen.queryByTestId("ws-headers-locked")).not.toBeInTheDocument();
    expect(addHeaderBtn()).toBeEnabled();
    expect(within(headerRows()[0]).getByLabelText("Header name")).toBeEnabled();
  });

  it("lists the Vault environments and switches the active one", () => {
    seedVault();
    setup();
    const select = screen.getByLabelText("Environment") as HTMLSelectElement;
    expect(select).toHaveValue("env-1");
    expect(within(select).getByText("Staging")).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "" } });
    expect(useAppStore.getState().activeEnvironmentId).toBeNull();

    fireEvent.change(select, { target: { value: "env-1" } });
    expect(useAppStore.getState().activeEnvironmentId).toBe("env-1");
  });

  // A rejected header is a failure to ESTABLISH, so Rust reports it on the same
  // `error` event a refused connect uses — there is no second error surface, and
  // that is only safe if this one is actually visible.
  it("surfaces a rejected header (Rust's error event) in the error block and the log", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "wss://echo.test" } });
    addHeaderRow("Host", "evil.example.com");
    await act(async () => {
      fireEvent.click(connectBtn());
    });

    const message =
      "the host header is written by the WebSocket handshake itself and cannot " +
      "be set here — a second copy makes the server reject the connection.";
    emit({ kind: "error", message });

    expect(statusPill()).toHaveTextContent("Error");
    expect(screen.getByTestId("ws-error")).toHaveTextContent(
      /cannot be set here/,
    );
    expect(
      within(screen.getByTestId("ws-log")).getByText(/Error: the host header/),
    ).toBeInTheDocument();
  });

  it("surfaces a missing Vault variable the same way", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "wss://echo.test" } });
    addHeaderRow("Authorization", "Bearer {{NOPE}}");
    await act(async () => {
      fireEvent.click(connectBtn());
    });

    emit({
      kind: "error",
      message:
        'the Vault has no value for {{NOPE}} — add it in the Vault panel (header "Authorization")',
    });

    expect(screen.getByTestId("ws-error")).toHaveTextContent(
      "the Vault has no value for {{NOPE}}",
    );
  });
});

/**
 * A value the edge computes is only real if it reaches the DURABLE
 * record. The rows are `req.headers`, the field the saved-request store already
 * snapshots for every protocol, so this needed no new persistence code; that claim
 * is worth proving rather than asserting, and this is what would go red if the
 * saved-request shape ever stopped carrying headers for a `ws` request.
 */
describe("WsConsole — headers survive save → reopen", () => {
  it("round-trips through the saved-request store, keeping {{VAR}} literal", () => {
    seedVault();
    const id = setup();
    fireEvent.change(urlInput(), { target: { value: "wss://echo.test" } });
    addHeaderRow("Authorization", "Bearer {{TOKEN}}");

    const a = useAppStore.getState().apiActions;
    a.saveRequestToCollection(id, "widget feed");

    // The saved snapshot keeps the TEMPLATE — a collection never holds a secret.
    const saved = useAppStore.getState().apiCollections[0];
    expect(saved.protocol).toBe("ws");
    expect(saved.headers).toEqual([
      { name: "Authorization", value: "Bearer {{TOKEN}}" },
    ]);
    expect(JSON.stringify(saved)).not.toContain(SECRET);

    // …and reopening restores enabled rows on the new request.
    const reopened = a.createApiRequest();
    a.loadCollectionIntoRequest(saved.id, reopened);
    const restored = useAppStore.getState().apiRequests[reopened];
    expect(restored.protocol).toBe("ws");
    expect(restored.headers).toMatchObject([
      { name: "Authorization", value: "Bearer {{TOKEN}}", enabled: true },
    ]);
  });
});

/**
 * The SEAM: the console → the REAL `wsIpc` → the Tauri boundary,
 * with only `invoke` mocked. The blocks above pin what the console hands the
 * wrapper and `wsIpc.test.ts` pins what the wrapper puts on the wire; neither one
 * alone proves the payload a running app actually sends.
 */
describe("WsConsole — seam to the real wsIpc (only Tauri mocked)", () => {
  let ipc: TauriMock;

  beforeEach(async () => {
    ipc = installTauriMock();
    ipc.handle("ws_connect", () => "conn-seam");
    const actual = await vi.importActual<typeof import("./wsIpc")>("./wsIpc");
    wsIpc.wsConnect.mockImplementation(actual.wsConnect);
  });
  afterEach(() => ipc.reset());

  it("puts the literal template on the wire — the resolved secret is nowhere in the payload", async () => {
    seedVault();
    setup();
    fireEvent.change(urlInput(), { target: { value: "wss://echo.test" } });
    addHeaderRow("Authorization", "Bearer {{TOKEN}}");

    await act(async () => {
      fireEvent.click(connectBtn());
    });

    const args = ipc.lastCall("ws_connect")!;
    expect(args.headers).toEqual([
      { name: "Authorization", value: "Bearer {{TOKEN}}" },
    ]);
    expect(JSON.stringify(args)).not.toContain(SECRET);
  });

  it("omits the headers key entirely when the console has no rows", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "wss://echo.test" } });

    await act(async () => {
      fireEvent.click(connectBtn());
    });

    expect(Object.keys(ipc.lastCall("ws_connect")!).sort()).toEqual([
      "onEvent",
      "url",
    ]);
  });
});
