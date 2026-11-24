# E2E — CI WebDriver smoke (layer 6)

Drives the **real built app** over WebDriver via a self-managed
[`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/) proxy. This is a
small **CI-only smoke** that proves the shipped WKWebView-class webview and the
real Rust core are wired across real Tauri IPC — the one fact the other tiers
cannot cover. The full UI regression lives in the **browser tier** (Playwright,
mocked backend, `npm run test:browser`, runs on every push).

Specs (`e2e/specs/`; the newer ones are listed below the two smokes; run them all with
`node scripts/e2e-linux.mjs --all`, which runs Ubuntu in Docker on any host, macOS included):

| Spec | Proves |
|---|---|
| `boot.e2e.ts` | The production artifact launches, React mounts the real `dist` bundle, and the 3-pane shell paints (`app-shell` + both rails + a center pane). |
| `api.e2e.ts` | `click → invoke('http_send') → reqwest → real loopback TCP → IPC → DOM`: a GET returns a 200 status pill + body, and a POST round-trips its body to a local echo server. |
| `find-scope.e2e.ts` | Two roots (the fixture workspace + a throwaway `gazelle` repo in the container's /tmp, made a root by quick-launching an agent there): with gazelle's console or a gazelle file focused, Ctrl+Shift+F / Ctrl+Shift+O open scoped to `gazelle` (and find only gazelle files); with a workspace file focused, scoped to `workspace`. Bare Ctrl+O (no Shift) quick-opens on the focused workspace; bare Ctrl+F stays the editor's own find bar inside an editor and is Find in Files (scoped to `gazelle`) on a tab header. Seeds the app's `recent-projects.json` **in the container only** and restores it. |
| `tearoff.e2e.ts` | Move to New Window / Move to Main Window for a terminal (same PTY: `tty` and the shell's PID before and after, scrollback intact) and for an editor with unsaved text; then a **real X11 drag** of a tab out of the window opens a new one. Three witnesses for "a second window exists": the X server (`xdotool`/`xprop`/`xwininfo`), Rust's `tearoff_holdings`, and WebDriver window handles. |
| `restart.e2e.ts` | Agents survive a restart (docs/design/agent-restart-restore.md §7). Two agents (⚡) in two panes side by side, the second renamed on its tab (`release-checker`); the stub `claude` (`fixtures/claude-stub.sh`) records every launch's argv in `$TMPDIR/agentstudio-e2e-claude-argv.log`, so the spec learns the first agent's session id, writes a saved conversation for it under the **container's** `$HOME/.claude/projects/agentstudio-e2e/` (`support/restart.ts`, refuses outside Docker) and starts a turn in it (`/work` → the stub posts a `UserPromptSubmit` to the app's hook listener exactly as Claude's hook does → Running). Then the main window is closed the way its ✕ closes it (a `WM_DELETE_WINDOW` through libX11 — the window's `Destroyed`, which records who was mid-turn), the app exits, and `browser.reloadSession()` launches it again. Asserts: both are back in their own panes (the first left, the renamed one right), the rename kept and the first's tab still under its folder's name; the first was relaunched with `--resume <its id>` and reads **"↻ Resumed · was working"** (tooltip: "…Agent Studio was closed while it was working — tell it to continue."), the second with a NEW `--session-id` and reads "↻ Reopened · new chat"; row and tab ↻ say the same words; and BOTH terminals are painted — text pixels in each pane's first terminal row, read off the X screen with ffmpeg's x11grab (`support/restart.ts screenTextPixels`, ≥ 200; the banner lights ~400, a blank pane lights 0). Then the renamed one's tab is closed (✕, confirming if asked) and `reloadSession()` again: only the first comes back (`--resume` again, nothing launched for the closed one), marked "↻ Resumed" with the tooltip "…did not close cleanly, so it may have been working…" (tauri-driver's session end kills the app: no window ✕, nothing recorded). It closes everything it opened, so the next spec's app starts empty. Stills: before the restart, after it (markers), the tooltip (the real X pointer on the tab's ↻), after the second restart. The stub also exits on `/exit` (a user ending the agent). |
| `village-city.e2e.ts` | Agent Village + City **in Asia/Tokyo** (the spec's own app only — `support/app-zone.ts`; the worker and every other spec stay UTC) with one IDE agent, one console and eleven fake outside agents (a transcript under the **container's** `$HOME/.claude/projects` + a live process named `claude` claiming it — `support/outside-agents.ts`, refuses to run outside Docker, touches the transcripts every 30 s so a long recorded run does not age the sub-agents into "done"): two of them in one repo (**gazelle**, a two-floor building), a **big team of 26 sub-agents** (more than one desk row of ten desks holds), and six more in the big team's repo — a **seven-floor building**, every floor two desk rows tall. Every sub-agent is **background-shaped** like the real CLI's (`requestShape: "background"`, its launch answered at once in the parent), and must read as working until its parent's `<task-notification>` (the newcomer's `finish()`). The files their tool calls name make their projects' languages known (gazelle `.rs` → rust, storefront `.ts`/`.tsx` → typescript, payments-api `.py` → python; the handbook touches only Markdown, which never votes). Asserts: the page's `Intl` zone is `Asia/Tokyo`, its `Date` offset is Tokyo's, the sky chip's clock reads Tokyo time, and the worker's own zone is NOT Tokyo; the picture was given the zone (`Ambience.zone`); in the Docker run the live weather fails as `offline` because `api.open-meteo.com` resolves to 127.0.0.1 (`E2E_BLOCKED_HOSTS`); the HUD counts every seeded agent (11 roots + 35 sub-agents), and after the switch to City all 35 background sub-agents are working at their desks; nothing the page says carries a "+N"; the page throws nothing while it paints. **Village** (through `data-capacity-boxes` and `support/village-scene.ts`, a read-only look at the live `VillageView` — no pixels): the Seats/Memory/Usage houses are whole and below the HUD at Fit and each opens its card; the Seats board seats everyone ("Seats N/E", or "Seats N · est E" past the estimate `min(16, max(2, CPUs − 2))`) and its card agrees; the Seats room has a desk per seated agent and a LAN switch; the big team's house has a team seat for each of the 26 and a router; sakura, vending, torii. **City**: on the switch every busy sub-agent rides from a lounge bench to its desk (waited for in the page, every frame: ten out on the street at once, then every one seated at its own desk); the Capacity HQ (Memory, Usage) stands in the middle of the street with projects on both sides, its door in the middle of its front, and Fit centres it; the Seats **lounge** is under the street, centred under the HQ's door, 64 benches in rows of 16, its lift up the door's column to a kiosk on the far sidewalk (the crossing) and stopping at every bench row's aisle; every project with a team has a lift up its door column stopping at every team chair row, the others none; the real `machine_capacity` read; the lounge board reads "Seats N/64" (N ≥ every busy seeded agent) and its card says the same N, its free seats and the estimate as a yardstick; the HQ's floors and the lounge are whole below the HUD at Fit. **Tokyo's landmarks** (the Skytree once slid behind the seven-floor building on zoom): the canvas's `data-landmark-boxes` gives each far landmark's CROWN on screen (the towers' tip to their lowest deck, Fuji's snow cap); at Fit all three are there, whole and below the HUD, with two buildings standing between Tokyo Tower's crown and the Skytree's (the towers stand apart), and — at Fit, after two WHEEL steps on the tall building's right wall, after three on the HQ, and after a pan — no building whose roof is above a crown's bottom overlaps it; a crown's offset from the HQ grows by exactly the zoom, and a pan moves it by exactly what it moves the HQ (world-locked: no parallax). The wheel goes through WebDriver's wheel input, else the same `wheel` event dispatched on the canvas (the run logs which). **City life** (decoration, never agents): the subway runs under the Seats lounge (its ceiling below the lounge's floor), its station under its street entrance, and the `metro` prop stands at that entrance on the far sidewalk, left of the lounge; over 10 s of real frames at Fit by day (read-only off the view's `TrafficFx.vehicles()` and `StreetLife.walkers()`, `watchLife`) ≥ 2 vehicles and ≥ 2 passers-by are on screen, nobody under an umbrella, and the sim's characters stay exactly the agents; in the rain (afternoon) over 12 s at least one passer-by walks under an open umbrella; the rain still is taken as one walks by (an in-page wait). **Tokyo's backdrop** (variant E — high-rises, the neon canyon, the yokochō shops, open sky between their clusters; it comes with the Tokyo street theme, `render/city.ts` `backdropOf`): at a clear Afternoon and a clear Night, Fit, the canvas's REAL pixels (`getImageData`, counted in the page — `support/village-scene.ts` `bandColours`) over the open street's sky beyond the city's two ends, from 3 tiles above the street's top (over its props: a torii rises 2) up through 40 % of the sky, less the columns under each landmark crown widened by its own width (a tower's legs): by day ≥ 0.25 % of the band is `coloured` (saturated, not the sky's blue — sign plates), at night ≥ 0.30 % is `neon` (saturated and bright), in each of three reads 1 s apart (a stuttering kana, a screen's scene). Measured over three runs: the backdrop 0.67–1.05 % by day, 0.78–1.59 % at night; the plain haze over the same band 0.000 % of either. **The commute**: one more sub-agent is started mid-spec under gazelle's upper floor (`addSubagent`) and a page-side tracker records its place every frame — it appears on a lounge bench, rides the lounge's lift, crosses at the HQ's door column (never anywhere else on the road), walks the near sidewalk, rides gazelle's lift and sits at its own desk; when its turn ends (`finish()`) it comes back the same way to the bench it left. The big team's floor: 20 seats on its first chair row and the rest on a second (no wider than ten desks, taller than a one-row floor), its lift stops at both, a router, all 26 at their own desks. Neon: each seeded project's building carries its language (`CityBuilding.language`) AND its sign is drawn saying it — the canvas's `data-neon-boxes` (`VillageView.neonBoxes`, made from the very draw items the renderer paints) has gazelle "rust", storefront "typescript", payments-api "python" at Fit, each hanging off its building's right wall, and none for the handbook or the HQ; the neon close-ups are framed on that box and check the sign is whole in the still. Stills, in order: Village at Fit, Seats/Memory cards, the Seats house (LAN), the big team's house, the plaza; City: everyone riding to work (framed on the commute's route — at Fit the City is drawn at ¼ in this pane), Afternoon at Fit, the landmarks at Fit / zoomed on the tall building / zoomed on the HQ, city life (Fit by day, the subway entrance close-up — its eight-car train standing along the platform with its doors open, waited for on the page's frame clock (`trainInStation`) — the street in the rain, a cloudy sky at Fit), Tokyo's backdrop (Fit by day and at night: `skyline-day`, `skyline-night`), the lounge's card, the Usage card, the lounge close-up (waiting agents, board); the commute — riding the lounge's lift, riding gazelle's lift, at its desk, crossing back, back on its bench (each asked for `STILL_LEAD_S` before the newcomer reaches it, from its trip in the sim — never by sleeping; a moment already passed gets no still and a warning); the big team's two-row floor, and its leader up close at the keyboard right in front of its chair (the monitor beside it); at dusk and at night: neon at Fit, the far skyline (wheel-zoomed on the HQ), gazelle's neon close-up; then Night + Rain (City, close-up, Village). In the commute stills every commuter is a real scanned sub-agent; the agents on the FREE benches are decoration standing for free seats. |

Two WebKitWebDriver quirks the specs work around (both the driver, not the app):
the second of two identical consecutive keys is dropped (`$$` → `$`), and once a second window has
existed, typed characters arrive **without Shift** in every window (`DETACHED_PID_$$` → `detached-pid-44`).
After a tear-off the specs type only unshifted, non-repeating text.

## Video and screenshots (`--record`)

```bash
node scripts/e2e-linux.mjs --record e2e/specs/tearoff.e2e.ts   # or --all --record, or E2E_RECORD=1
```

Opt-in. ffmpeg `x11grab`s the **whole xvfb display** (so a torn-off second window is in the picture, not
only the WebDriver viewport): one H.264 mp4 (15 fps) + a GIF (≤ 8 MB, 800 px wide, for inline PR display)
per spec file, and a PNG of the whole display at each spec's named `moment(...)`, which also holds the
video on that frame for 1.5 s. `moment(name, { settleMs })` waits longer before the still: a terminal's output is proven off the Rust log stream (the WebGL renderer has no DOM text) and the software-GL screen can paint it ~1 s later, so the tear-off spec's terminal stills use 2 s. Output: `$E2E_ARTIFACTS/media/` (default `<tmpdir>/agent-studio-e2e/media`).
While recording, a tiny window manager (openbox) runs so new windows get placed and get title bars. WebDriver pointer moves are synthetic, so the X cursor drawn in the video does not follow them on its own. While recording, `village-city` moves the real X pointer to each hover and parks it in the empty Files rail afterwards (`x11.ts movePointer`).
Without `--record` nothing changes: no ffmpeg, no window manager, `moment()` is the old WebDriver `snap`.
`npm run verify` never records.

## ⚠️ You cannot run this on macOS *natively*

> On a Mac, run it in Docker instead: `node scripts/e2e-linux.mjs --all` (add `--record` for video and
> stills). That is also verify's blocking E2E step. The paragraph below is about running the suite
> directly against the macOS app, which is still impossible.

`tauri-driver` has **no WKWebView driver on macOS** (Apple limitation — Tauri's
docs state only Windows and Linux are supported). So this suite runs **only in
CI on Linux** (and nightly on Windows). On a Mac dev host it is unrunnable; it is
verified by the `E2E` GitHub workflow, not locally. Everything *else* here is
locally checkable (typecheck, lint, the stub, the fixture repo, the config).

## Run it (Linux / CI)

```bash
# System deps (Ubuntu): the Tauri build deps + the WebKit WebDriver + a display.
sudo apt-get install -y webkit2gtk-driver xvfb   # (plus the ci.yml rust-job deps)
cargo install tauri-driver@2.0.6 --locked
npm ci

# Builds the app (debug, no bundle), seeds the fixture repo, spawns tauri-driver,
# runs the two specs. Headless via a virtual display:
xvfb-run -a npm run e2e
```

`npm run e2e` is self-contained: its `onPrepare` hook runs
`tauri build --debug --no-bundle` (and fails loudly if the binary is missing),
seeds the fixture git repo, and starts `tauri-driver`. `npm run e2e:build`
rebuilds the app binary on its own if you want a visible build boundary.

## Determinism seams (all already in the app — no Rust change)

`wdio.conf.ts` launches `tauri-driver` with these, and the app inherits them:

| Seam | How | Effect |
|---|---|---|
| **cwd = the fixture workspace** | `tauri-driver` is spawned with `cwd = e2e/fixtures/workspace` | `default_workspace` (git-root-of-launch, `workspace.rs`) roots the file tree / find / quick-launch at the fixture, not the dev's real project. |
| `AGENTSTUDIO_CLAUDE_BIN` | → `e2e/fixtures/claude-stub.sh` | `agent_spawn` drives a stub instead of the real `claude` (`agent/claude.rs` `resolve_binary`). Kept for parity; the two smoke specs don't spawn an agent. |
| `AGENTSTUDIO_FANOUT_POLL_MS=50` | env | the transcript tailer polls fast (`supervisor/mod.rs`). |
| local HTTP server | `e2e/support/http-fixture.ts` binds `127.0.0.1:0` | the API spec hits a canned GET / echo POST over real loopback — no public network. |
| **per-spec app time zone** | `support/app-zone.ts` `APP_ZONES` (`village-city` → `Asia/Tokyo`): wdio.conf's `beforeSession` points that spec's `tauri:options.application` at a generated `TZ=… exec <binary>` launcher | only that spec's app changes zone; tauri-driver (one process for the run), the wdio worker and every other spec keep the container's UTC. Linux only. |
| **no agent to restore** | wdio.conf's `beforeSession` (`clearAgentRegistries`) deletes `open-agents.json` and `pinned-agents.json` from the container's app-config dir (`~/.config/<identifier>`), Docker only | every spec FILE's app starts with no agent to restore (the app restores every open and pinned agent at launch, and all specs share one container): an agent one spec left open no longer appears in the next one's rail, panes and City. A spec's own `browser.reloadSession()` does not re-run it, so `restart.e2e.ts` keeps its registry across its own restarts. |
| **blocked hosts** | `scripts/e2e-linux.mjs` `BLOCKED_HOSTS` → `docker run --add-host <host>:127.0.0.1`, listed in `E2E_BLOCKED_HOSTS` | `api.open-meteo.com`: an app in a real zone (Tokyo) would fetch that city's live weather; in the container it fails fast as `offline`, so nothing leaves it. |

## Fixture workspace is a self-seeded git repo

`e2e/fixtures/workspace/` holds committed plain files (`library.rs`,
`search-target.txt`, `README.md`). It must be **its own git repo** so
`find_repo_root` resolves *it* and not the outer Agent Studio repo — but a nested
repo cannot be committed, so the `.git` is **created at test time** (`onPrepare`,
or `e2e/fixtures/init-workspace.sh` for a manual run) and is git-ignored via
`e2e/.gitignore`.

> If you run the suite locally, a `.git` appears under the fixture. It is ignored
> and never tracked. **Commit the fixture files *before* your first local run** so
> `git add e2e/` records plain files rather than an embedded-repo gitlink.

## Cadence

`e2e.yml` runs on **`merge_group`** (gates the merge queue, Linux, required),
**nightly `schedule`** (full matrix incl. Windows), and **`workflow_dispatch`** —
never per-push (it carries the full `tauri build` cost + WebDriver flake, which
must stay off the fast per-push lane). Windows is nightly-only (the Edge-WebDriver
↔ WebView2 version-matching pitfall) and currently carries a `TODO` for wiring the
matched `msedgedriver`.
