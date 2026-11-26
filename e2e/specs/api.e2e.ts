/** A2 (+A3): the API client against a throwaway 127.0.0.1 server (seam S7), through real IPC and
 * reqwest in the Rust core: the round trip the browser tier's mocked backend cannot cover. */

import { $, expect } from "@wdio/globals";
import { startHttpFixture, type HttpFixture } from "../support/http-fixture";

describe("api client: real IPC → reqwest → local 127.0.0.1 server", () => {
  let fixture: HttpFixture;

  before(async () => {
    fixture = await startHttpFixture();
  });

  after(async () => {
    await fixture?.close();
  });

  it("GET shows a 200 status pill and the JSON body", async () => {
    // Titlebar globe → open a new API request tab.
    await $('[aria-label="New API request"]').click();
    const view = await $('[data-testid="api-request"]');
    await view.waitForExist({ timeout: 15_000 });

    await $('[aria-label="Request URL"]').setValue(`${fixture.url}/health`);
    await $('[data-testid="api-send"]').click();

    const status = await $('[data-testid="api-status"]');
    await status.waitForExist({ timeout: 15_000 });
    await expect(status).toHaveText("200");

    // The canned GET body ({ ok: true, ... }), rendered as the JsonView tree (`ok: true`,
    // unquoted keys) — the old `"ok": true` expectation predates the tree view and went
    // unnoticed while this suite could not load at all (wdio.conf `__dirname`).
    await expect($('[data-testid="api-response-body"]')).toHaveText("ok: true", {
      containing: true,
    });
  });

  it("POST round-trips the request body to the echo endpoint", async () => {
    // Reuse the same request tab: switch method → POST, type a body, send.
    await $('[aria-label="HTTP method"]').selectByAttribute("value", "POST");
    await $('[aria-label="Request URL"]').setValue(`${fixture.url}/echo`);

    const marker = "e2e-post-marker";
    await $('[aria-label="Request body"]').setValue(marker);
    await $('[data-testid="api-send"]').click();

    // The echo server returns { echoed: <body>, ... }; expect-webdriverio retries
    // until the body re-renders with our marker.
    await expect($('[data-testid="api-response-body"]')).toHaveText(marker, {
      containing: true,
    });
  });
});
