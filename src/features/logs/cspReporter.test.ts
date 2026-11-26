/** The reporter (synthetic `Event`s with report fields assigned: jsdom has no
 * `SecurityPolicyViolationEvent` and enforces no CSP) and a guard over `tauri.conf.json`'s CSP,
 * kept here because vitest only collects `src/**` and `scripts/**`. See docs/design/csp.md. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CSP_LOG_SOURCE, startCspReporter } from "./cspReporter";
import { useLogStore, type LogEntry } from "./logStore";

/* ── helpers ──────────────────────────────────────────────────────────────── */

const entries = (): LogEntry[] => useLogStore.getState().entries;

function resetLogStore(): void {
  useLogStore.setState({
    entries: [],
    visible: false,
    levelFilter: "all",
    textFilter: "",
    nextId: 0,
  });
}

/** Every field a `SecurityPolicyViolationEvent` exposes that the reporter reads. */
interface Report {
  violatedDirective?: string;
  effectiveDirective?: string;
  blockedURI?: string;
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
  sample?: string;
}

/** Dispatch a synthetic violation at `document` (a plain `Event`: jsdom lacks the constructor). */
function violate(report: Report): void {
  const event = new Event("securitypolicyviolation");
  Object.assign(event, report);
  document.dispatchEvent(event);
}

beforeEach(() => resetLogStore());
afterEach(() => vi.unstubAllGlobals());

/* ── the reporter ─────────────────────────────────────────────────────────── */

describe("startCspReporter — logging a violation", () => {
  it("appends one WARN line naming the directive, the blocked URI and the source location", () => {
    const stop = startCspReporter();

    violate({
      effectiveDirective: "img-src",
      violatedDirective: "img-src 'self' data:",
      blockedURI: "https://img.shields.io/badge/build-passing-green.svg",
      sourceFile: "tauri://localhost/assets/index-Ycw85b_u.js",
      lineNumber: 42,
      columnNumber: 7,
    });

    expect(entries()).toHaveLength(1);
    expect(entries()[0].level).toBe("warn");
    expect(entries()[0].source).toBe("csp");
    expect(entries()[0].message).toBe(
      "img-src blocked https://img.shields.io/badge/build-passing-green.svg",
    );
    expect(entries()[0].detail).toBe("at tauri://localhost/assets/index-Ycw85b_u.js:42:7");

    stop();
  });

  it("includes the offending sample when the browser reports one", () => {
    const stop = startCspReporter();

    violate({
      effectiveDirective: "style-src-elem",
      blockedURI: "inline",
      sourceFile: "tauri://localhost/",
      lineNumber: 1,
      columnNumber: 1,
      sample: ".cm-editor { color: red }",
    });

    expect(entries()[0].message).toBe("style-src-elem blocked inline");
    expect(entries()[0].detail).toBe(
      "at tauri://localhost/:1:1 — sample: .cm-editor { color: red }",
    );

    stop();
  });

  it("falls back to `violatedDirective` when `effectiveDirective` is absent", () => {
    const stop = startCspReporter();

    // WebKit historically reported only the deprecated `violatedDirective`.
    violate({
      violatedDirective: "connect-src",
      blockedURI: "ipc://localhost/terminal_write",
      sourceFile: "tauri://localhost/assets/index.js",
      lineNumber: 9,
      columnNumber: 2,
    });

    expect(entries()[0].message).toBe("connect-src blocked ipc://localhost/terminal_write");

    stop();
  });

  it("still logs a readable line when every optional field is missing or empty", () => {
    const stop = startCspReporter();

    // The degenerate report: no directive, empty URI, empty source, no line/column,
    // empty sample. A half-reported violation must still be diagnosable, because
    // the log line IS the diagnosis.
    violate({ effectiveDirective: "", violatedDirective: "", blockedURI: "", sourceFile: "", sample: "" });

    expect(entries()).toHaveLength(1);
    expect(entries()[0].level).toBe("warn");
    expect(entries()[0].source).toBe("csp");
    expect(entries()[0].message).toBe("(unknown) blocked (unknown)");
    expect(entries()[0].detail).toBe("at (unknown):0:0");

    stop();
  });

  it("logs one line per violation, in order", () => {
    const stop = startCspReporter();

    violate({ effectiveDirective: "font-src", blockedURI: "https://fonts.example/a.woff2" });
    violate({ effectiveDirective: "frame-src", blockedURI: "https://ads.example/f" });

    expect(entries().map((e) => e.message)).toEqual([
      "font-src blocked https://fonts.example/a.woff2",
      "frame-src blocked https://ads.example/f",
    ]);

    stop();
  });

  it("exports the log source the panel filters on", () => {
    expect(CSP_LOG_SOURCE).toBe("csp");
  });
});

describe("startCspReporter — lifecycle", () => {
  it("removes the listener on unsubscribe, so a later violation logs nothing", () => {
    const stop = startCspReporter();
    violate({ effectiveDirective: "img-src", blockedURI: "https://a.example/1.png" });
    expect(entries()).toHaveLength(1);

    stop();

    violate({ effectiveDirective: "img-src", blockedURI: "https://a.example/2.png" });
    expect(entries()).toHaveLength(1); // unchanged — the listener is gone
    expect(entries()[0].message).toBe("img-src blocked https://a.example/1.png");
  });

  it("registers exactly one listener per start (two starts → two lines)", () => {
    // Guards the mount site: `<App/>` must call this once. If it ever mounted
    // twice without stopping, every violation would double up in the panel.
    const stopA = startCspReporter();
    const stopB = startCspReporter();

    violate({ effectiveDirective: "img-src", blockedURI: "https://a.example/1.png" });
    expect(entries()).toHaveLength(2);

    stopA();
    stopB();
  });

  it("is a no-op — and does not throw — where there is no `document`", () => {
    vi.stubGlobal("document", undefined);

    const stop = startCspReporter();
    expect(() => stop()).not.toThrow();
    expect(entries()).toHaveLength(0);
  });
});

/* ── the shipped policy (regression guard over tauri.conf.json) ───────────── */

describe("tauri.conf.json — the Content-Security-Policy", () => {
  // Read from the repo root (`process.cwd()`; `import.meta.url` is not a `file:` URL under
  // vite-node). Not imported: `tsconfig.json` covers only `src`, so typecheck would break.
  const CONF_PATH = resolve(process.cwd(), "src-tauri/tauri.conf.json");
  const conf = JSON.parse(readFileSync(CONF_PATH, "utf8")) as {
    app: { security: { csp?: string | null; devCsp?: string | null } };
  };

  const csp = conf.app.security.csp;
  const devCsp = conf.app.security.devCsp;

  /** `"a 'self'; b 'none'"` → `{ a: "'self'", b: "'none'" }`. */
  function directives(policy: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of policy.split(";")) {
      const [name, ...sources] = part.trim().split(" ");
      out[name] = sources.join(" ");
    }
    return out;
  }

  it("is set at all — never `null`", () => {
    // THE finding this whole change closes: the webview shipped with no policy
    // while exposing `terminal_write` (arbitrary local code execution by design).
    expect(csp).not.toBeNull();
    expect(typeof csp).toBe("string");
    expect(devCsp).not.toBeNull();
    expect(typeof devCsp).toBe("string");
  });

  it("bases both policies on `default-src 'self'`", () => {
    expect(directives(csp as string)["default-src"]).toBe("'self'");
    // Dev additionally reaches the Vite dev server; the base is still 'self'.
    expect(directives(devCsp as string)["default-src"]).toBe(
      "'self' http://localhost:1420 http://127.0.0.1:1420",
    );
  });

  it("never allows eval in `script-src` — in production OR in dev", () => {
    // Nothing in the bundle evals, and Shiki uses the JS RegExp engine (no WASM), so neither
    // `'unsafe-eval'` nor `'wasm-unsafe-eval'` is needed. See docs/design/csp.md.
    for (const policy of [csp as string, devCsp as string]) {
      const scriptSrc = directives(policy)["script-src"];
      expect(scriptSrc).not.toContain("'unsafe-eval'");
      expect(scriptSrc).not.toContain("'wasm-unsafe-eval'");
    }
  });

  it("keeps the SHIPPED policy free of `'unsafe-inline'` scripts and of dev's looseness", () => {
    const prod = directives(csp as string);
    expect(prod["script-src"]).toBe("'self'");
    // Nothing about the dev server may leak into the shipped policy.
    expect(csp as string).not.toContain("localhost:1420");
    expect(csp as string).not.toContain("ws://");
  });

  it("allows the Tauri v2 IPC transport on `connect-src`", () => {
    // Tauri v2's `invoke` is a real `fetch()` to `ipc://localhost/<cmd>` (macOS,
    // Linux) or `http://ipc.localhost/<cmd>` (Windows) — `scripts/ipc-protocol.js`
    // in tauri 2.11.5. `connect-src` governs it, so omitting these bricks the app.
    const connect = directives(csp as string)["connect-src"];
    expect(connect).toBe("'self' ipc: http://ipc.localhost");
  });

  it("allows local `data:` images and remote README images, deliberately", () => {
    // `read_image_data_url` inlines local images as `data:` URLs; README badges
    // are remote. Both are product requirements — see docs/design/csp.md §img-src
    // for the exfiltration risk this knowingly accepts.
    expect(directives(csp as string)["img-src"]).toBe("'self' data: https: http:");
  });

  it("needs `'unsafe-inline'` on `style-src`, and says so in one place only", () => {
    // CodeMirror, xterm.js and mermaid inject <style>, React writes inline styles, and no nonce
    // exists: a documented residual risk (docs/design/csp.md).
    expect(directives(csp as string)["style-src"]).toBe("'self' 'unsafe-inline'");
  });

  it("locks down the directives nothing in the app uses", () => {
    const prod = directives(csp as string);
    expect(prod["object-src"]).toBe("'none'");
    expect(prod["frame-ancestors"]).toBe("'none'");
    expect(prod["base-uri"]).toBe("'none'");
    expect(prod["form-action"]).toBe("'none'");
  });

  /** `frame-src` admits only our `preview://` scheme (served by `html_preview.rs` behind
   * `resolve_in_scope`), in both platform spellings. A wildcard would let rendered pages frame
   * remote content. */
  it("admits the preview scheme to frame-src, and nothing else", () => {
    for (const policy of [csp, devCsp]) {
      const frameSrc = directives(policy as string)["frame-src"];
      expect(frameSrc).toBe("preview: http://preview.localhost");
      expect(frameSrc).not.toContain("*");
      expect(frameSrc).not.toContain("https:");
      expect(frameSrc).not.toContain("'self'");
    }
  });

  it("never points a violation report at an external collector", () => {
    // This app must not phone home. The reporter above IS the whole reporting
    // channel, and it stays in-process.
    for (const policy of [csp as string, devCsp as string]) {
      expect(policy).not.toContain("report-uri");
      expect(policy).not.toContain("report-to");
    }
  });

  it("parses cleanly the way Tauri parses it — no empty directive or source token", () => {
    // `Csp::Policy` → `HashMap` splits on ';' then on a SINGLE ' ' (tauri-utils
    // 2.9.3 config.rs). A double space or a trailing ';' therefore yields an empty
    // token that lands verbatim in the header.
    for (const policy of [csp as string, devCsp as string]) {
      expect(policy).not.toContain("  ");
      expect(policy.trim().endsWith(";")).toBe(false);
      for (const part of policy.split(";")) {
        expect(part.trim().split(" ")).not.toContain("");
      }
    }
  });
});
