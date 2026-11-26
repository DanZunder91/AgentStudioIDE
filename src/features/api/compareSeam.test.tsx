/** A/B compare SEAM test: the REAL ApiRequestView, store, `executeCompareRequest`, ComparePanel
 * and JsonView joined, with ONLY the IPC boundary mocked. Each module's units live elsewhere. */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const httpIpc = vi.hoisted(() => ({ sendHttp: vi.fn() }));
vi.mock("./httpIpc", () => httpIpc);
const grpcIpc = vi.hoisted(() => ({ grpcReflect: vi.fn(), grpcSend: vi.fn() }));
vi.mock("./grpcIpc", () => grpcIpc);
const apiStoreIpc = vi.hoisted(() => ({
  loadApiStore: vi.fn(),
  saveApiStore: vi.fn(),
}));
vi.mock("./apiStoreIpc", () => apiStoreIpc);
const historyIpc = vi.hoisted(() => ({
  loadApiHistory: vi.fn(),
  saveApiHistory: vi.fn(),
}));
vi.mock("./historyIpc", () => historyIpc);

import { useAppStore } from "../../app/store";
import { resetStore } from "../../test/store-harness";
import { ApiRequestView } from "./ApiRequestView";
import type { HttpRequest, HttpResponse } from "./httpIpc";

const response = (body: string, over: Partial<HttpResponse> = {}): HttpResponse => ({
  status: 200,
  statusText: "OK",
  headers: [{ name: "content-type", value: "application/json" }],
  body,
  durationMs: 12,
  sizeBytes: body.length,
  truncated: false,
  ...over,
});

const api = () => useAppStore.getState().apiActions;
const compareOf = (id: string) =>
  useAppStore.getState().apiRequests[id].compare;

const urlA = () => screen.getByLabelText("Request URL") as HTMLInputElement;
const urlB = () => screen.getByLabelText("Request B URL") as HTMLInputElement;
const toggle = () => screen.getByTestId("api-compare-toggle");
const sendButton = () =>
  screen.getByTestId("api-send") as HTMLButtonElement;

/** Mount a fresh request's view with the durable store pre-hydrated empty. */
function setup(): string {
  api().hydrateApiStore({
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    folders: [],
  });
  const id = api().createApiRequest();
  render(<ApiRequestView requestId={id} />);
  return id;
}

describe("A/B compare through the real view (seam)", () => {
  beforeEach(() => {
    resetStore();
    httpIpc.sendHttp.mockReset();
    historyIpc.saveApiHistory.mockReset();
  });

  it("toggling A/B on prefills B from A; an already-typed B is never clobbered", () => {
    const id = setup();
    fireEvent.change(urlA(), { target: { value: "https://a.test/users" } });
    fireEvent.click(toggle());
    expect(compareOf(id)).toMatchObject({
      enabled: true,
      url: "https://a.test/users",
      method: "GET",
    });
    expect(urlB().value).toBe("https://a.test/users");

    // Type a different B, leave compare, re-enter: B must survive as typed.
    fireEvent.change(urlB(), { target: { value: "https://b.test/users" } });
    fireEvent.click(toggle());
    expect(screen.queryByTestId("compare-bar")).toBeNull();
    fireEvent.click(toggle());
    expect(urlB().value).toBe("https://b.test/users");
  });

  it("one Send fires both wires and both responses render side by side", async () => {
    const id = setup();
    fireEvent.change(urlA(), { target: { value: "https://a.test/u" } });
    fireEvent.click(toggle());
    fireEvent.change(urlB(), { target: { value: "https://b.test/u" } });

    httpIpc.sendHttp.mockImplementation((r: HttpRequest) =>
      Promise.resolve(
        r.url.includes("a.test")
          ? response('{"name":"ada","site":"a"}')
          : response('{"name":"ada","site":"b"}', { status: 404, statusText: "Not Found" }),
      ),
    );
    await act(async () => {
      fireEvent.click(sendButton());
    });

    expect(httpIpc.sendHttp).toHaveBeenCalledTimes(2);
    const urls = httpIpc.sendHttp.mock.calls.map(
      (c) => (c[0] as HttpRequest).url,
    );
    expect(urls).toEqual(["https://a.test/u", "https://b.test/u"]);

    const panel = screen.getByTestId("compare-panel");
    expect(
      within(panel).getByTestId("compare-status-a").textContent,
    ).toBe("200");
    expect(
      within(panel).getByTestId("compare-status-b").textContent,
    ).toBe("404");
    expect(compareOf(id).sending).toBe(false);
  });

  it("Send disables and reads Sending… until BOTH sides settle", async () => {
    setup();
    fireEvent.change(urlA(), { target: { value: "https://a.test/u" } });
    fireEvent.click(toggle());

    let settleB!: (r: HttpResponse) => void;
    httpIpc.sendHttp
      .mockResolvedValueOnce(response('{"ok":1}'))
      .mockImplementationOnce(
        () => new Promise<HttpResponse>((res) => (settleB = res)),
      );
    await act(async () => {
      fireEvent.click(sendButton());
    });
    // A landed, B still in flight — the one Send is still "Sending…".
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().textContent).toBe("Sending…");
    await act(async () => {
      settleB(response('{"ok":2}'));
    });
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().textContent).toBe("Send");
  });

  it("clicking a key in pane A cross-highlights it in pane B, through the real store", async () => {
    const id = setup();
    fireEvent.change(urlA(), { target: { value: "https://a.test/u" } });
    fireEvent.click(toggle());
    httpIpc.sendHttp.mockResolvedValue(
      response('{"name":"ada","rank":1}'),
    );
    await act(async () => {
      fireEvent.click(sendButton());
    });

    const paneA = screen.getByTestId("compare-pane-a");
    const paneB = screen.getByTestId("compare-pane-b");
    fireEvent.click(
      within(paneA).getAllByTestId("json-key").find(
        (el) => el.getAttribute("data-key") === "name",
      )!,
    );
    expect(compareOf(id).selectedKey).toBe("name");
    const bKey = within(paneB)
      .getAllByTestId("json-key")
      .find((el) => el.getAttribute("data-key") === "name")!;
    expect(bKey.getAttribute("data-selected")).toBe("true");
  });

  it("the sort toggle reorders keys in BOTH panes", async () => {
    setup();
    fireEvent.change(urlA(), { target: { value: "https://a.test/u" } });
    fireEvent.click(toggle());
    httpIpc.sendHttp.mockResolvedValue(response('{"z":1,"a":2}'));
    await act(async () => {
      fireEvent.click(sendButton());
    });

    const keysOf = (pane: HTMLElement) =>
      within(pane)
        .getAllByTestId("json-key")
        .map((el) => el.getAttribute("data-key"));
    expect(keysOf(screen.getByTestId("compare-pane-a"))).toEqual(["z", "a"]);
    fireEvent.click(screen.getByTestId("compare-sort"));
    expect(keysOf(screen.getByTestId("compare-pane-a"))).toEqual(["a", "z"]);
    expect(keysOf(screen.getByTestId("compare-pane-b"))).toEqual(["a", "z"]);
  });

  it("leaving compare mode restores the single response panel untouched", async () => {
    const id = setup();
    fireEvent.change(urlA(), { target: { value: "https://a.test/u" } });
    // A single-mode send first…
    httpIpc.sendHttp.mockResolvedValue(response('{"solo":true}'));
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(screen.getByTestId("api-response")).toBeTruthy();
    // …then a compare round, then back: the single outcome must still be there.
    fireEvent.click(toggle());
    httpIpc.sendHttp.mockResolvedValue(response('{"duo":true}'));
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(screen.queryByTestId("api-response")).toBeNull();
    fireEvent.click(toggle());
    expect(screen.getByTestId("api-response")).toBeTruthy();
    expect(
      useAppStore.getState().apiRequests[id].response?.body,
    ).toBe('{"solo":true}');
  });

  it("Cmd/Ctrl+Enter in the B url sends the pair", async () => {
    setup();
    fireEvent.change(urlA(), { target: { value: "https://a.test/u" } });
    fireEvent.click(toggle());
    httpIpc.sendHttp.mockResolvedValue(response("{}"));
    await act(async () => {
      fireEvent.keyDown(urlB(), { key: "Enter", metaKey: true });
    });
    expect(httpIpc.sendHttp).toHaveBeenCalledTimes(2);
  });

  it("Send stays disabled in compare mode while B's url is empty", () => {
    const id = setup();
    fireEvent.change(urlA(), { target: { value: "https://a.test/u" } });
    fireEvent.click(toggle());
    fireEvent.change(urlB(), { target: { value: "" } });
    expect(sendButton().disabled).toBe(true);
    // …and the executor guard agrees even if the click got through somehow.
    api().patchCompare(id, { url: " " });
    fireEvent.click(sendButton());
    expect(httpIpc.sendHttp).not.toHaveBeenCalled();
  });
});
