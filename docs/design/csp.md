# Content-Security-Policy — the shipped webview policy

**Status:** implemented. Replaces the absent policy (`"csp": null`).

**Where it lives:** `src-tauri/tauri.conf.json` → `app.security.csp` (shipped) and
`app.security.devCsp` (development). JSON carries no comments, so **this file is the
comment**. Its regression guard is
`src/features/logs/cspReporter.test.ts` → `describe("tauri.conf.json — the
Content-Security-Policy")`, which runs under `npm test`.

---

## 1. Why a CSP here at all

The webview can invoke **44 IPC commands** (`generate_handler!` in
`src-tauri/src/lib.rs`), including `terminal_write` — arbitrary bytes into a PTY
running the user's shell, i.e. *arbitrary local code execution by design* — plus
`http_send` / `ws_connect` / `grpc_send`, which reach arbitrary hosts by design.
So any script execution inside the webview is a full local compromise
with a built-in exfiltration channel.

There is **no known XSS today**. The only HTML sink is
`src/features/editor/MarkdownPreview.tsx`, and it is DOMPurify-gated with mermaid at
`securityLevel: "strict"`. This policy is therefore **defence in
depth**, not a fix for a live hole: it is what makes the *next* sink non-fatal, and
untrusted text flows into this app from repository files, terminal output, LSP server
responses, and HTTP/gRPC/WS response bodies from arbitrary hosts.

## 2. The policies, verbatim

**Production (`csp`):**

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; frame-src preview: http://preview.localhost; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

**Development (`devCsp`):**

```
default-src 'self' http://localhost:1420 http://127.0.0.1:1420; script-src 'self' 'unsafe-inline' http://localhost:1420 http://127.0.0.1:1420; style-src 'self' 'unsafe-inline' http://localhost:1420 http://127.0.0.1:1420; img-src 'self' data: https: http:; connect-src 'self' ipc: http://ipc.localhost http://localhost:1420 http://127.0.0.1:1420 ws://localhost:1420 ws://127.0.0.1:1420 ws://localhost:1421 ws://127.0.0.1:1421; object-src 'none'; frame-src preview: http://preview.localhost; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

Formatting is load-bearing: `Csp::Policy` → `HashMap` in `tauri-utils 2.9.3`
(`src/config.rs`) splits the string on `;`, trims, then splits on a **single space**.
A double space or a trailing `;` produces an empty directive/source token that lands
verbatim in the emitted header. A test asserts neither exists.

## 3. Per-directive justification (evidence, not taste)

### `default-src 'self'`
The base. In production the document origin is `tauri://localhost` (macOS/Linux) or
`http://tauri.localhost` (Windows), so `'self'` is the bundled `dist/`. Directives not
listed below (`font-src`, `media-src`, `worker-src`, `child-src`, `manifest-src`)
inherit it deliberately — and the evidence says they can:

```
grep -rn -E "@font-face|@import|url\(" --include='*.css' src/     → 0 hits
grep -rn -E "new Worker|createObjectURL" --include='*.ts' --include='*.tsx' src/  → 0 hits
grep -rn -E "<video|<audio|<iframe|<object|<embed|srcDoc" src/    → 0 hits (outside tests)
```

No web fonts, no workers, no blob URLs, no media elements of our own. A **remote
`<video>` inside a README** (raw HTML that DOMPurify permits) is therefore blocked —
a deliberate, narrow restriction, taken because remote video in a README is rare where
remote *images* are ubiquitous. The reporter (§5) is how we would find out.

### `script-src 'self'` — no `'unsafe-inline'`, no `'unsafe-eval'`, no `'wasm-unsafe-eval'`
Verified against the built bundle, which is the only honest place to check:

```
cd dist/assets
grep -l "new Function("        *.js  → (nothing)
grep -lE "[^a-zA-Z_.$]eval\("  *.js  → (nothing)
grep -l "new Worker"           *.js  → (nothing)
grep -l "WebAssembly"          *.js  → index-*.js, wasm-*.js, wit-*.js
```

The `WebAssembly` hits are **not** a requirement:
- `wasm-*.js` and `wit-*.js` are Shiki *TextMate grammars* for the WebAssembly and
  WIT languages — the string appears as a grammar name.
- the hits in `index-*.js` are Shiki's Oniguruma WASM **loader**
  (`WebAssembly.instantiate` / `instantiateStreaming`), reachable only from
  `createOnigurumaEngine`. `src/features/editor/shiki.ts:29` constructs
  `createJavaScriptRegexEngine({ forgiving: true })` instead — the deliberate
  choice of the JavaScript RegExp engine. The loader is dead code in the
  bundle, never invoked, so **`'wasm-unsafe-eval'` is confirmed not required**.

`dist/index.html` contains **no inline `<script>` and no inline `<style>`** — just an
external module script and an external stylesheet, both same-origin — so `'self'`
covers loading them.

Dev is the one place `'unsafe-inline'` appears on `script-src`, and it is not
negotiable there: `@vitejs/plugin-react` injects an inline module preamble
(`dist/index.js`, `preambleCode` → `import { injectIntoGlobalHook } …`) into the dev
HTML. It is confined to `devCsp` and never reaches the shipped policy — a test asserts
the production `script-src` is exactly `'self'` and that the shipped string contains
neither `localhost:1420` nor `ws://`.

### `style-src 'self' 'unsafe-inline'` — required, and this is the residual risk
Honest answer: **yes, `'unsafe-inline'` is needed.** Three independent runtime
style-injectors, plus React:

| Injector | Mechanism |
|---|---|
| CodeMirror 6 | `style-mod` → `doc.createElement("style")` + `sheet.insertRule` (`node_modules/style-mod/src/style-mod.js:100,120`) |
| xterm.js | one `createElement("style")` in `@xterm/xterm/lib/xterm.js` |
| mermaid | a `<style>` element inside every rendered SVG |
| React (ours) | inline `style` attributes — e.g. `App.tsx`'s `--left-col` / `--right-col` rail widths |

A nonce would be the correct alternative, but there is none available to us: Tauri only
mints nonces for `STYLE_NONCE_TOKEN`s already present in the HTML
(`tauri-utils/src/html2.rs` `inject_nonce_token`, which targets `<style>` elements), and
our `index.html` has none. CodeMirror's `EditorView.cspNonce` facet has nothing to be
given. Dropping `'unsafe-inline'` gives an **unstyled editor and terminal** — a white
screen, not a subtle regression.

**Residual risk, stated plainly.** `style-src 'unsafe-inline'` together with `img-src`
allowing remote hosts (below) is a CSS-only exfiltration primitive: an attacker who can
inject CSS — not script — can use attribute selectors plus `background: url(https://…)`
to leak the *values of input attributes*, and can overlay/restyle the UI for
clickjacking. The Vault panel (`src/features/api/VaultPanel.tsx`) is the interesting
target, since it holds secrets in text inputs. This is accepted because the alternative
is shipping a broken editor, and because reaching the primitive at all requires an
injection sink that does not currently exist (§1). It is the strongest argument for
keeping DOMPurify exactly where it is.

### `img-src 'self' data: https: http:` — remote images ALLOWED, deliberately
Three sources, each with a reason:
- `'self'` — any bundled asset.
- `data:` — **required.** `MarkdownPreview.tsx` inlines local images by calling
  `readImageDataUrl` (`src/features/workspace/workspaceIpc.ts:46` → the scoped Rust
  command `read_image_data_url`, `src-tauri/src/fs_tree.rs:258`), which returns
  `data:image/…;base64,…`. Without `data:` every local image in a README preview breaks.
- `https:` **and** `http:` — a deliberate choice, not an oversight. README badges
  (shields.io and friends) are remote images and are near-universal;
  `MarkdownPreview.tsx:211` explicitly leaves `^(?:https?|data|blob|asset|file):` srcs
  alone so they load directly. Blocking them would make previews differ from GitHub and
  VS Code — a real product regression that nobody would report as a *security* setting.
  `http:` is included as well as `https:` because restricting to `https:` stops
  cleartext but **not** exfiltration (both are outbound GETs to an attacker-chosen URL),
  so it would cost README fidelity for no meaningful security gain.

The residual risk is the pixel-tracking / URL-encoded-exfiltration channel described
above. Note it adds no *new capability class*: `http_send` already reaches arbitrary
hosts by design (an accepted risk of a built-in API client).

### `connect-src 'self' ipc: http://ipc.localhost` — get this wrong and the app is bricked
This is the directive with the sharpest teeth, because **Tauri v2's IPC is a real
`fetch()`**, not a native-only channel, and Tauri does **not** append the source itself.
From `tauri 2.11.5`'s injected `scripts/ipc-protocol.js`:

```js
fetch(window.__TAURI_INTERNALS__.convertFileSrc(cmd, 'ipc'), { method: 'POST', … })
```

and `scripts/core.js`'s `convertFileSrc`:

```js
return osName === 'windows' || osName === 'android'
  ? `${protocolScheme}://${protocol}.localhost/${path}`   // http://ipc.localhost/<cmd>
  : `${protocol}://localhost/${path}`                     // ipc://localhost/<cmd>
```

So: `ipc:` covers macOS and Linux, `http://ipc.localhost` covers Windows. Both are
listed so one policy is correct on all three platforms. **If `app.security.useHttpsScheme`
is ever enabled, `https://ipc.localhost` must be added here too.**

There is a fallback — on a fetch failure the script `console.warn`s *"IPC custom
protocol failed, Tauri will now use the postMessage interface instead"* and retries over
`window.ipc.postMessage`, which CSP does not govern — so a wrong `connect-src` degrades
rather than hard-bricks. It is not a safety net worth relying on: the fallback path
cannot carry raw request bodies the same way, and the warning is invisible in a packaged
build.

`'self'` is listed for completeness; nothing in `src/` calls `fetch`/`XMLHttpRequest`/
`WebSocket` directly (`grep` → 0 hits outside tests — the WebSocket console goes through
Rust via `ws_connect`).

### `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`
All four are `'none'` because nothing in the app uses them, and each closes a classic
escape hatch:
- `object-src` — DOMPurify's default allow-list excludes `<object>` and `<embed>`, and
  mermaid runs `securityLevel: "strict"`. Nothing should ever create one; `'none'` makes
  that a report instead of a surprise.
- `base-uri` — blocks a `<base href>` injection that would repoint every relative URL
  in the document (including the same-origin script chunk paths).
- `form-action` — the app has no submitting `<form>` (`grep -rn "<form" src/` → 0 hits
  outside tests), so a form navigation is only ever an attack.
- `frame-ancestors` — inert for a top-level webview, kept because it costs nothing and
  is the answer a reviewer expects.

### `frame-src preview: http://preview.localhost`
**This was `'none'` before the HTML preview existed.** It is the only
directive in this policy that has ever been widened, so it deserves its own section.

The HTML preview renders a repo's `.html` file — with its real CSS and its real JS — in
an `<iframe sandbox="allow-scripts">`. The frame's source is **our own** custom URI
scheme, served by `src-tauri/src/html_preview.rs`, whose every request goes through
`fs_tree::resolve_in_scope`: the same single enforcement point `read_file` uses. So this
is not a grant to the internet; it is a grant to one handler we wrote, and the scope
authority stays in Rust, at that one enforcement point.

Both platform spellings are listed for the same reason `connect-src` lists both IPC
spellings: macOS/iOS/Linux serve custom schemes as `preview://localhost/…`, Windows and
Android as `http://preview.localhost/…`.

**Why an iframe at all, when `'none'` was so much simpler.** Documents from a *local
scheme* (`about:srcdoc`, `blob:`, `data:`) inherit the embedder's policy container, CSP
included — so a `srcdoc` preview would inherit `script-src 'self'` and the previewed
page's inline scripts would be silently blocked. Running them would have required
`'unsafe-inline'` in **this** policy, which §"What must never be added back" forbids. A
custom scheme is not a local scheme, so the frame gets a policy of its own instead — and
that policy (`html_preview::PREVIEW_CSP`) is *tighter* than this one:
`connect-src 'none'`, no remote origin for anything, scheme-sources rather than `'self'`
(the sandboxed frame has an opaque origin, where `'self'` matches nothing).

🔴 **The one thing to keep true:** the value here must stay exactly these two sources.
A wildcard would let any page the app renders frame arbitrary remote content, which is
what `'none'` was protecting against. `cspReporter.test.ts` asserts the exact string and
that no `*`, no `https:` and no `'self'` appear.

### No `report-uri` / `report-to`
Intentionally absent. **This app must not phone home.** Violations are surfaced locally
instead (§5), and a test asserts neither token appears in either policy.

## 4. What Tauri does to the policy after we write it

Two behaviours worth knowing before debugging a header that does not match the string
above.

1. **`script-src` grows a sha256 hash per bundled JS file.** `tauri-codegen 2.6.3`'s
   `CspHashes::add_if_applicable` hashes **every `.js`/`.mjs`** asset, and
   `tauri::manager::set_csp` → `replace_csp_nonce` appends `'self'` plus all of them to
   `script-src` whenever a CSP is configured. Our `dist/assets/` currently holds **363**
   JS files (Shiki grammars + mermaid diagram chunks are code-split), so the emitted
   `Content-Security-Policy` response header will be roughly **19 KB**. That is Tauri's
   behaviour, not ours, and it does not change what is *allowed* (`'self'` is already
   there). It is on the verification list in §6 precisely because a 19 KB header is the
   kind of thing a WebView could truncate.
2. **In production the policy is an HTTP header, not a `<meta>` tag** — set on the
   `tauri://localhost` custom-protocol response (`tauri/src/protocol/tauri.rs:182`).
   `set_csp`'s own doc comment still says the value is written into the asset HTML on
   Linux; if any platform does deliver it as `<meta>`, `frame-ancestors` is ignored
   there (browsers ignore that directive in a meta tag) with a console warning and no
   violation event. Nothing else in the policy is meta-restricted, so the effect is
   cosmetic — but it is why `frame-ancestors` is listed as belt-and-braces rather than
   as a control we rely on.

**And the honest caveat about `devCsp`: on desktop `npm run tauri dev` it is not applied
at all.** `PROXY_DEV_SERVER` is `cfg!(all(dev, mobile))` (`tauri/src/manager/webview.rs:43`),
so on macOS/Windows/Linux dev the webview navigates straight to
`http://localhost:1420` and Vite — not Tauri — serves the HTML. Nothing injects a CSP.
`devCsp` therefore matters only on mobile/proxied dev and as documentation of intent.
**The only way to exercise this policy is a packaged (or `--debug`) build**, where
assets come through the `tauri://` protocol. `devCsp`'s HMR sources cover
`localhost`/`127.0.0.1` on the Vite port 1420 and the `TAURI_DEV_HOST` HMR port 1421
(`vite.config.ts`); a LAN `TAURI_DEV_HOST` IP is not enumerable in advance and would
have to be added by hand for mobile dev.

## 5. Making violations visible — `src/features/logs/cspReporter.ts`

A CSP that silently breaks a feature in a packaged build is **worse than no CSP**: the
failure mode is a blank pane, not an error, and there is no DevTools console in a
shipped app. Screenshot-based checks are not an option either: they would need an OS
screen-recording permission, and the app is designed to need no OS permission prompt.

So `startCspReporter()` adds a `securitypolicyviolation` listener on `document` and
appends one **WARN** line to the diagnostics log per report:

```
source:  csp
message: <effectiveDirective || violatedDirective || (unknown)> blocked <blockedURI || (unknown)>
detail:  at <sourceFile || (unknown)>:<lineNumber ?? 0>:<columnNumber ?? 0>[ — sample: <sample>]
```

e.g. `img-src blocked https://img.shields.io/badge/build-passing-green.svg` /
`at tauri://localhost/assets/index-Ycw85b_u.js:42:7`.

It is mounted **once**, from `src/App.tsx` (`useEffect(startCspReporter, [])`), returns
its own unsubscribe, and is a no-op where `document` is undefined. Open the Logs panel
(titlebar, or filter `source = csp`) and the blocked directive is on screen. This is
useful beyond CSP triage: it is the difference between "the preview is blank" and
"`img-src` blocked this URL".

## 6. Still to verify in a real packaged build

Neither the jsdom tier nor the browser tier applies this policy — `npm run test:browser`
boots Playwright Chromium against Vite, so it renders the real app with the real
stylesheet but under **no CSP at all**. It proves the app still renders; it proves
nothing about the directives. `npm run tauri dev` on desktop does not apply it either
(§4). So the following need a human with a `tauri build` (or `tauri build --debug`)
artifact:

1. **The app boots and the fleet/terminal work** — i.e. `connect-src` admits the IPC
   `fetch`. Symptom of failure: everything hangs, and the console (if reachable) shows
   *"IPC custom protocol failed, Tauri will now use the postMessage interface instead"*.
2. **A file opens in the editor with syntax colours** — CodeMirror + Shiki styles
   injected past `style-src`.
3. **A terminal renders** (xterm styles + WebGL renderer chunk under `script-src 'self'`).
4. **A Markdown preview with (a) a local image, (b) a remote badge, (c) a mermaid
   diagram** — `img-src data:`, `img-src https:`, and mermaid's inline SVG `<style>`.
5. **The Logs panel shows zero `source = csp` lines** during 1–4. Any line there is the
   finding; the directive to widen is printed in it.
6. **The ~19 KB `Content-Security-Policy` header is delivered intact** by WKWebView
   (macOS), WebView2 (Windows) and WebKitGTK (Linux) — see §4.1. A truncated header
   would fail *open* on some engines and *closed* on others, so this is worth an
   explicit look.
7. **Windows specifically** — `http://ipc.localhost` is the Windows IPC origin and only
   a Windows build exercises it.
8. **The reporter against a REAL violation.** jsdom has no
   `SecurityPolicyViolationEvent` constructor and enforces no CSP, so its tests dispatch
   a synthetic `Event` carrying the spec's field names. The names come from the spec /
   `lib.dom.d.ts`, not from an observed event. The cheapest real check: in a packaged
   build, open a Markdown file containing `<video src="https://example.com/x.mp4">`
   (blocked by §3's `default-src`) and confirm a `source = csp` WARN line naming
   `media-src`/`default-src` appears in the Logs panel.

## 7. If a directive turns out to be too narrow

Widen it in `src-tauri/tauri.conf.json`, add the *evidence* to §3 here, and extend the
guard in `cspReporter.test.ts`. The two things that must never be added back:
`'unsafe-eval'` / `'wasm-unsafe-eval'` in `script-src` (§3 proves nothing needs them),
and any external `report-uri`/`report-to`.
