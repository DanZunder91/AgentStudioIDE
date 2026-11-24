# Agent Studio — Testing Strategy

> **Status:** Authoritative. Details the project's testing standards and
> quality gates, within the terminal-renderer choice (WebGL first, DOM fallback).
> **Contract surface:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) §1 (channels),
> §2 (data model), §3 (Rust modules), §5 (fan-out), §6 (cross-platform).
>
> Every external fact here was verified against live sources
> (versions, platform support, API shapes). Every code snippet is either run
> against the installed packages or copied from the real source. The rules this
> strategy adds are summarized in **§10**.
>

---

## 0. The problem, stated precisely

A check that is not a **repo-resident test** — an ad-hoc store check, a one-off
browser script — may be real, but it is **throwaway scripting**: not re-runnable,
not in CI, not guarding anything.

The rule is not "write more tests". It is: **every check that is worth performing
becomes a file in the repo that runs on every push.** This doc says exactly where
each one lands.

Two facts shape everything below:

1. **The highest-risk logic in this product is also the most testable** — pure
   functions (pane-tree canonicalization, transcript parsing, language
   detection) and real fixtures. There is no excuse for these being untested.
2. **The highest-risk *integration* in this product is barely testable at all**
   — a real PTY's bytes reaching a real WebGL/DOM terminal inside a real
   WebView on three OSes. Pretending a test suite covers that is worse than
   admitting it doesn't. §4 draws that line honestly.

---

## 1. The pyramid for a Tauri app

Tauri is two runtimes bolted together. The pyramid is therefore **two pyramids
that meet at one seam** (§2). Layer sizes below are the target steady state at
M4, not a mandate to backfill.

| # | Layer | Runs via | Env | What lives here | What must **NOT** live here |
|---|---|---|---|---|---|
| 1 | **Rust unit** | `cargo test` (in-module `#[cfg(test)]`) | native | Coalescer batching, JSONL parse → `AgentEvent`, tree reduction, status inference, serde shapes, `default_shell`, path→project-dir mangling | Anything needing a real PTY or a `tauri::App` |
| 2 | **Rust integration** | `cargo test --test <name>` (`src-tauri/tests/`) | native, **real PTYs** | Spawn → write → read → resize → kill → EOF; reader-thread backpressure; EIO-as-EOF; tailer against **fixture** transcript dirs | Anything asserting on the UI; anything spawning real `claude` |
| 3 | **TS unit** | `vitest` (node env) | node | `canonicalize` + tree helpers (property-based), `detectLanguage`, `toBytes`, reducers as pure fns over `LayoutState` | DOM, xterm, `invoke` |
| 4 | **React component** | `vitest` (jsdom) + RTL | jsdom, **IPC mocked** | `<TabBar>`, `<PaneTree>`, `<AgentTree>` recursion + status roll-up, selection pivot, store↔component wiring | **Anything requiring layout or canvas** (see §7.5) |
| 5 | **Browser component** | `vitest --browser` (Playwright/chromium) | real browser, **IPC mocked** | `useTerminal` fit/resize, `TerminalRegistry` detach/reattach, renderer fallback selection, allotment drag math | Rust; the real app; WebView-specific behaviour |
| 6 | **E2E** | deferred — see §4 | real app | A single smoke path, when it earns its keep | Everything else |

**Deliberately not tested, at any layer:**

- **xterm.js, allotment, zustand, immer, CodeMirror, React.** We don't own them.
  Test *our* use of them, at the boundary where our code makes a decision.
- **`model.rs` derive output.** `#[derive(Serialize)]` works. What we test is
  that the **TS mirror agrees with it** (§2, wire-contract tests) — the derive
  is not the risk; the hand-written mirror is.
- **`main.rs` / `main.tsx` bootstrap.** Excluded from coverage (§5.4).
- **Tauri's IPC itself.** Mocking it (§3) means we test our side of the
  contract. The other side is covered by §2's wire tests + the §4 smoke path.

### Layer 5 is not optional, and it is the one people will try to skip

**xterm.js + `FitAddon` cannot be meaningfully tested in jsdom.** jsdom has no
layout engine and no canvas: `offsetWidth`/`getBoundingClientRect()` return `0`,
so `fit()` computes a degenerate size and every assertion is vacuously "green".
That is precisely the fit/resize bug class a real browser catches — and it is
undetectable at layers 3–4. Either we own a real-browser tier or we accept that
terminal sizing is untested. **We own it.**

Layer 5 provides that real browser in the repo, in CI. Vitest 4 runs it as a second *project* alongside jsdom — one runner,
one config, one `npm test`.

---

## 2. The seams where Rust ↔ JS meet

Four seams. Each gets a named owner and a test that fails when it drifts.

| Seam | Rust side | JS side | Failure mode if untested | Test |
|---|---|---|---|---|
| **A. Wire types** | `model.rs` serde (`rename_all="camelCase"`, enums snake_case) | `src/app/types.ts` (hand-mirrored) | Silent drift: Rust renames `last_activity_at`, TS still reads `lastActivityAt`, UI shows `undefined`. **Compiles green on both sides.** | Rust emits golden JSON per wire type → committed → TS test parses each against the TS type + asserts key set. §2.1 |
| **B. Command surface** | `#[tauri::command]` arg names | `ipc.ts` `invoke(...)` payload keys | Typo in an arg key → runtime "invalid args", never caught by `tsc` or `cargo` | Rust: command-name/arg-name inventory test. TS: `mockIPC` asserts exact `cmd` + payload keys. §3 |
| **C. Hot plane (`Channel`)** | `Channel<InvokeResponseBody>` sending `Raw(Vec<u8>)` | `Channel<ArrayBuffer>` → `toBytes()` → `xterm.write` | Frame arrives as number-array not ArrayBuffer (postMessage fallback) → `toBytes` mis-decodes → garbled terminal | `toBytes` unit table (all 3 shapes); Channel-driving mock (§3.2) incl. **out-of-order + end frames** |
| **D. Cold plane (events)** | `app.emit("agent://event", AgentEvent)` | `bridge.ts` `listen(...)` → reducers | Tag mismatch (`t: 'subagent_spawned'`) → reducer silently no-ops → **the headline feature shows nothing** | Golden `AgentEvent` JSON (seam A) fed through the real reducer; assert store shape |

Seam **A** is, on this architecture, the most likely source of a silent
production bug: ARCHITECTURE §2 declares the data model "THE contract" and then
**mirrors it by hand in two languages**. Without the golden test, nothing would
notice divergence.

### 2.1 Wire-contract test (seam A) — the pattern

```rust
// src-tauri/tests/wire_contract.rs  (shape shown for reference)
// One golden file per wire type. Regenerate with UPDATE_GOLDEN=1.
#[test]
fn agent_event_golden() {
    let ev = AgentEvent::SubagentSpawned {
        parent_id: "a1".into(), child_agent_id: "a2".into(),
        title: "Map analytics event ingestion".into(),
        cwd: "/work/proj".into(), branch: "main".into(), runtime: "claude-code".into(),
    };
    assert_golden("agent_event.subagent_spawned.json", &ev);
}
```

```ts
// src/app/types.wire.test.ts
import golden from "../../src-tauri/tests/golden/agent_event.subagent_spawned.json";

it("AgentEvent golden matches the TS mirror exactly", () => {
  const ev: AgentEvent = golden as AgentEvent;      // tsc: structural check
  expect(ev.t).toBe("subagent_spawned");
  // Key-set equality is the real assertion — tsc allows extra keys through a cast.
  expect(Object.keys(golden).sort()).toEqual(
    ["t", "parentId", "childAgentId", "title", "cwd", "branch", "runtime"].sort(),
  );
});
```

The golden file is the shared artifact. Rust writes it; TS reads it; CI runs
both. Drift on either side turns a green build red **in the same PR that causes
it**.

---

## 3. Mocking the IPC boundary

### 3.1 What exists (verified against the installed `@tauri-apps/api@2.11.1`)

`@tauri-apps/api/mocks` is real in v2 and exports exactly four functions:

| Export | Does | Note |
|---|---|---|
| `mockIPC(cb, { shouldMockEvents? })` | Replaces `window.__TAURI_INTERNALS__.{invoke, transformCallback, unregisterCallback, runCallback, callbacks}` | `shouldMockEvents: true` makes `listen`/`emit` work in-process |
| `mockWindows(label, ...)` | Injects `__TAURI_INTERNALS__.metadata` | Required before importing `api/window` or `api/webview` |
| `mockConvertFileSrc(os)` | Mocks `convertFileSrc` | Unused by us today |
| `clearMocks()` | Deletes the injected keys | **Must run in `afterEach`** — jsdom reuses `window` across tests in a file |

`emitTo` / `emit_filter` are **not** supported by the mock. We don't use them.

### 3.2 `Channel` — the tricky part

**There is no `mockChannel`.** Channel mocking is an open upstream request
([tauri#13753](https://github.com/tauri-apps/tauri/issues/13753), still open).
That does *not* mean channels are unmockable — it means you drive them yourself,
and the mechanism is fully exposed. From the real installed source:

```js
// node_modules/@tauri-apps/api/core.js — Channel ctor
this.id = transformCallback((rawMessage) => {
  const index = rawMessage.index;
  if ('end' in rawMessage) { /* ...cleanupCallback() */ return; }
  const message = rawMessage.message;
  if (index == nextMessageIndex) { onmessage(message); /* + drain pending */ }
  else { pendingMessages[index] = message; }     // out-of-order queueing
});
```

```js
// node_modules/@tauri-apps/api/mocks.js — what mockIPC installs
window.__TAURI_INTERNALS__.transformCallback = registerCallback; // -> numeric id
window.__TAURI_INTERNALS__.runCallback = runCallback;            // (id, data) => cb(data)
window.__TAURI_INTERNALS__.callbacks = callbacks;                // Map<id, cb>
```

Three consequences that dictate the pattern:

1. **`mockIPC()` must be called before any `new Channel()`.** The constructor
   calls `transformCallback` immediately; without the mock installed it throws.
   This is the #1 gotcha — it forces mock setup into `beforeEach`, not inline.
2. **The mock handler receives the *live Channel instance*, not a string.**
   `mockIPC`'s `invoke` is `cb(cmd, args)` with no serialization step, so
   `args.onOutput` is the object. (Under real IPC it serializes via
   `SERIALIZE_TO_IPC_FN` to `"__CHANNEL__:<id>"`.)
3. **Driving it via `runCallback(id, { index, message })` is the faithful path**
   — it is exactly what Rust does, so it exercises the ordering/`end` logic.
   Calling `channel.onmessage(bytes)` directly bypasses that and is a weaker test.

**The working pattern** (this exact code was executed against the installed
packages; output in the comments is real):

```ts
// src/test/channel.ts — the helper every Channel test uses.
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

/** Drives a Tauri Channel the way Rust does: ordered, indexed frames + an end frame. */
export class ChannelDriver {
  #index = 0;
  constructor(private readonly id: number) {}

  /** Send one coalesced frame (what `flush()` in coalesce.rs produces). */
  send(bytes: Uint8Array | ArrayBuffer): void {
    const message = bytes instanceof Uint8Array ? bytes.buffer : bytes;
    window.__TAURI_INTERNALS__.runCallback(this.id, { index: this.#index++, message });
  }
  /** Send a frame at an explicit index — for out-of-order tests. */
  sendAt(index: number, bytes: ArrayBuffer): void {
    window.__TAURI_INTERNALS__.runCallback(this.id, { index, message: bytes });
  }
  /** PTY closed: Rust's final end frame. Triggers cleanupCallback(). */
  end(): void {
    window.__TAURI_INTERNALS__.runCallback(this.id, { index: this.#index, end: true });
  }
  get closed(): boolean {
    return !window.__TAURI_INTERNALS__.callbacks.has(this.id);
  }
}

/** Install a fake `terminal_open` that captures the Channel and hands back a driver. */
export function mockTerminalIPC() {
  const drivers = new Map<string, ChannelDriver>();
  mockIPC((cmd, args: any) => {
    switch (cmd) {
      case "terminal_open":
        drivers.set(args.terminalId, new ChannelDriver(args.onOutput.id));
        return {
          id: args.terminalId, kind: "terminal", title: "sh", cwd: args.cwd,
          cols: args.cols, rows: args.rows, status: "live",
        };
      case "terminal_write":
      case "terminal_resize":
      case "terminal_close":
        return null;
      default:
        throw new Error(`unmocked command: ${cmd}`); // fail loudly, never silently
    }
  });
  return drivers;
}
```

```ts
// Usage — src/features/terminal/TerminalRegistry.test.ts
beforeEach(() => { drivers = mockTerminalIPC(); });  // BEFORE any `new Channel()`
afterEach(() => { clearMocks(); });

it("streams coalesced PTY frames into xterm, in order", async () => {
  await openTerminal({ terminalId: t1, cwd: "/work", rows: 24, cols: 80, onOutput: ch });
  const d = drivers.get(t1)!;
  d.send(new TextEncoder().encode("hello "));
  d.send(new TextEncoder().encode("world"));
  expect(written.join("")).toBe("hello world");
});

it("reorders frames that arrive out of order", () => {
  const d = drivers.get(t1)!;
  d.sendAt(0, enc("A")); d.sendAt(2, enc("C"));
  expect(written.join("")).toBe("A");            // C is held, not dropped
  d.sendAt(1, enc("B"));
  expect(written.join("")).toBe("ABC");          // released in order — verified
});

it("releases the callback when the PTY closes", () => {
  drivers.get(t1)!.end();
  expect(drivers.get(t1)!.closed).toBe(true);    // no leak — verified
});
```

> **Verified** against `@tauri-apps/api@2.11.1` in this repo:
> the mock handler receives the same `Channel` instance (`captured === ch`);
> `JSON.stringify(ch)` → `"__CHANNEL__:1411293630"`; frames sent at indices
> 0,1,3,2 emit as `hello |world|SECOND|THIRD`; the `end` frame unregisters the
> callback; `clearMocks()` removes `invoke`.

**Rule: `default:` in the mock throws.** A mock that returns `undefined` for an
unknown command turns a renamed command into a passing test. Seam B only holds
if unmocked commands are loud.

---

## 4. E2E — the hard question

### 4.1 What is actually true (verified)

The common premise — *"macOS is NOT supported"* — **was correct until ~May
2026 and is now out of date.** The situation changed twice this year.

| Provider | Windows | Linux | macOS | Cost | Maturity |
|---|---|---|---|---|---|
| **`tauri-driver`** (official, crates.io **2.0.6**, upd. 2026-05-06) | ✅ Edge Driver | ✅ WebKitWebDriver | ❌ **none** | free | mature |
| **Embedded** — `@wdio/tauri-service` + `tauri-plugin-wdio-webdriver` | ✅ | ✅ | ✅ **built-in** | free | **new** |
| **CrabNebula** fork of `tauri-driver` | ✅ | ✅ | ✅ | **paid key** for macOS | mature |

Tauri's own docs still state, verbatim: *"Driven directly, only Windows and Linux
are supported on desktop, as macOS has no WKWebView driver tool available."* That
sentence is about **`tauri-driver` specifically** and remains true. The docs now
*also* recommend WebdriverIO + `@wdio/tauri-service`, whose **embedded** provider
runs a WebDriver server *inside* your app (via the `tauri-plugin-wdio-webdriver`
Rust plugin, registered in debug builds) and therefore needs no OS driver — which
is how macOS is covered, free, no CrabNebula key.

Maturity, measured not asserted:

- `@wdio/tauri-service`: npm **1.2.0**, published **2026-06-25**; first release
  `1.0.0-next.0` **2025-12-28**; `1.0.0` **2026-05-03**; **8 versions total**;
  **33.5k downloads/month** (vs `webdriverio`'s 12.9M — i.e. ~0.26% attach rate).
- `tauri-plugin-wdio-webdriver`: crates.io **1.2.0**, 2026-06-25.

So: **~10 weeks past 1.0, single-digit releases.** Officially recommended, but
young.

### 4.2 The recommendation

> **Adopt layers 1–5 now. Do NOT build a WebDriver E2E tier for M1–M3. Revisit
> at M4 (`@wdio/tauri-service`, embedded provider, macOS + Ubuntu, one smoke
> spec).** Until then, "exercised end-to-end in the real running app" is
> satisfied by a **documented manual smoke checklist**, not automation.

**Why not now — the tradeoff, plainly stated:**

1. **The marginal coverage is small, and it is not where the risk is.** Layers 2
   and 5 already cover the real PTY and the real browser separately. E2E adds
   exactly one fact: *the Tauri IPC actually connects them.* That is a
   binary, one-time integration — it breaks loudly on first `tauri dev`, not
   subtly in production. Paying a WebDriver tier to guard a fact that a
   30-second manual launch establishes is a bad track **at this stage**.
2. **Terminals are the worst possible E2E target.** Under WebGL the terminal is
   a canvas — there is no DOM text to assert on, so `getText()` returns nothing.
   You would either force `setRendererPreference('dom')` for tests (**testing a
   renderer path the user never runs on macOS/Windows** — the renderer chain makes DOM the
   *Linux fallback*, not the norm) or assert via `@xterm/addon-serialize` through
   `browser.execute`, which is layer 5 with 100× the setup. Both are worse than
   what §7.3 already gives us.
3. **The embedded provider changes the binary under test.** It requires a Rust
   plugin registered in debug builds. So the artifact you E2E is *not* the
   artifact you ship — which quietly voids the main reason to run E2E at all.
4. **It is young.** 8 releases, 10 weeks past 1.0, 0.26% attach rate. Betting
   M1's acceptance on it means debugging *it* instead of our product.
5. **Cost is real.** A full `tauri build` (Rust link + bundle) is minutes per OS
   — §9 puts it on nightly precisely because it's too slow per-push. E2E inherits
   that cost *and* WebDriver flake.

**Why revisit at M4, not never:** once the shell stops moving, one smoke spec —
*app boots → 3-pane shell paints → new terminal → `echo hi` → "hi" appears* —
becomes cheap to keep green and catches the packaging/capability regressions
(`capabilities/default.json`, plugin wiring) that nothing else covers. That is a
real gap; it is just not M1's gap.

**Explicitly rejected: Playwright against the Vite dev server, called "E2E".**
Not because it's useless — it is layer 5 and we're adopting it — but because
**calling it E2E is the lie that lets the real gap go unnoticed**. It runs
Chromium against mocked IPC. It contains zero Rust, zero WebView, zero PTY. It
is a component tier. Name it that.

**Also rejected: `tauri-driver` on Linux CI only.** It would test WebKitGTK+DOM
— a real risk surface given the DOM fallback — but on the *one* platform we don't develop
on, so failures land far from the author, and it still can't assert on terminal
content (point 2). The Linux renderer risk is a **benchmark/perf** question, and
ARCHITECTURE §6 already assigns it to the **M1 Linux/NVIDIA gate**. A pass/fail
E2E does not answer "is the DOM renderer fast enough for a fleet". Don't
conflate them.

### 4.3 What replaces automated E2E until M4

A numbered manual smoke checklist, run per milestone on macOS
(and on the Linux box at the §6 gate), pasted into the milestone's PR:

```
M1 smoke (macOS):
 1. `npm run tauri dev` → native window, 3-pane dark shell
 2. New terminal → prompt appears within 1s
 3. `ls -R /usr/include | head -5000` → no jank, no dropped output, scrollback intact
 4. Resize window → reflow correct, no truncation      ← the fit/resize bug class
 5. Split H, split V → both terminals live and independently resizable
 6. Close tab → process exits (verify: `pgrep -f <shell>` count drops)
 7. Renderer: DevTools console → confirm WebGL selected (WebGL → DOM chain)
```

This is a **downgrade in rigor from automation and it is deliberate.** It is
honest about being manual, it is versioned, and it is written down and required.

---

## 5. Coverage

### 5.1 Frontend — `@vitest/coverage-v8`

Two Vitest 4 behaviours drive this config:

- **`coverage.include` defaults to *"files imported during the test run"*.**
  Left alone, **a source file with no test is simply absent from the report**,
  so coverage *rises* when you add untested code. That is a metric that rewards
  the exact behaviour we're trying to stop. **Set `include` explicitly** so
  untested files count as 0%.
- **`coverage.exclude` defaults to `[]`.** Nothing is excluded for free.

```ts
// vitest.config.ts — the coverage block spec.
coverage: {
  provider: "v8",
  reporter: ["text-summary", "html", "json-summary", "lcov"],
  include: ["src/**/*.{ts,tsx}"],          // honest denominator: untested file = 0%
  exclude: [
    "src/**/*.test.{ts,tsx}",
    "src/**/*.d.ts",
    "src/vite-env.d.ts",
    "src/main.tsx",                        // bootstrap: no logic
    "src/test/**",                         // helpers (ChannelDriver, setup)
    "src/assets/**",
    "src/components/icons.tsx",            // static SVG data
  ],
  thresholds: {
    autoUpdate: !process.env.CI,           // the ratchet — see §5.3
    lines: 0, functions: 0, branches: 0, statements: 0,  // seeded on first green run
  },
}
```

> **Scratchpad harnesses are deleted, not excluded.** A probe page driven by
> hand is exactly the kind of check layer 5 replaces. **Excluding scaffold is a
> stopgap; deleting it is the fix.**

### 5.2 Rust — `cargo-llvm-cov`, not `tarpaulin`

**Recommendation: `cargo-llvm-cov`** (crates.io **0.8.7**; 6.58M downloads).
Reasons, in priority order:

1. **Tarpaulin cannot cover this codebase's most important tests.** Its LLVM
   engine — the **default on macOS and Windows** — states plainly that it
   **"cannot handle fork syscalls properly"**. Our PTY layer *is* `forkpty`
   (§7.4, ARCHITECTURE §3). The single highest-value Rust integration suite is
   the one tarpaulin is documented to mishandle on our dev platform. That alone
   decides it.
2. **Tarpaulin's accurate engine is Linux-only.** Its default ptrace backend
   *"will only work on x86_64 processors"* — not macOS, and not arm64. Our primary
   dev platform is macOS. We'd get the fork-broken LLVM engine locally
   and a different engine in CI: **two coverage numbers, one ratchet.**
3. **Further tarpaulin LLVM caveats hit us directly:** *"if a test has a
   non-zero exit code coverage data isn't returned"*, plus documented thread
   safety issues. Our PTY tests are thread-heavy by construction (blocking
   reader thread per terminal) and `#[should_panic]`/`--no-fail-fast` are
   incompatible.
4. `cargo-llvm-cov` uses the compiler's own `-C instrument-coverage`: same
   engine, same numbers on macOS · Linux · Windows. One ratchet, three OSes.

Tarpaulin is a fine tool; it is the wrong tool **for a PTY-forking,
thread-heavy, macOS-developed crate.**

```bash
cargo llvm-cov --all-features --workspace \
  --ignore-filename-regex '(src-tauri/gen/|src-tauri/tests/|/main\.rs$)' \
  --lcov --output-path lcov.info
```

Rust exclusions: `src-tauri/gen/**` (generated — `gen/schemas/` exists today),
`src-tauri/tests/**` (the tests themselves), `main.rs` (bootstrap + the §6 Linux
env workarounds, which are `#[cfg]`-gated and unreachable on the measuring host).

### 5.3 Ratcheting policy

**Thresholds are set at the level currently achieved, and only ever rise.**

| | Mechanism |
|---|---|
| **Frontend** | `thresholds.autoUpdate: !process.env.CI`. Vitest *"update[s] all threshold values … when current coverage is better"* — it rewrites `vitest.config.ts` in place. Locally: run tests, config self-raises, **commit the bump with the PR**. In CI: `autoUpdate` off → thresholds enforced as written → a drop fails the build. |
| **Rust** | No built-in ratchet. `cargo llvm-cov --fail-under-lines $(cat .coverage-floor)`, with `.coverage-floor` committed. A `ratchet` CI step recomputes and fails if the achieved figure exceeds the floor by **>2 points** — forcing the floor up, so slack can't accumulate. |

Rules:

1. **Lowering a threshold requires a written, committed decision.** Not a
   comment, not a PR description. This is the whole mechanism; if it can be edited casually it is
   decorative.
2. **Never `autoUpdate` in CI.** It would rewrite config on a throwaway
   checkout — harmless but masks the intent, and makes the tree dirty.
   (It cannot *hide* a regression — it only raises — but the failure mode should
   be a red build, not a silent write.)
3. **Per-area, not one global number.** A single repo-wide % is gameable: 200
   lines of trivially-covered icon data offsets an untested parser. Use Vitest's
   per-glob thresholds so `store.ts` and the M3 parser carry their own floors.
4. **The ratchet starts at M1's real number, whatever it is.** Do not seed it
   aspirationally — a threshold that's red on day one gets disabled on day two.

### 5.4 Realistic targets

Per-layer, at M4. **These are floors to ratchet toward, not vanity numbers.**

| Area | Target (lines) | Why not higher |
|---|---|---|
| `src/app/store.ts` tree helpers + reducers | **95%** | Pure, property-tested. The one place near-total coverage is honest. |
| `src/lib/language/` (`detectLanguage`, M4) | **95%** | Total function, table-driven. |
| `agent/claude.rs` parser (M3) | **90%** | Fixture-driven; error branches for malformed JSONL are reachable. |
| `stream/coalesce.rs` | **90%** | Small, virtual-time testable. Channel-dropped branch is awkward. |
| `src/app/ipc.ts`, `bridge.ts` | **85%** | Thin wrappers; mocked IPC reaches nearly all of it. |
| `supervisor/` | **70%** | Actor loop; some error arms need real OS failures to reach. |
| `pty/` | **65%** | `#[cfg(windows)]`/`#[cfg(unix)]` arms are *structurally unreachable* on any single host — the ceiling is the sum of one platform's arms. |
| React components | **60–70%** | Beyond this you test React, not intent. |
| `TerminalRegistry` / `useTerminal` | **60%** | Real coverage lives in layer 5, which v8 coverage doesn't merge in by default. |
| **Repo-wide floor** | **frontend 70% · Rust 65%** | Honest for an app whose riskiest surface is OS/WebView integration. |

**We do not propose 100%, or 90% global.** On a codebase this
integration-heavy, a high global number can only be bought by testing trivia
(icon maps, derives, getters) — which *dilutes* the signal. The numbers above
are deliberately uneven: **high where logic is pure, low where the OS is.**

---

## 6. Property-based testing: pane-tree canonicalization

`canonicalize()` (`src/app/store.ts`) is the single best property-test target in
the repo: **pure, total, invariant-rich, runs after every layout mutation, and
its failures are silent** — a mis-canonicalized tree doesn't throw, it renders
subtly wrong (a pane that won't die, a divider that drifts). Example-based tests
find the cases you thought of; the bugs here are in the ones you didn't.

### 6.1 The invariants

Derived from the doc comment in `store.ts` (rules a–e) + ARCHITECTURE §4.

| # | Invariant | Property |
|---|---|---|
| 1 | **Sizes sum to 1** | `∀ split ∈ out: |Σ split.sizes − 1| < 1e-4` |
| 2 | **Sizes align with children** | `∀ split: split.sizes.length === split.children.length`, all `> 0` |
| 3 | **No single-child splits** | `∀ split ∈ out: split.children.length ≥ 2` |
| 4 | **No same-orientation nesting** | `∀ split, ∀ child ∈ split.children: !(child.type==='split' && child.orientation===split.orientation)` |
| 5 | **Last leaf survives** | `leavesOf(out).length ≥ 1` — *for every input, including a fully-pruned one* |
| 6 | **Idempotence** | `canonicalize(canonicalize(t, p), p) ≡ canonicalize(t, p)` |
| 7 | **No input mutation** | `structuredClone(t)` before; deep-equal after |
| 8 | **Leaf preservation** | Every non-pruned leaf id in `t` appears in `out` exactly once — *canonicalize must not lose or duplicate a pane* |
| 9 | **Tab conservation** | Multiset of all `tabIds` is unchanged (pruned leaves are empty by definition) |
| 10 | **Visual order preserved** | `leavesOf(out)` is a subsequence of `leavesOf(t)` — flattening must not reorder panes |
| 11 | **Share preservation** | For a same-orientation flatten, a grandchild's final share ≈ `parentShare × innerShare` (the "visual layout is stable" claim in the code comment) |
| 12 | **Prune is opt-in** | An empty leaf **not** in `prune` survives (guards the `splitPane` placeholder) |

Invariants **8–12** go beyond the basic structural list. 10 and 11 are where a flattening
bug actually hides: rules 1–5 stay green while panes silently reorder or jump
size. 12 pins the subtle design decision the code comment calls out by name.

### 6.2 The generator is the hard part

```ts
// src/app/store.property.test.ts
import fc from "fast-check";

/** Arbitrary PaneNode trees — including the degenerate shapes canonicalize exists to fix. */
const paneTree = (): fc.Arbitrary<PaneNode> =>
  fc.letrec((tie) => ({
    leaf: fc.record({
      id: paneId(), type: fc.constant("leaf" as const),
      tabIds: fc.uniqueArray(tabId(), { maxLength: 3 }),
      activeTabId: fc.constant(null),
    }).map((l) => ({ ...l, activeTabId: l.tabIds[0] ?? null })),

    // Deliberately generates what canonicalize must repair:
    //  - single-child splits            (rule a)
    //  - same-orientation nesting       (rule b)
    //  - sizes that don't sum to 1      (rule d)
    //  - empty leaves                   (rule c)
    split: fc.record({
      id: paneId(), type: fc.constant("split" as const),
      orientation: fc.constantFrom("row" as const, "column" as const),
      children: fc.array(tie("node") as fc.Arbitrary<PaneNode>, { minLength: 1, maxLength: 3 }),
    }).chain((s) =>
      fc.array(fc.double({ min: 0.01, max: 100, noNaN: true }),
               { minLength: s.children.length, maxLength: s.children.length })
        .map((sizes) => ({ ...s, sizes })),
    ),
    node: fc.oneof({ depthSize: "small", withCrossShrink: true },
                   tie("leaf"), tie("split")) as fc.Arbitrary<PaneNode>,
  })).node;

it("canonicalize upholds every structural invariant", () => {
  fc.assert(fc.property(paneTree(), fc.array(paneId()), (tree, pruneIds) => {
    const prune = new Set(pruneIds);
    const before = structuredClone(tree);
    const out = canonicalize(tree, prune);

    expect(tree).toEqual(before);                                  // 7: no mutation
    expect(leavesOf(out).length).toBeGreaterThanOrEqual(1);        // 5: last leaf
    for (const s of splitsOf(out)) {
      expect(s.children.length).toBeGreaterThanOrEqual(2);         // 3
      expect(s.sizes.length).toBe(s.children.length);              // 2
      expect(sum(s.sizes)).toBeCloseTo(1, 4);                      // 1
      for (const c of s.children)
        expect(c.type === "split" && c.orientation === s.orientation).toBe(false); // 4
    }
    expect(canonicalize(out, prune)).toEqual(out);                 // 6: idempotent
  }), { numRuns: 500 });
});
```

**Uniqueness caveat:** ids must be unique across the tree or invariants 8/10 are
meaningless. Generate ids from a counter (or post-process to relabel) rather than
`fc.uuid()` per node — fast-check will happily produce colliding ids and you'll
debug the generator, not the code. This is the one part of this file worth
getting right before writing the properties.

**Seed policy:** let fast-check pick, but **commit any counterexample it finds as
a named example-based regression test** (with a comment citing the seed).
Property tests find bugs; example tests keep them dead.

---

## 7. The highest-value tests for this product

### 7.1 The M3 transcript fan-out parser

This is **the single highest-value test in the product**, and the transcript
format it reads is easy to get wrong. Everything below was verified against a
large local corpus of real transcripts in `~/.claude/projects/`.

#### Plausible assumptions vs real data

| Plausible assumption | Real data (verified) | Impact |
|---|---|---|
| Spawn = `tool_use` `{ name: 'TaskCreate', input: { agent: 'Explore' } }` | **False.** Spawn is `{ name: **'Agent'**, input: { **description**, **subagent_type**, prompt, run_in_background? } }` — **hundreds of occurrences**. | A parser built on the assumption detects **0 spawns**. |
| — | **`TaskCreate` is a different tool entirely** — a to-do item: `{ subject, description, activeForm }`, **dozens of occurrences, no agent involved**. Both tools coexist at the current CLI version (2.1.212). | Matching `TaskCreate` yields **one false-positive agent per to-do**. |
| *"Linkage is by directory structure + session/agent ids"*; *"there is no explicit parent-uuid field"* | **False, twice.** (a) There **is** an explicit link: the spawning tool's result line carries `toolUseResult.agentId` — the child's id. (b) Directory structure encodes **nothing** about depth: **every descendant, at every depth, lands in the same flat `<session>/subagents/` dir.** | Directory-based linkage produces a **flat list of siblings — not a tree.** The headline feature would render wrong. |
| Sub-agents are leaf telemetry nodes (§9, "v1 sub-agents are read-only") | **Sub-agents spawn sub-agents.** In one sampled session of about twenty agents, **more than half were spawned by other sub-agents** (`spawnDepth: 2`), and many sub-agent transcripts contain `Agent` tool_use calls. | Recursion is **real, common, and load-bearing** — not hypothetical. |
| (not mentioned) | **`.meta.json` sidecars exist** — hundreds of them: `{ agentType, description, toolUseId, spawnDepth?, parentAgentId? }`. | A **far cleaner** source for title/type/depth than parsing JSONL. |

**The real linkage, verified end-to-end.** Two independent derivations:

```
A) Spawner's transcript:
   assistant line, uuid=U:  content[] ∋ { type:'tool_use', id:T, name:'Agent',
                                          input:{ description, subagent_type, prompt } }
   user line, parentUuid=U, sourceToolAssistantUUID=U:
        toolUseResult: { isAsync, status:'async_launched'|'completed',
                         agentId: C, description, resolvedModel, outputFile }
   ⇒ edge (owner-of-this-file) → C,  title = description

B) Child's sidecar  subagents/agent-C.meta.json:
        { agentType:'Explore', description, toolUseId: T, spawnDepth: 2 }
   ⇒ find the file containing tool_use id T ⇒ that file's agent is the parent.
```

Both were run over a real multi-level session: **every edge resolved, none
unresolved, and the reconstructed tree matches `spawnDepth` exactly** (root's
children `spawnDepth:1`, grandchildren `spawnDepth:2`):

```
└─ a00000001 d=1 'Reuse the rate limiter & helpers'
  └─ a00000002 d=2 'Map base URL config + env files'
  └─ a00000003 d=2 'Map the service apps + shared code …'
└─ a00000004 d=1 'Trace the request logging flow'
  └─ a00000005 d=2 'Analyze todo-service storage laye…'
  └─ a00000006 d=2 'Analyze auth-service HTTP clients'
  └─ a00000007 d=2 'Analyze mail-service cache storag…'
…
```

That A and B agree is itself a **property test**: derive the edge set both ways;
assert equality. When Claude Code's format shifts, one derivation breaks first
and the test names the drift instead of the tree silently flattening.

**Robustness ranking** (from the real distribution — this is what the parser
should prefer, in order):

| Source | Present | Use |
|---|---|---|
| `toolUseResult.agentId` (A) | every spawn result | **Primary** edge |
| `.meta.json` `toolUseId` (B) | nearly every sidecar | **Cross-check** edge |
| `.meta.json` `agentType` | every sidecar | `AgentNode.title` prefix / kind |
| `.meta.json` `spawnDepth` | **~70% of sidecars** | **Assertion only — never a source.** Absent on older versions. |
| `.meta.json` `parentAgentId` | **a few percent** | **Ignore.** Too rare to depend on. |

`toolUseResult.status` is `async_launched` or `completed`, in roughly equal
shares — **both are spawns**; `run_in_background: true` correlates with the async
form. A parser keying only on one status misses roughly half of the agents.

> **The parsing rules that follow from these findings are ARCHITECTURE §5.2.**
> This is also the strongest possible argument for fixture-first testing:
> *checking the format against real data before writing the parser is what
> exposes assumptions like these.*

#### Fixture strategy — capture, reduce, verify

**The privacy problem is real, not theoretical.** A real local corpus routinely
contains `/Users/<name>` home paths (on almost every line), IP addresses, email
addresses, `export *KEY/TOKEN/SECRET/PASS=` lines, DB connection strings
(`postgres://`…) and JWTs (`eyJ…`).

Plus the part no regex catches: **prompts and tool results are free-form
narrative about private codebases.**

**Therefore: do not "sanitize". Reduce.** Scrubbing is a denylist over
adversarial free text — it fails open, silently, forever. Instead:

> **Allowlist projection.** The fixture keeps *only* the keys the parser reads,
> and **every free-text value is dropped or replaced with a synthetic one.**
> Fails **closed**: a field nobody allowlisted cannot leak, including fields
> Anthropic adds next month.

This works because of a happy structural fact: **the parser never reads prose.**
It reads `type`, `isSidechain`, `agentId`, tool *names*, `subagent_type`,
`status`, `timestamp`, and ids. `prompt`, message text, and tool-result bodies —
100% of the risk — are **never consumed**. Dropping them costs the fixture
nothing.

```
scripts/fixtures/capture-transcript.mjs     # repo-resident + re-runnable (NOT scratchpad)
src-tauri/tests/fixtures/transcripts/
  recursive-fanout/                         # 22 agents, depth 2 — the headline case
    session.jsonl
    subagents/agent-<pseudo>.jsonl
    subagents/agent-<pseudo>.meta.json
    expected.json                           # the AgentNode forest the parser must produce
  flat-fanout/                              # depth 1 only
  taskcreate-decoy/                         # TaskCreate to-dos — parser must yield 0 agents
  version-drift/                            # meta.json without spawnDepth (older CLI)
  malformed/                                # truncated last line (tailing a live file)
```

**The projection, field by field:**

| Field | Action | Why |
|---|---|---|
| `type`, `isSidechain`, `userType`, `entrypoint` | **keep verbatim** | Structural enums; no content |
| `version` | **keep verbatim** | Version-drift tests need it (`2.1.170`…`2.1.212`) |
| tool `name`, `input.subagent_type`, `input.run_in_background`, `toolUseResult.status`, `.isAsync`, `.resolvedModel` | **keep verbatim** | The parser's actual inputs |
| `uuid`, `parentUuid`, `sourceToolAssistantUUID`, `sessionId`, tool_use `id` | **remap** — stable pseudonym, referential integrity preserved | Tree shape must survive; the values are random anyway |
| `agentId` (line, `toolUseResult`, filename) | **remap** consistently across files+filenames | Same |
| `timestamp` | **rebase** to a fixed epoch, **preserving deltas** | Status inference is time-based (*"last msg < 30s ⇒ running"*, §5.2). Deltas are the test. |
| `cwd`, `outputFile` | **replace** → `/work/<proj>` | Home paths on almost every line |
| `gitBranch` | **replace** → `main` / `feature-1` | Branch names leak project/ticket names |
| `slug` | **drop** | Not read |
| `description` (tool input, `toolUseResult`, `.meta.json`) | **replace** → deterministic synthetic (`"Task 3"`), mapping stable so `expected.json` can assert titles | **It is the UI title, so its *plumbing* must be tested — its *content* must not be committed.** |
| `input.prompt`, `toolUseResult.prompt` | **drop** | Pure risk, zero parser value |
| `message.content[]` `text` bodies | **drop**, keep `{type:'text'}` | Structure matters, prose doesn't |
| `toolUseResult` for non-`Agent` tools | **drop whole key** | Bash output, file contents — max risk, zero value |
| **anything not listed** | **dropped** | Fail-closed |

**Sanitization is enforced by a test, not by trust:**

```ts
// src-tauri/tests/fixtures/no_secrets.rs  (or a TS equivalent — one of the two, not both)
// Fails the build if any committed fixture contains a real-world identifier.
const FORBIDDEN: &[(&str, &str)] = &[
    ("home path",  r"/Users/[a-zA-Z0-9._-]+"),
    ("jwt",        r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\."),
    ("aws key",    r"AKIA[0-9A-Z]{16}"),
    ("gh token",   r"gh[pousr]_[A-Za-z0-9]{20,}"),
    ("anthropic",  r"sk-ant-[A-Za-z0-9_\-]{20,}"),
    ("email",      r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    ("conn str",   r"(?i)(postgres|mysql|mongodb|redis)://"),
    ("secret kv",  r"(?i)(password|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}"),
    ("prompt key", r#""prompt""#),          // the allowlist must have dropped it
];
// walk src-tauri/tests/fixtures/**, assert zero matches.
```

This is a **belt-and-braces check, not the mechanism** — the allowlist is what
makes fixtures safe; this test is what makes that *provable* on every push, and
catches a careless hand-added fixture.

**Capture is a committed script, re-runnable by anyone** with a
`~/.claude/projects/`, so fixtures can be refreshed when the CLI format moves —
that is the re-runnable-tests rule applied to fixtures themselves.

```bash
node scripts/fixtures/capture-transcript.mjs \
  --session ~/.claude/projects/-Users-.../0000ffff-….jsonl \
  --out src-tauri/tests/fixtures/transcripts/recursive-fanout \
  --max-lines 400          # truncate: a source parent can be MBs; the fixture stays ~40KB
```

#### What the M3 tests assert

| Test | Asserts |
|---|---|
| `parses_recursive_fanout` | 22 nodes, correct `parentId` edges, depth-2 nesting — vs `expected.json` |
| `edge_derivations_agree` | Derivation A (`toolUseResult.agentId`) ≡ derivation B (`meta.toolUseId`) |
| `depth_matches_spawn_depth` | Reconstructed depth == `meta.spawnDepth` wherever present |
| `taskcreate_is_not_a_spawn` | The decoy fixture yields **0** agents ← *the TaskCreate-as-spawn mistake* |
| `both_spawn_statuses_detected` | `async_launched` **and** `completed` both produce nodes |
| `handles_truncated_final_line` | A half-written last line (live tailing) → no panic, no partial node |
| `resumes_from_offset` | Re-parsing from a saved byte offset yields only the new nodes |
| `unknown_tool_is_ignored` | An invented tool name → no node, no panic (forward-compat) |
| `title_comes_from_description` | `AgentNode.title` == `input.description` |
| `emits_subagent_spawned` | Each edge → one `AgentEvent::SubagentSpawned` with the right `parentId` |

### 7.2 The coalescer (`stream/coalesce.rs`)

Small, pure-ish, and on the hot path — ARCHITECTURE §9 calls binary-safe
high-throughput streaming *"the one thing to get exactly right."*

**Test with `tokio::time::pause()` — never `sleep`.** (`tokio` `test-util` is
already in `[dev-dependencies]` for exactly this.)

| Test | Asserts |
|---|---|
| `flushes_on_size_trigger` | 32KB in one shot → flush **before** any tick advances |
| `flushes_on_time_trigger` | 1 byte + `advance(8ms)` → exactly one flush |
| `coalesces_many_small_writes` | 1000×1 byte within 8ms → **one** `send`, bytes concatenated in order |
| `is_binary_safe` | Bytes split mid-UTF-8 across chunks reassemble **byte-identical** (never `String`) |
| `final_flush_on_eof` | Sender dropped with pending bytes → flushed, then returns |
| `stops_when_channel_closed` | `send` fails → `pump_to_ui` returns (no spin) |
| `no_empty_flushes` | Ticks with an empty buffer → zero sends |

Byte-identity is the assertion that matters: it is the only thing standing
between a fleet of terminals and mojibake.

### 7.3 PTY lifecycle (`src-tauri/tests/`, real PTYs)

Real PTYs, no mocks — the OS *is* the thing under test.

| Test | Asserts | Platform note |
|---|---|---|
| `spawn_echo_roundtrip` | `echo hi` → bytes contain `hi` | all |
| `write_reaches_child` | `cat` + write → echoed back | all |
| `resize_signals_child` | resize → `stty size` reports new dims | Unix (ConPTY differs) |
| `exit_yields_eof` | child exits → reader thread ends, rx closes | **Linux: EIO must be EOF, not error** |
| `kill_while_waiting` | `clone_killer()` kills a blocked `wait()` | all |
| `slave_dropped_after_spawn` | master sees EOF (regression: forgetting this hangs forever) | all |
| `backpressure_parks_reader` | Firehose + undrained rx → bounded at 256, no unbounded growth | all |
| `close_reaps_child` | `terminal_close` → no zombie | Unix |

**Never assert on shell prompts or timing.** Read in a bounded loop with a
deadline until the expected bytes appear, then assert. Sleeping is how PTY suites
become flaky suites.

**Windows/ConPTY:** ARCHITECTURE §6 flags that ConPTY injects its own
resize/repaint sequences and handles newlines differently. Windows PTY tests
therefore assert **"contains expected bytes"**, never exact stream equality —
and `resize_signals_child` is `#[cfg(unix)]`.

### 7.4 `detectLanguage` (M4)

Table-driven, ~50 rows, one `it.each`. Total function → **every case is a row**:
filename-first (`Dockerfile`, `Makefile`, `.gitignore`), extension
(`.cpp`/`.kt`/`.zig` — required by the multi-language editor), shebang
(`#!/usr/bin/env python3`), case-insensitivity (`.CPP`), multi-dot
(`foo.test.tsx`), unknown → `plaintext`, and **empty/dotfile/no-extension** →
`plaintext` (never throws). Property: **total** — `fc.string()` never throws and
always returns a member of `LanguageId`.

### 7.5 Terminal integration (layer 5 — browser)

The real-browser tests:

| Test | Why it must be a real browser |
|---|---|
| `fit_computes_correct_dims` | Needs real layout + font metrics. **jsdom returns 0** → vacuously green. |
| `resize_reflows_and_notifies_rust` | `ResizeObserver` + real box sizing; asserts debounced `terminal_resize` payload |
| `detach_preserves_scrollback` | `display:none` then reattach → scrollback/cursor survive (ARCHITECTURE §4) |
| `renderer_falls_back_webgl_to_dom` | Feature detection needs a real WebGL context |
| `dispose_releases_instance` | No leak in `TerminalRegistry` across open/close cycles |

**Caveat, stated up front:** Playwright's `webkit` is **not** WKWebView and
**not** WebKitGTK — it's a separate build. Layer 5 tells us *our code* is
correct; it says **nothing** about WebView-specific behaviour. Only the §6
Linux gate and manual smoke cover that. Chromium is therefore the right (and
only) layer-5 target: it's the fast, stable one, and the extra engines would
buy false confidence, not coverage.

### 7.6 The gazelle-like scenario — a realistic workflow as the gate

Unit tests, browser tests and the real-service E2E can all be green while Network and Logs are
broken for a common workflow that none of them runs: a realistic Rust service (reqwest + rustls
with **webpki-roots**, HTTP on `:3000`, HTTPS out to an upstream API) in one IDE terminal, and a
Claude agent in another calling it with `curl --noproxy '*'` and `NO_PROXY='*' python3`. This
scenario re-creates that workflow, permanently, in the real app:

| Piece | What it is |
|---|---|
| `e2e/fixtures/gazelle-like/` | Its own Cargo project (not in a workspace): tiny_http on `127.0.0.1:3000`, reqwest `default-features = false, ["rustls-tls-webpki-roots", "json", "blocking"]` — the trust model of a typical rustls service (never the OS store, `SSL_CERT_FILE` or the IDE's CA). `GET /health`, `GET /shipping/rates?zone=` (one outbound HTTPS GET, then 200 / 502), an upstream call at startup and every 30 s, tracing-style lines to stdout **and** `./gazelle-like.log`. No idle pool: each call is one tunnel that closes. Built by `scripts/e2e-linux.mjs` into the E2E target volume (`target/fixtures`, no debuginfo) whenever a `gazelle-like` spec is selected. |
| `e2e/fixtures/fake-agent.sh` | The agent. No real Claude, no account: the E2E's stub `claude` (`claude-stub.sh`) `exec`s it when the spec writes the trigger `$TMPDIR/agentstudio-e2e-agent.sh`, so it runs in a real IDE **agent** PTY (⚡ quick-launch) with that PTY's env and the curl shim on `PATH`. For each command it writes a Claude-format `tool_use` / `tool_result` line to `$HOME/.claude/projects/<cwd-slug>/<session>.jsonl` — **only inside the container** (`/.dockerenv`) — and runs it with `sh -c`. |
| `e2e/support/gazelle-like.ts` | Launch helpers, a named checkpoint screenshot (`gl__NN-<name>.png`), and a local TLS upstream (a throwaway test CA made with `openssl` at run time — no key committed). |
| `e2e/specs/gazelle-like.e2e.ts` | **Blocking** (`--all`, verify's local-integration class). gazelle-like's upstream is the local TLS server, trusted through `GAZELLE_EXTRA_ROOT` *added* to webpki-roots — the IDE's CA is still not trusted, so a MITM would still break it. |
| `e2e/specs/gazelle-like-external.e2e.ts` | **Reported** (`--external`): upstream `https://example.com/` (the one public host the external tier uses) and the agent's plain `curl https://example.com/`. |

What the blocking spec asserts, in the real UI:

- the agent's `curl --noproxy '*'` calls to `127.0.0.1:3000` are HTTP rows, 200, from the agent's
  terminal, with request/response headers and body in the detail;
- the `NO_PROXY='*' python3` call is a BYPASS row carrying the verbatim command;
- gazelle-like's outbound HTTPS is a TUNNEL row from terminal `gazelle`: `closed`, bytes ↑/↓, the
  "not decrypted" card — and the fixture's `/shipping/rates` still returns 200 (TLS never broken);
- Network's sidebar lists gazelle-like under APPS › Rust · Cargo with origin IDE; `gazelle` under
  TERMINALS (the agent under AGENTS); clicking `gazelle` leaves only its flows; the toolbar's
  Source / Process / Host pickers are on screen;
- Logs lists gazelle-like as a Rust app; its `gazelle-like.log` streams as its own source with only
  its lines; the `gazelle` terminal's stdout is a source with only gazelle-like's lines; the agent's
  commands are visible.

Run it: `E2E_CHECKPOINTS=1 node scripts/e2e-linux.mjs e2e/specs/gazelle-like.e2e.ts` (screenshots
land in `E2E_ARTIFACTS`, default `<tmpdir>/agent-studio-e2e`). **Look at the screenshots**, not only
at the pass count. Limits, said plainly: the fake agent's commands run with
`sh -c` in the agent PTY, not through Claude Code's login-shell snapshot and `$CLAUDE_ENV_FILE`
(the path the SessionStart hook's `PATH` export takes) — that hop is covered by the Rust tests of
the hook command, not here.

---

## 8. Anti-patterns — forbidden

| # | Forbidden | Why | Instead |
|---|---|---|---|
| 1 | **Testing xterm.js, allotment, zustand, immer, CodeMirror** | Not our code. Their suites are better than ours. | Test *our* decisions at the boundary |
| 2 | **Snapshotting terminal bytes / ANSI streams** | Escape sequences vary by TERM, shell, OS, ConPTY. A snapshot pins accidents and rots weekly. | Assert **specific bytes present** or byte-identity of a round-trip |
| 3 | **Asserting on timing without fake timers** | `sleep(10)` + "did it flush?" is a coin toss on a loaded CI runner. | `tokio::time::pause()`/`advance()`; `vi.useFakeTimers()` |
| 4 | **Mocking what we own** | Mocking `canonicalize` or the store tests the mock. | Real store, real reducers. Mock **only** the Rust boundary (§3) |
| 5 | **Testing xterm sizing in jsdom** | No layout engine → `offsetWidth === 0` → vacuously green. **Actively harmful**: false confidence in exactly the fit/resize bug class. | Layer 5 |
| 6 | **Reading `~/.claude/` at test time** | Machine-dependent, unavailable in CI, and reads real private data. | Committed fixtures (§7.1) |
| 7 | **Spawning real `claude` in tests** | Network, cost, nondeterminism, auth. | Fixture transcripts |
| 8 | **`sleep()` to wait for PTY output** | The flake factory. | Bounded read loop + deadline |
| 9 | **React tree snapshots** (`toMatchSnapshot()` on markup) | Records what the code does, not what it should. Reviewers rubber-stamp `-u`. | Assert roles/text/behaviour via RTL |
| 10 | **Assuming Playwright `webkit` ≡ WKWebView/WebKitGTK** | Different builds. A known Tauri-testing trap. | §7.5 caveat; real-WebView risk is manual/benchmark |
| 11 | **A mock whose `default:` returns `undefined`** | A renamed command silently returns `undefined` → test still green. | `default: throw` (§3.2) |
| 12 | **One global coverage % as the gate** | Gameable: trivia offsets untested parsers. | Per-area thresholds (§5.3) |
| 13 | **Committing a scratchpad probe as "the test"** | Unrunnable by `npm test` = doesn't exist. | Layer 5, in the repo, in CI |
| 14 | **`--force` / `--legacy-peer-deps` to make install work** | Hides real peer conflicts. Breaks `npm ci` and CI for everyone. | Fix the dep |

---

## 9. CI shape

**Principle: the per-push lane must stay under ~5 minutes**, or it gets bypassed
— and a bypassed gate is worse than no gate, because it looks like one.

### Lane 1 — per push / PR (**required**, ~3–5 min)

| Job | OS | Steps |
|---|---|---|
| `frontend` | **ubuntu** (cheapest, 1×) | `npm ci` · `typecheck` · `lint` · `vitest run --coverage` (jsdom+node projects) · threshold gate |
| `browser` | **ubuntu** | `vitest --browser` (Playwright **chromium only**, cached) — layer 5 |
| `rust` | **ubuntu** + **macos** | `cargo fmt --check` · `cargo clippy -- -D warnings` · `cargo test` (unit + **real-PTY** integration) · `cargo llvm-cov --fail-under-lines $(cat .coverage-floor)` |

Both OSes for Rust because **PTY behaviour genuinely differs** (Linux EIO-as-EOF
vs macOS forkpty) — that's the §7.3 contract, and a Linux-only lane wouldn't
cover the machine we develop on. Frontend is OS-independent (Node + jsdom), so
running it 3× is pure waste.

Cache: `Swatinem/rust-cache`, `actions/setup-node` npm cache, Playwright browser
cache. Uncached, `rust` alone exceeds the budget.

### Lane 2 — merge queue / nightly (~15–25 min)

| Job | OS | Why not per-push |
|---|---|---|
| `rust-windows` | windows | ConPTY differences are real (§7.3) but slow + the rarest platform. Must be green **before merge**, not on every push. |
| `build-app` | mac · win · ubuntu | `tauri build` = Rust release link + bundling: **minutes per OS**. This is M0's existing matrix; it belongs here. |
| `frontend-matrix` | mac · win | Catches path-separator bugs (`terminalTitle` splits on `/\\`). Cheap but low-yield. |

### Lane 3 — release / manual

The manual smoke checklist (§4.3) on macOS · the §6 **Linux/NVIDIA benchmark gate** (a
perf gate, not a test — the DOM fallback makes it load-bearing) · signing/notarization.

### Deliberately not in CI

- **E2E / WebDriver** — §4. Revisit at M4 → then it lands in **Lane 2**, never Lane 1.
- **Coverage upload to a third-party service** — the ratchet is local and
  committed (§5.3). No external dependency in the quality gates.

---

## 10. The rules this strategy adds

| # | Rule | Reason |
|---|---|---|
| **1** | The M3 parser is tested against real, **structurally reduced** JSONL fixtures (allowlist projection): fixtures keep only parser-read keys; all free text is dropped, not scrubbed. | "Sanitize" implies a denylist over adversarial prose, and real transcripts are full of home paths, JWTs, secret exports, connection strings and prose about private codebases. A denylist fails open, silently. An allowlist fails closed — including against fields Anthropic adds later. §7.1 |
| **2** | "Exercised end-to-end in the real running app" means a **versioned manual smoke checklist** until an automated E2E tier exists. | Otherwise the rule either blocks M1 on an immature WebDriver stack (§4.1) or gets waved through. Naming it manual makes the rigor level honest and reviewable. §4.3 |
| **3** | Coverage has a mechanism and numbers: `thresholds.autoUpdate` (frontend) / `.coverage-floor` (Rust); **per-area, not global**; **lowering requires a written decision**; targets in §5.4. | "Not regressed" is unenforceable without a committed number. §5.3 |
| **4** | CI is **tiered.** Per-push: ubuntu frontend + ubuntu/macOS Rust. Merge-queue/nightly: Windows + `tauri build` matrix. | A 3-OS everything-matrix per push blows the ~5-min budget; slow required checks get bypassed. Frontend is OS-independent — running it 3× buys ~nothing. §9 |
| **5** | **Rust↔TS wire-type agreement (golden JSON round-trip)** is a highest-value target. | ARCHITECTURE §2 calls the data model "THE contract" then **hand-mirrors it in two languages**. Drift compiles green on both sides and surfaces as `undefined` in the UI. §2.1 |
| **6** | Scratchpad harnesses are **deleted**, not merely excluded from coverage. | Layer 5 supersedes them. §5.1 |

The fan-out parsing rules that follow from §7.1 are ARCHITECTURE §5.2. The
reproduction is `scripts/fixtures/capture-transcript.mjs` (§7.1) plus the fixture
set, which is itself the regression test.

---

## 11. The milestone checklist

A milestone is done when:

- [ ] `npm run typecheck` · `npm run lint` green
- [ ] `npm test` green — **includes** jsdom+node projects **and** the browser project
- [ ] `npm run test:coverage` meets thresholds; any raise **committed in this PR**
- [ ] `cargo fmt --check` · `cargo clippy -- -D warnings` green
- [ ] `cargo test` green on **ubuntu + macOS** (Windows green in merge queue)
- [ ] `cargo llvm-cov` ≥ `.coverage-floor`; floor raised if beaten by >2 pts
- [ ] New logic landed with tests **in the same PR** (not "tests to follow")
- [ ] No scratchpad-shaped harness standing in for a test
- [ ] Fixture secret-scan green (§7.1)
- [ ] The manual smoke checklist run on macOS; the checklist pasted into the PR
- [ ] If a threshold was **lowered**: a written decision says why

**M1 closes when:** `store.ts` property tests (§6),
`toBytes` + Channel mock tests (§3), coalescer tests (§7.2), PTY lifecycle tests
(§7.3), and the layer-5 terminal tests (§7.5) are committed and green.
