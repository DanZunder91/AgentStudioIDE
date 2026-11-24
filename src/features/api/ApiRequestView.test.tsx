/**
 * ApiRequestView — the API client's request/response surface.
 *
 * `httpIpc` is mocked at the module boundary: the real `http_send` crosses Tauri,
 * which does not belong in a jsdom unit test (its marshalling is pinned in
 * `httpIpc.test.ts`). What is under test here is the view — editing the request,
 * the header table, the send that builds the right wire `HttpRequest`, and the
 * response/error rendering (status pill, stats, JSON pretty-print, calm error).
 *
 * The mocked `sendHttp` resolves on a microtask, so each send is issued inside an
 * `act(async …)` window that also flushes the resolved-promise `.then` (which
 * runs `setApiResponse`/`setApiError`) — assertions then run against settled state.
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

const httpIpc = vi.hoisted(() => ({ sendHttp: vi.fn() }));
vi.mock("./httpIpc", () => httpIpc);

// GrpcConsole (rendered by the gRPC protocol branch) reflects/sends via this module;
// mock it so nothing crosses Tauri.
const grpcIpc = vi.hoisted(() => ({
  grpcReflect: vi.fn(),
  grpcSend: vi.fn(),
}));
vi.mock("./grpcIpc", () => grpcIpc);

const apiStoreIpc = vi.hoisted(() => ({
  loadApiStore: vi.fn(),
  saveApiStore: vi.fn(),
}));
vi.mock("./apiStoreIpc", () => apiStoreIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { ApiRequestView } from "./ApiRequestView";
import { buildCurl } from "./curlExport";
import { substituteVars } from "./substitute";
import type { HttpResponse } from "./httpIpc";
import type { ApiStore } from "./apiStoreIpc";

const emptyStore: ApiStore = {
  collections: [],
  environments: [],
  activeEnvironmentId: null,
  folders: [],
};

const response = (over: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 200,
  statusText: "OK",
  headers: [{ name: "content-type", value: "application/json" }],
  body: '{"ok":true}',
  durationMs: 128,
  sizeBytes: 1229,
  truncated: false,
  ...over,
});

const methodSelect = () =>
  screen.getByLabelText("HTTP method") as HTMLSelectElement;
const urlInput = () => screen.getByLabelText("Request URL") as HTMLInputElement;
const sendButton = () => screen.getByRole("button", { name: /send/i });

/**
 * Create a fresh request, render its view, and return the id. `seed` is hydrated
 * FIRST — which also marks the durable store loaded, so the mount effect
 * short-circuits (the load-on-mount path has its own test) and never clobbers a
 * seeded environment with an async empty-store resolve.
 */
function setup(seed: ApiStore = emptyStore): string {
  useAppStore.getState().apiActions.hydrateApiStore(seed);
  const id = useAppStore.getState().apiActions.createApiRequest();
  render(<ApiRequestView requestId={id} />);
  return id;
}

/** Click Send inside an act window, flushing the mocked promise's `.then`. */
async function clickSend(): Promise<void> {
  await act(async () => {
    fireEvent.click(sendButton());
  });
}

beforeEach(() => {
  resetStore();
  httpIpc.sendHttp.mockReset();
  apiStoreIpc.loadApiStore.mockReset().mockResolvedValue(emptyStore);
  apiStoreIpc.saveApiStore.mockReset().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("ApiRequestView — request editing", () => {
  it("renders defaults: GET, empty url, no headers, disabled Send, no response/body", () => {
    setup();
    expect(methodSelect().value).toBe("GET");
    expect(urlInput().value).toBe("");
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("No headers")).toBeInTheDocument();
    // GET carries no body, and there is nothing to show below yet.
    expect(screen.queryByLabelText("Request body")).toBeNull();
    expect(screen.queryByTestId("api-response")).toBeNull();
    expect(screen.queryByTestId("api-error")).toBeNull();
  });

  it("renders nothing when the request id is unknown", () => {
    const { container } = render(<ApiRequestView requestId="does-not-exist" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("edits the method and url through the store", () => {
    const id = setup();
    fireEvent.change(methodSelect(), { target: { value: "POST" } });
    fireEvent.change(urlInput(), { target: { value: "https://x.test/api" } });
    const req = useAppStore.getState().apiRequests[id];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://x.test/api");
  });

  it("auto-imports a curl pasted into the URL field (method/url/headers/body)", () => {
    const id = setup();
    fireEvent.change(urlInput(), {
      target: {
        value:
          "curl 'https://a.test/x' -H 'Content-Type: application/json' --data '{\"a\":1}'",
      },
    });
    const req = useAppStore.getState().apiRequests[id];
    expect(req).toMatchObject({ method: "POST", url: "https://a.test/x", body: '{"a":1}' });
    expect(req.headers[0]).toMatchObject({ name: "Content-Type", value: "application/json" });
  });

  it("leaves a curl that has no URL yet as plain text (falls through to a url edit)", () => {
    const id = setup();
    fireEvent.change(urlInput(), { target: { value: "curl -X POST" } });
    // isCurlCommand is true but parseCurl returns null (no URL) → treated as a url edit.
    expect(useAppStore.getState().apiRequests[id].url).toBe("curl -X POST");
  });

  it("imports a MULTI-LINE curl pasted into the URL field via the raw clipboard", () => {
    const id = setup();
    // A single-line <input> would strip the newlines (dropping the header/data
    // lines), so onPaste reads the raw clipboard. A typical multi-line paste.
    const curl =
      "curl --location --request GET 'https://api.test/v1/orders/ORDER-1/history' \\\n" +
      "--header 'x-api-key: test-key' \\\n" +
      "--header 'Content-Type: application/json' \\\n" +
      '--data \'{ "q": "x" }\'';
    fireEvent.paste(urlInput(), { clipboardData: { getData: () => curl } });

    const req = useAppStore.getState().apiRequests[id];
    expect(req.method).toBe("GET"); // explicit --request GET
    expect(req.url).toBe("https://api.test/v1/orders/ORDER-1/history");
    expect(req.body).toBe('{ "q": "x" }');
    expect(req.headers.map((h) => [h.name, h.value])).toEqual([
      ["x-api-key", "test-key"],
      ["Content-Type", "application/json"],
    ]);
    // A GET with a body → the body editor is shown so it's visible/editable.
    expect(screen.getByLabelText("Request body")).toBeInTheDocument();
  });

  it("does not hijack a normal (non-curl) URL paste", () => {
    const id = setup();
    const before = useAppStore.getState().apiRequests[id].url;
    // A plain URL paste isn't a curl → onPaste doesn't intercept; the field's own
    // default paste + onChange handle it (asserted: the request wasn't curl-imported).
    fireEvent.paste(urlInput(), {
      clipboardData: { getData: () => "https://plain.test/x" },
    });
    // onPaste left it to the default (no headers/body imported).
    expect(useAppStore.getState().apiRequests[id].headers).toHaveLength(0);
    expect(useAppStore.getState().apiRequests[id].url).toBe(before);
  });

  it("hides the body editor for GET and shows it for POST", () => {
    setup();
    expect(screen.queryByLabelText("Request body")).toBeNull();
    fireEvent.change(methodSelect(), { target: { value: "POST" } });
    expect(screen.getByLabelText("Request body")).toBeInTheDocument();
  });

  it("adds, edits, toggles, and removes a header row", () => {
    const id = setup();
    expect(screen.queryAllByTestId("api-header-row")).toHaveLength(0);

    fireEvent.click(screen.getByText("+ Add header"));
    const row = screen.getByTestId("api-header-row");
    fireEvent.change(within(row).getByLabelText("Header name"), {
      target: { value: "X-Api-Key" },
    });
    fireEvent.change(within(row).getByLabelText("Header value"), {
      target: { value: "secret" },
    });
    expect(useAppStore.getState().apiRequests[id].headers[0]).toMatchObject({
      name: "X-Api-Key",
      value: "secret",
      enabled: true,
    });

    fireEvent.click(within(row).getByLabelText("Header enabled")); // toggle off
    expect(useAppStore.getState().apiRequests[id].headers[0].enabled).toBe(
      false,
    );

    fireEvent.click(within(row).getByLabelText("Remove header"));
    expect(screen.queryAllByTestId("api-header-row")).toHaveLength(0);
    expect(useAppStore.getState().apiRequests[id].headers).toHaveLength(0);
  });
});

describe("ApiRequestView — send", () => {
  it("sends only enabled, named headers with a null body for GET, and renders the response", async () => {
    const id = setup();
    fireEvent.change(urlInput(), { target: { value: "https://api.test/x" } });

    // Three rows: enabled+named (sent), disabled+named (dropped), enabled+unnamed (dropped).
    const api = useAppStore.getState().apiActions;
    act(() => {
      api.addHeader(id);
      api.addHeader(id);
      api.addHeader(id);
    });
    const [h0, h1, h2] = useAppStore.getState().apiRequests[id].headers;
    act(() => {
      api.updateHeader(id, h0.id, {
        name: "Accept",
        value: "application/json",
      });
      api.updateHeader(id, h1.id, {
        name: "X-Off",
        value: "v",
        enabled: false,
      });
      api.updateHeader(id, h2.id, { value: "orphan" }); // enabled, but no name
    });

    httpIpc.sendHttp.mockResolvedValue(
      // A leading non-content-type header exercises the content-type scan.
      response({
        headers: [
          { name: "X-Trace", value: "abc" },
          { name: "content-type", value: "application/json" },
        ],
      }),
    );
    await clickSend();

    expect(httpIpc.sendHttp).toHaveBeenCalledTimes(1);
    expect(httpIpc.sendHttp).toHaveBeenCalledWith({
      method: "GET",
      url: "https://api.test/x",
      headers: [{ name: "Accept", value: "application/json" }],
      body: null,
    });

    const panel = screen.getByTestId("api-response");
    expect(within(panel).getByTestId("api-status")).toHaveTextContent("200");
    expect(within(panel).getByTestId("api-status")).toHaveClass(
      "api-status--2xx",
    );
    expect(panel).toHaveTextContent("OK");
    expect(panel).toHaveTextContent("128 ms");
    expect(panel).toHaveTextContent("1.2 KB");
    // Headers are collapsed by default; expand to see the header rows.
    expect(within(panel).getByTestId("response-headers-toggle")).toHaveTextContent(
      "Headers (2)",
    );
    fireEvent.click(within(panel).getByTestId("response-headers-toggle"));
    expect(within(panel).getByTestId("response-headers")).toHaveTextContent(
      "X-Trace",
    );
    // JSON body renders as a collapsible tree by default…
    expect(within(panel).getByTestId("json-view")).toBeInTheDocument();
    expect(within(panel).getByTestId("api-response-body")).toHaveTextContent("ok");
    // …and the Raw toggle switches to the pretty-printed text.
    fireEvent.click(within(panel).getByTestId("response-view-toggle"));
    expect(within(panel).getByTestId("api-response-body")).toHaveTextContent(
      '"ok": true',
    );
    expect(within(panel).queryByTestId("json-view")).toBeNull();
  });

  it("sends null for an empty POST body, and the body verbatim when present", async () => {
    setup();
    fireEvent.change(methodSelect(), { target: { value: "POST" } });
    fireEvent.change(urlInput(), {
      target: { value: "https://api.test/create" },
    });

    httpIpc.sendHttp.mockResolvedValue(response());
    await clickSend(); // empty body → null
    expect(httpIpc.sendHttp).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "POST", body: null }),
    );

    fireEvent.change(screen.getByLabelText("Request body"), {
      target: { value: '{"a":1}' },
    });
    await clickSend(); // body present → sent verbatim
    expect(httpIpc.sendHttp).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "POST", body: '{"a":1}' }),
    );
  });

  it("shows a non-JSON body raw, and a malformed JSON body unchanged", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "https://api.test" } });

    // No content-type at all → treated as raw text.
    httpIpc.sendHttp.mockResolvedValue(
      response({ headers: [], body: "plain text" }),
    );
    await clickSend();
    expect(screen.getByTestId("api-response-body")).toHaveTextContent(
      "plain text",
    );

    // JSON content-type but an unparseable body → shown raw, not swallowed.
    httpIpc.sendHttp.mockResolvedValue(
      response({
        headers: [{ name: "Content-Type", value: "application/json" }],
        body: "{not json",
      }),
    );
    await clickSend();
    expect(screen.getByTestId("api-response-body")).toHaveTextContent(
      "{not json",
    );
  });

  it("surfaces a rejection as a calm error block (Error and bare string)", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "https://api.test" } });

    httpIpc.sendHttp.mockRejectedValueOnce(
      new Error("error sending request: dns error"),
    );
    await clickSend();
    expect(screen.getByTestId("api-error")).toHaveTextContent("dns error");
    expect(screen.queryByTestId("api-response")).toBeNull();

    httpIpc.sendHttp.mockRejectedValueOnce("backend unavailable");
    await clickSend();
    expect(screen.getByTestId("api-error")).toHaveTextContent(
      "backend unavailable",
    );
  });

  it("colours the status pill by class (3xx / 4xx / 5xx)", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "https://api.test" } });

    for (const [status, cls] of [
      [301, "api-status--3xx"],
      [404, "api-status--4xx"],
      [503, "api-status--5xx"],
    ] as const) {
      httpIpc.sendHttp.mockResolvedValueOnce(
        response({ status, headers: [], body: "" }),
      );
      await clickSend();
      expect(screen.getByTestId("api-status")).toHaveClass(cls);
    }
  });

  it("humanizes the size (B and MB) and notes a truncated body", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "https://api.test" } });

    httpIpc.sendHttp.mockResolvedValueOnce(
      response({ sizeBytes: 512, headers: [], body: "" }),
    );
    await clickSend();
    expect(screen.getByTestId("api-response")).toHaveTextContent("512 B");

    httpIpc.sendHttp.mockResolvedValueOnce(
      response({
        sizeBytes: 2 * 1024 * 1024,
        truncated: true,
        headers: [],
        body: "",
      }),
    );
    await clickSend();
    expect(screen.getByTestId("api-response")).toHaveTextContent("2.0 MB");
    expect(screen.getByTestId("api-truncated")).toBeInTheDocument();
  });

  it("sends on Cmd/Ctrl+Enter, but not with an empty url or a wrong chord", async () => {
    setup();

    // Empty url: the chord is a no-op (send is guarded by canSend).
    fireEvent.keyDown(urlInput(), { key: "Enter", metaKey: true });
    expect(httpIpc.sendHttp).not.toHaveBeenCalled();

    fireEvent.change(urlInput(), { target: { value: "https://api.test" } });

    // Wrong key (with modifier) and Enter (no modifier) are both ignored.
    fireEvent.keyDown(urlInput(), { key: "a", metaKey: true });
    fireEvent.keyDown(urlInput(), { key: "Enter" });
    expect(httpIpc.sendHttp).not.toHaveBeenCalled();

    httpIpc.sendHttp.mockResolvedValue(response());
    await act(async () => {
      fireEvent.keyDown(urlInput(), { key: "Enter", metaKey: true });
    });
    expect(httpIpc.sendHttp).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.keyDown(urlInput(), { key: "Enter", ctrlKey: true });
    });
    expect(httpIpc.sendHttp).toHaveBeenCalledTimes(2);
  });

  it("disables Send and shows 'Sending…' while a request is in flight", async () => {
    const id = setup();
    fireEvent.change(urlInput(), { target: { value: "https://api.test" } });

    let resolve!: (r: HttpResponse) => void;
    httpIpc.sendHttp.mockReturnValue(
      new Promise<HttpResponse>((res) => (resolve = res)),
    );

    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(useAppStore.getState().apiRequests[id].sending).toBe(true);

    await act(async () => {
      resolve(response());
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});

describe("ApiRequestView — collapsible response headers", () => {
  it("hides the response headers by default and reveals them on toggle", async () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: "https://api.test" } });

    httpIpc.sendHttp.mockResolvedValue(
      response({
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "vary", value: "accept" },
        ],
      }),
    );
    await clickSend();

    // Collapsed by default: the toggle shows the count, the list is not rendered.
    const toggle = screen.getByTestId("response-headers-toggle");
    expect(toggle).toHaveTextContent("Headers (2)");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("response-headers")).toBeNull();

    // Expanding reveals the header rows; collapsing hides them again.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByTestId("response-headers");
    expect(list).toHaveTextContent("content-type");
    expect(list).toHaveTextContent("vary");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("response-headers")).toBeNull();
  });
});

describe("ApiRequestView — Format JSON on the request body", () => {
  const formatButton = () => screen.getByTestId("format-json");

  it("pretty-prints a valid-JSON body through patchApiRequest", () => {
    const id = setup();
    fireEvent.change(methodSelect(), { target: { value: "POST" } });
    fireEvent.change(screen.getByLabelText("Request body"), {
      target: { value: '{"a":1,"b":[2,3]}' },
    });

    expect(formatButton()).toBeEnabled();
    fireEvent.click(formatButton());
    expect(useAppStore.getState().apiRequests[id].body).toBe(
      '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}',
    );
  });

  it("disables Format for an empty body and for invalid JSON", () => {
    setup();
    fireEvent.change(methodSelect(), { target: { value: "POST" } });

    // Empty body → disabled.
    expect(formatButton()).toBeDisabled();

    // Invalid JSON → disabled.
    fireEvent.change(screen.getByLabelText("Request body"), {
      target: { value: "{not json" },
    });
    expect(formatButton()).toBeDisabled();
  });
});

/* ══════════════════ collections + environments ══════════════════ */

describe("ApiRequestView — durable store hydration on mount", () => {
  it("loads the durable store once on first mount and fills the environment selector", async () => {
    apiStoreIpc.loadApiStore.mockResolvedValue({
      collections: [],
      environments: [{ id: "e1", name: "prod", variables: [] }],
      activeEnvironmentId: null,
      folders: [],
    });
    const id = useAppStore.getState().apiActions.createApiRequest();
    await act(async () => {
      render(<ApiRequestView requestId={id} />);
    });

    expect(apiStoreIpc.loadApiStore).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().apiStoreLoaded).toBe(true);
    const envSelect = screen.getByLabelText("Environment");
    expect(
      within(envSelect).getByRole("option", { name: "prod" }),
    ).toBeInTheDocument();
  });

  it("skips the load when the store is already loaded", async () => {
    setup(); // hydrates → marks loaded, so the effect must not fetch again
    await act(async () => {});
    expect(apiStoreIpc.loadApiStore).not.toHaveBeenCalled();
  });

  it("drops a load that resolves after unmount (the cancelled guard)", async () => {
    let resolveLoad!: (s: ApiStore) => void;
    apiStoreIpc.loadApiStore.mockReturnValue(
      new Promise<ApiStore>((r) => (resolveLoad = r)),
    );
    const id = useAppStore.getState().apiActions.createApiRequest();
    const { unmount } = render(<ApiRequestView requestId={id} />);
    unmount(); // effect cleanup sets cancelled = true

    await act(async () => {
      resolveLoad({
        collections: [],
        environments: [{ id: "late", name: "late", variables: [] }],
        activeEnvironmentId: null,
        folders: [],
      });
    });
    // The late resolve is dropped — the store was never hydrated.
    expect(useAppStore.getState().apiStoreLoaded).toBe(false);
    expect(useAppStore.getState().apiEnvironments).toEqual([]);
  });
});

describe("ApiRequestView — environment selector", () => {
  const withEnvs: ApiStore = {
    collections: [],
    environments: [
      {
        id: "e1",
        name: "prod",
        variables: [{ key: "TOKEN", value: "secret" }],
      },
      { id: "e2", name: "dev", variables: [] },
    ],
    activeEnvironmentId: null,
    folders: [],
  };

  it("defaults to 'No environment' and sets/clears the active env on change", () => {
    setup(withEnvs);
    const envSelect = screen.getByLabelText("Environment") as HTMLSelectElement;
    expect(envSelect.value).toBe("");

    fireEvent.change(envSelect, { target: { value: "e1" } });
    expect(useAppStore.getState().activeEnvironmentId).toBe("e1");
    expect(envSelect.value).toBe("e1");

    fireEvent.change(envSelect, { target: { value: "" } }); // back to No environment
    expect(useAppStore.getState().activeEnvironmentId).toBeNull();
  });
});

describe("ApiRequestView — manage environments", () => {
  it("toggles the editor and does full env + variable CRUD", () => {
    setup();
    expect(screen.queryByTestId("api-env-manager")).toBeNull();

    fireEvent.click(screen.getByTestId("api-manage-envs"));
    const manager = screen.getByTestId("api-env-manager");
    expect(within(manager).getByText("No environments")).toBeInTheDocument();

    // Add → rename.
    fireEvent.click(screen.getByTestId("api-add-env"));
    expect(useAppStore.getState().apiEnvironments).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Environment name"), {
      target: { value: "prod" },
    });
    expect(useAppStore.getState().apiEnvironments[0].name).toBe("prod");

    // Add a variable via the add-var form (button disabled until a key is typed).
    expect(screen.getByLabelText("Add variable")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New variable key"), {
      target: { value: "TOKEN" },
    });
    fireEvent.change(screen.getByLabelText("New variable value"), {
      target: { value: "s3cr3t" },
    });
    expect(screen.getByLabelText("Add variable")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Add variable"));
    expect(useAppStore.getState().apiEnvironments[0].variables).toEqual([
      { key: "TOKEN", value: "s3cr3t" },
    ]);

    // Edit the value in place, then remove the variable.
    fireEvent.change(screen.getByLabelText("Value of TOKEN"), {
      target: { value: "rotated" },
    });
    expect(useAppStore.getState().apiEnvironments[0].variables[0].value).toBe(
      "rotated",
    );
    fireEvent.click(screen.getByLabelText("Remove TOKEN"));
    expect(useAppStore.getState().apiEnvironments[0].variables).toEqual([]);

    // Delete the environment, then close the editor (covers the toggle-off branch).
    fireEvent.click(screen.getByLabelText("Delete environment prod"));
    expect(useAppStore.getState().apiEnvironments).toEqual([]);
    fireEvent.click(screen.getByTestId("api-manage-envs"));
    expect(screen.queryByTestId("api-env-manager")).toBeNull();
  });
});

// The saved-request LIST + save flow moved out of the request view into the
// Collections rail tab and Cmd/Ctrl+S. Those surfaces are
// covered by CollectionsPanel.test.tsx and SaveRequestShortcut.test.tsx; the view
// itself no longer renders a collections panel.

describe("ApiRequestView — substitution on send (secrets only on the wire)", () => {
  it("resolves {{VAR}} from the active env on send, but the saved collection stays literal", async () => {
    const id = setup({
      collections: [],
      environments: [
        {
          id: "e1",
          name: "prod",
          variables: [
            { key: "TOKEN", value: "s3cr3t" },
            { key: "HOST", value: "api.test" },
          ],
        },
      ],
      activeEnvironmentId: "e1",
      folders: [],
    });

    fireEvent.change(methodSelect(), { target: { value: "POST" } });
    fireEvent.change(urlInput(), {
      target: { value: "https://{{HOST}}/things" },
    });
    const store = useAppStore.getState().apiActions;
    act(() => {
      store.addHeader(id);
    });
    const headerId = useAppStore.getState().apiRequests[id].headers[0].id;
    act(() => {
      store.updateHeader(id, headerId, {
        name: "Authorization",
        value: "Bearer {{TOKEN}}",
      });
    });
    fireEvent.change(screen.getByLabelText("Request body"), {
      target: { value: '{"t":"{{TOKEN}}"}' },
    });

    // Save to a collection BEFORE sending — the saved copy must keep placeholders.
    // (Saving is Cmd/Ctrl+S now, driven from the store; the substitution contract
    // under test is independent of whatever UI triggers the save.)
    act(() => {
      useAppStore.getState().apiActions.saveRequestToCollection(id, "secret req");
    });

    httpIpc.sendHttp.mockResolvedValue(response());
    await clickSend();

    // On the wire: the secret is spliced in.
    expect(httpIpc.sendHttp).toHaveBeenCalledWith({
      method: "POST",
      url: "https://api.test/things",
      headers: [{ name: "Authorization", value: "Bearer s3cr3t" }],
      body: '{"t":"s3cr3t"}',
    });

    // At rest: the saved collection keeps the placeholders — no secret persisted.
    const saved = useAppStore.getState().apiCollections[0];
    expect(saved.url).toBe("https://{{HOST}}/things");
    expect(saved.headers).toEqual([
      { name: "Authorization", value: "Bearer {{TOKEN}}" },
    ]);
    expect(saved.body).toBe('{"t":"{{TOKEN}}"}');
  });

  it("with no active environment, an unset {{VAR}} resolves to empty on the wire", async () => {
    setup(); // no environments, none active
    fireEvent.change(urlInput(), { target: { value: "https://{{HOST}}/x" } });
    httpIpc.sendHttp.mockResolvedValue(response());
    await clickSend();
    expect(httpIpc.sendHttp).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "https:///x" }),
    );
  });
});

/* ══════════════════════ protocol toggle ══════════════════════ */

describe("ApiRequestView — protocol toggle (HTTP | WebSocket)", () => {
  it("defaults to HTTP and swaps the surface to the WS console and back", () => {
    const id = setup();
    // HTTP by default — the request surface is shown, no WS console.
    expect(useAppStore.getState().apiRequests[id].protocol).toBe("http");
    expect(screen.getByLabelText("HTTP method")).toBeInTheDocument();
    expect(screen.queryByTestId("ws-console")).toBeNull();

    const group = screen.getByTestId("api-protocol");
    fireEvent.click(within(group).getByText("WebSocket"));

    // WS console replaces the HTTP surface.
    expect(useAppStore.getState().apiRequests[id].protocol).toBe("ws");
    expect(screen.queryByLabelText("HTTP method")).toBeNull();
    expect(screen.getByTestId("ws-console")).toBeInTheDocument();
    expect(screen.getByLabelText("WebSocket URL")).toBeInTheDocument();

    // Back to HTTP restores the request surface.
    fireEvent.click(within(group).getByText("HTTP"));
    expect(useAppStore.getState().apiRequests[id].protocol).toBe("http");
    expect(screen.getByLabelText("HTTP method")).toBeInTheDocument();
    expect(screen.queryByTestId("ws-console")).toBeNull();
  });

  it("swaps the surface to the gRPC console and back", async () => {
    const id = setup();
    const group = screen.getByTestId("api-protocol");

    await act(async () => {
      fireEvent.click(within(group).getByText("gRPC"));
    });
    // gRPC console replaces the HTTP surface.
    expect(useAppStore.getState().apiRequests[id].protocol).toBe("grpc");
    expect(screen.queryByLabelText("HTTP method")).toBeNull();
    expect(screen.getByTestId("grpc-console")).toBeInTheDocument();
    expect(screen.getByLabelText("gRPC endpoint")).toBeInTheDocument();

    // Back to HTTP restores the request surface.
    fireEvent.click(within(group).getByText("HTTP"));
    expect(useAppStore.getState().apiRequests[id].protocol).toBe("http");
    expect(screen.getByLabelText("HTTP method")).toBeInTheDocument();
    expect(screen.queryByTestId("grpc-console")).toBeNull();
  });
});

/**
 * The bug: the find bar still disappeared when moving
 * between tabs, and it was noticeable in the HTTP request view. `Pane` renders
 * only the ACTIVE tab, so switching (or dragging) a tab unmounts this whole
 * view — the find bar's state now survives in `findBars["api:<requestId>"]`.
 * Here unmount + remount of the view IS the tab switch.
 */
describe("ApiRequestView — the find bar survives a tab switch", () => {
  /** A request with a JSON response already landed — seeded BEFORE render. */
  function seedResponse(body = '{"alpha":"beta","gamma":"beta-2"}'): string {
    useAppStore.getState().apiActions.hydrateApiStore(emptyStore);
    const id = useAppStore.getState().apiActions.createApiRequest();
    useAppStore.getState().apiActions.patchApiRequest(id, { url: "https://a.test/x" });
    useAppStore.getState().apiActions.setApiResponse(id, response({ body }));
    return id;
  }

  it("keeps the bar, query, Raw/Formatted choice and cursor across unmount/remount", () => {
    const id = seedResponse();
    const first = render(<ApiRequestView requestId={id} />);
    fireEvent.click(screen.getByTestId("response-find-toggle"));
    fireEvent.change(screen.getByTestId("response-find-input"), {
      target: { value: "beta" },
    });
    fireEvent.click(screen.getByTestId("response-find-next")); // walk to match 2
    fireEvent.click(screen.getByTestId("response-view-toggle")); // Formatted → Raw
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2/2");

    first.unmount(); // the tab switch: Pane drops the inactive tab's subtree
    render(<ApiRequestView requestId={id} />);

    // Everything that used to disappear is still there:
    expect(screen.getByTestId("response-find")).toBeInTheDocument();
    expect(screen.getByTestId("response-find-input")).toHaveValue("beta");
    // Still the RAW view (the toggle names the view you switch TO)…
    expect(screen.getByTestId("response-view-toggle")).toHaveTextContent("Formatted");
    expect(screen.queryByTestId("json-view")).toBeNull();
    // …and still standing on match 2.
    expect(screen.getByTestId("response-find-count")).toHaveTextContent("2/2");
  });

  it("does not bleed into another request's tab — a different id starts closed", () => {
    const id = seedResponse();
    const first = render(<ApiRequestView requestId={id} />);
    fireEvent.click(screen.getByTestId("response-find-toggle"));
    fireEvent.change(screen.getByTestId("response-find-input"), {
      target: { value: "beta" },
    });
    first.unmount();

    // A second request = a different `api:<requestId>` key.
    const other = useAppStore.getState().apiActions.createApiRequest();
    useAppStore.getState().apiActions.patchApiRequest(other, { url: "https://b.test/y" });
    useAppStore.getState().apiActions.setApiResponse(other, response());
    render(<ApiRequestView requestId={other} />);
    expect(screen.queryByTestId("response-find")).toBeNull();
  });

  it("Esc drops the record outright — keyed by the request identity", () => {
    const id = seedResponse();
    render(<ApiRequestView requestId={id} />);
    fireEvent.click(screen.getByTestId("response-find-toggle"));
    fireEvent.change(screen.getByTestId("response-find-input"), {
      target: { value: "beta" },
    });
    // Two-sided: the record exists (under the documented key shape)…
    expect(useAppStore.getState().findBars[`api:${id}`]).toMatchObject({
      open: true,
      query: "beta",
    });

    fireEvent.keyDown(screen.getByTestId("response-find-input"), { key: "Escape" });
    // …and Esc deletes it — absence IS the closed state, no tombstone.
    expect(useAppStore.getState().findBars[`api:${id}`]).toBeUndefined();
    expect(screen.queryByTestId("response-find")).toBeNull();
  });
});

/**
 * Copy as cURL: the command on the clipboard is built by
 * `buildCurl` from the request's CURRENT fields, resolved through the SAME
 * `{{VAR}}` seam the send path uses (`activeVars` + `substituteVars`). The
 * resolved secret exists on the clipboard only — never at rest.
 */
describe("ApiRequestView — Copy as cURL", () => {
  const PROD: ApiStore = {
    collections: [],
    folders: [],
    environments: [
      {
        id: "e1",
        name: "prod",
        variables: [
          { key: "TOKEN", value: "s3cr3t" },
          { key: "HOST", value: "api.test" },
        ],
      },
    ],
    activeEnvironmentId: "e1",
  };

  it("does nothing — and does not throw — when the webview has no clipboard", () => {
    // jsdom has no navigator.clipboard by default; thumbnail/preview contexts in
    // the real webview can lack it too. The guard is `return`, not a crash.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    setup(PROD);
    fireEvent.click(screen.getByTestId("api-copy-curl"));
    expect(screen.getByTestId("api-copy-curl")).not.toHaveTextContent("Copied");
  });

  it("does nothing — and does not throw — when the webview has no clipboard", () => {
    // jsdom has no navigator.clipboard by default; preview contexts in the real
    // webview can lack it too. The guard is `return`, not a crash.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    setup(PROD);
    fireEvent.click(screen.getByTestId("api-copy-curl"));
    expect(screen.getByTestId("api-copy-curl")).not.toHaveTextContent("Copied");
  });

  it("puts the built command on the clipboard with {{VAR}} resolved like a real send", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const id = setup(PROD);

    fireEvent.change(methodSelect(), { target: { value: "POST" } });
    fireEvent.change(urlInput(), { target: { value: "https://{{HOST}}/things" } });
    const store = useAppStore.getState().apiActions;
    act(() => {
      store.addHeader(id);
    });
    const headerId = useAppStore.getState().apiRequests[id].headers[0].id;
    act(() => {
      store.updateHeader(id, headerId, {
        name: "Authorization",
        value: "Bearer {{TOKEN}}",
      });
    });
    fireEvent.change(screen.getByLabelText("Request body"), {
      target: { value: '{"t":"{{TOKEN}}"}' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("api-copy-curl"));
    });

    // The EXACT command the exporter builds from these fields + this resolver.
    // What is under test here is the WIRING (the fields handed over + the
    // resolver seam); the curl grammar itself is curlExport.test.ts's job.
    const req = useAppStore.getState().apiRequests[id];
    const vars = { TOKEN: "s3cr3t", HOST: "api.test" };
    const expected = buildCurl(
      { method: req.method, url: req.url, headers: req.headers, body: req.body },
      (t) => substituteVars(t, vars),
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0][0] as string;
    expect(written).toBe(expected);
    // Non-tautological anchors: resolved values in, placeholders out.
    expect(written).toContain("api.test");
    expect(written).toContain("Bearer s3cr3t");
    expect(written).not.toContain("{{");
    // …and the button says so.
    expect(screen.getByTestId("api-copy-curl")).toHaveTextContent("Copied");
  });

  it("a refused clipboard never claims success", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    setup(PROD);
    fireEvent.change(urlInput(), { target: { value: "https://a.test/x" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("api-copy-curl"));
      // Let the rejection actually settle so the `.catch` runs (no fake timers).
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalled();
    expect(screen.getByTestId("api-copy-curl")).toHaveTextContent("Copy as cURL");
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("retires the Copied claim when the request changes — the clipboard no longer matches", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    setup(PROD);
    fireEvent.change(urlInput(), { target: { value: "https://a.test/x" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("api-copy-curl"));
    });
    expect(screen.getByTestId("api-copy-curl")).toHaveTextContent("Copied");

    // Any edit makes the copied command stale — the badge must not keep claiming.
    fireEvent.change(urlInput(), { target: { value: "https://a.test/other" } });
    expect(screen.getByTestId("api-copy-curl")).toHaveTextContent("Copy as cURL");
  });
});

/**
 * Windows. A bash command is broken in PowerShell and cmd, so on
 * Windows "Copy as cURL" says which shell it writes for; and the URL field reads
 * the Windows pastes (DevTools' cmd form) and names the one it cannot read
 * (Copy as PowerShell). The quoting itself is curlExport/curlParse's job — this
 * pins the wiring.
 */
describe("ApiRequestView — Windows: Copy as cURL per shell, and Windows pastes", () => {
  const WEBVIEW2 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
  const onWindows = () => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(WEBVIEW2);
  const shellPicker = () => screen.getByTestId("api-curl-shell") as HTMLSelectElement;
  const copyButton = () => screen.getByTestId("api-copy-curl");

  afterEach(() => vi.restoreAllMocks());

  /** A clipboard that records what it was given. */
  function clipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  }

  it("off Windows there is no shell picker, and the copy is the bash form", async () => {
    const writeText = clipboard();
    setup();
    expect(screen.queryByTestId("api-curl-shell")).toBeNull();
    fireEvent.change(urlInput(), { target: { value: "https://a.test/x" } });
    await act(async () => {
      fireEvent.click(copyButton());
    });
    expect(writeText).toHaveBeenLastCalledWith("curl 'https://a.test/x'");
  });

  it("on Windows it starts on PowerShell, and each choice copies that shell's command", async () => {
    onWindows();
    const writeText = clipboard();
    const id = setup();
    expect(shellPicker().value).toBe("powershell");
    fireEvent.change(methodSelect(), { target: { value: "POST" } });
    fireEvent.change(urlInput(), { target: { value: "https://a.test/x" } });
    fireEvent.change(screen.getByLabelText("Request body"), { target: { value: '{"a":1}' } });
    const req = () => {
      const r = useAppStore.getState().apiRequests[id];
      return { method: r.method, url: r.url, headers: r.headers, body: r.body };
    };

    await act(async () => {
      fireEvent.click(copyButton());
    });
    expect(writeText).toHaveBeenLastCalledWith(buildCurl(req(), (t) => t, "powershell"));
    expect(writeText.mock.lastCall![0]).toContain("curl.exe -X POST 'https://a.test/x'");
    expect(copyButton()).toHaveTextContent("Copied");

    // A different shell is a different command: the claim retires until copied again.
    fireEvent.change(shellPicker(), { target: { value: "cmd" } });
    expect(copyButton()).toHaveTextContent("Copy as cURL");
    await act(async () => {
      fireEvent.click(copyButton());
    });
    expect(writeText).toHaveBeenLastCalledWith('curl -X ^"POST^" ^"https://a.test/x^" --data-raw ^"^{\\^"a\\^":1^}^"');
    expect(copyButton()).toHaveTextContent("Copied");

    fireEvent.change(shellPicker(), { target: { value: "bash" } });
    await act(async () => {
      fireEvent.click(copyButton());
    });
    expect(writeText).toHaveBeenLastCalledWith(`curl -X POST 'https://a.test/x' --data '{"a":1}'`);
  });

  it("warns that non-ASCII text will not survive Windows' curl.exe from PowerShell or cmd — not from bash", () => {
    onWindows();
    setup();
    fireEvent.change(urlInput(), { target: { value: "https://a.test/café" } });
    expect(screen.getByTestId("api-curl-ascii-note")).toHaveTextContent("from PowerShell that text");
    fireEvent.change(shellPicker(), { target: { value: "cmd" } });
    expect(screen.getByTestId("api-curl-ascii-note")).toHaveTextContent("from cmd that text");
    fireEvent.change(shellPicker(), { target: { value: "bash" } });
    expect(screen.queryByTestId("api-curl-ascii-note")).toBeNull();
  });

  it("never shows that warning for plain ASCII, nor off Windows at all", () => {
    onWindows();
    setup();
    fireEvent.change(urlInput(), { target: { value: "https://a.test/cafe" } });
    expect(screen.queryByTestId("api-curl-ascii-note")).toBeNull();
    cleanup();
    vi.restoreAllMocks();
    setup();
    fireEvent.change(urlInput(), { target: { value: "https://a.test/café" } });
    expect(screen.queryByTestId("api-curl-ascii-note")).toBeNull();
  });

  it("imports DevTools' Copy as cURL (cmd) pasted with Windows line endings", () => {
    const id = setup();
    const cmd =
      'curl --url ^"https://a.test/v1?a=1^&b=2^" ^\r\n  -H ^"accept: */*^" ^\r\n' +
      '  -b ^"sid=1^" ^\r\n  --data-raw ^"^{^\\^"q^\\^":^\\^"100^%^\\^"^}^"';
    fireEvent.paste(urlInput(), { clipboardData: { getData: () => cmd } });
    const req = useAppStore.getState().apiRequests[id];
    expect(req).toMatchObject({ method: "POST", url: "https://a.test/v1?a=1&b=2", body: '{"q":"100%"}' });
    expect(req.headers.map((h) => [h.name, h.value])).toEqual([
      ["accept", "*/*"],
      ["Cookie", "sid=1"],
    ]);
  });

  it("says what to copy instead of Copy as PowerShell, keeps the URL, and clears on the next edit", () => {
    const id = setup();
    fireEvent.change(urlInput(), { target: { value: "https://keep.test" } });
    const iwr =
      "$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession\r\n" +
      'Invoke-WebRequest -UseBasicParsing -Uri "https://a.test/x" `\r\n-WebSession $session';
    fireEvent.paste(urlInput(), { clipboardData: { getData: () => iwr } });
    expect(screen.getByTestId("api-paste-hint")).toHaveTextContent("Copy as cURL (cmd)");
    expect(useAppStore.getState().apiRequests[id].url).toBe("https://keep.test");

    fireEvent.change(urlInput(), { target: { value: "https://keep.test/2" } });
    expect(screen.queryByTestId("api-paste-hint")).toBeNull();
  });

  it("clears that hint when a real curl is imported after it — and catches a typed Invoke-WebRequest too", () => {
    setup();
    fireEvent.change(urlInput(), { target: { value: 'Invoke-WebRequest -Uri "https://a.test"' } });
    expect(screen.getByTestId("api-paste-hint")).toBeInTheDocument();
    fireEvent.paste(urlInput(), { clipboardData: { getData: () => "curl https://a.test/y" } });
    expect(screen.queryByTestId("api-paste-hint")).toBeNull();
  });
});
