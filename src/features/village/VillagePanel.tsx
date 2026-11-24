/**
 * VillagePanel — the Agent Village tab: a pixel-art village where every Claude Code
 * agent on this machine is a character (IDE agents and, unless toggled off, the ones
 * running in other terminals). Wires the three layers together:
 *
 *   useVillageAgents (data) → VillageView (sim + world + camera) → renderFrame (canvas)
 *
 * Two pictures of the same agents, switched by the HUD's Village | City toggle (remembered
 * per viewer, `villageMode`): the VILLAGE — a house per project — and the CITY (an option to
 * see everything as a city, where everything running is a building
 * and every console or agent takes one floor) — a building per project, a floor per root
 * agent or plain IDE console (`useCityConsoles`), each floor's leader at the big desk and its
 * sub-agents at the team desks (engine/city.ts). Each picture has its own `VillageView` (sim,
 * world, camera), kept while the tab is open, so switching back finds the camera where the
 * user left it. The sky, the sprite bank and the HUD are shared.
 *
 * The world is rebuilt only when the plan's signature changes, so an agent changing
 * activity never moves the houses. The rAF loop runs only while the tab is mounted AND the
 * document is visible. A host without a 2D context (jsdom) still gets the HUD, the empty
 * state and the controls — the loop just skips painting.
 *
 * Sky: `useVillageAmbience` brings the live weather + the local
 * clock; `computeAmbience` turns them (or the HUD override) into the outdoor grade,
 * weather and lights, which `VillageView` hands to the sim (idle agents go indoors) and
 * the renderer (house interiors stay lit and dry). The chip in the HUD shows / overrides it.
 *
 * Interaction: drag to pan, wheel / − + to zoom (integer steps — and for a city too big for
 * its pane, halvings below 1 down to the zoom that shows it whole — anchored at the
 * cursor / centre; wheel deltas accumulate so a trackpad gesture is not a leap), Fit to re-frame; hover a character for its card; click an IDE
 * character to select that agent (the same `selectAgent` the rail's rows use, which
 * re-points the centre to its terminal); click a city console to bring its terminal tab to
 * the front (`focusLogSource`, the Agent Logs "take me there"); click an outside character
 * whose app is known (iTerm2, Terminal…) to bring that app to the front
 * (`focus_external_agent` — a failure is a coded line in the HUD, never a dialog).
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import { asAgentId } from "../../app/types";
import { focusLogSource } from "../agentlogs/agentLogsFocus";
import { useContextStore } from "../context/contextStore";
import { useUsageStore } from "../usage/usageStore";
import { CapacityInfoCard } from "./CapacityInfoCard";
import { capacityCard, capacityFrame, capacityLayout, contextLine, type CapacityInputs } from "./capacityModel";
import { useCityConsoles } from "./cityModel";
import {
  buildCityWorld,
  buildWorld,
  computeAmbience,
  planCity,
  planHouses,
  type CityPlan,
  type HousePlan,
} from "./engine";
import { defaultMakeLayer, loadSprites, type DrawTarget, type SpriteBank } from "./render";
import { useVillageAmbience } from "./useVillageAmbience";
import { useHallAgent } from "./useHallAgent";
import { useMachineCapacity } from "./useMachineCapacity";
import { useAnimationLoop, useDocumentVisible } from "./useVillageLoop";
import { VillageInfoCard } from "./VillageInfoCard";
import { VillageSkyChip } from "./VillageSkyChip";
import { externalErrorCode, focusExternalAgent } from "./villageIpc";
import { useVillageMode } from "./villageMode";
import { useVillageAgents } from "./villageModel";
import { dressWorld } from "./engine/streetTheme";
import type { CapacityFrame, CapacityKind } from "./villageTypes";
import {
  citySummary,
  countAgents,
  DRAG_SLOP,
  planSignature,
  VillageView,
  villageSummary,
  WHEEL_IDLE_MS,
  WHEEL_STEP_PX,
  type Scene,
} from "./villageView";
import "./village.css";

interface Hover {
  key: string;
  x: number;
  y: number;
  at: number;
}

interface CapacityHover {
  kind: CapacityKind;
  x: number;
  y: number;
  at: number;
}

interface Drag {
  x: number;
  y: number;
  sx: number;
  sy: number;
  moved: boolean;
}

/** The prefix `fromExternal` puts on Rust's opaque key (villageTypes `VillageAgent.key`). */
const EXT_PREFIX = "ext:";

/** px per `deltaMode` unit: pixels, lines, pages. */
const WHEEL_UNIT = [1, 16, 400];

const MODES: { value: Scene; label: string }[] = [
  { value: "village", label: "Village" },
  { value: "city", label: "City" },
];

/** CSS px kept between the HUD's bottom edge and the world at Fit. */
const HUD_GAP = 6;

/** This machine's IANA time zone — the City's skyline shows its city's landmarks (Asia/Tokyo: Tokyo Tower, Skytree). */
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Pointer position relative to the canvas, in CSS px. */
function local(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function VillagePanel(): React.JSX.Element {
  const [includeExternal, setIncludeExternal] = useState(true);
  const [mode, setMode] = useVillageMode();
  const city = mode === "city";
  const { agents, externalError } = useVillageAgents({ includeExternal });
  const consoles = useCityConsoles({ enabled: city });
  const selectAgent = useAppStore((s) => s.agentActions.selectAgent);
  const [views] = useState(() => ({
    village: new VillageView(),
    city: new VillageView(1, defaultMakeLayer, "city"),
  }));
  const view = views[mode];
  const [bank, setBank] = useState<SpriteBank | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [capHover, setCapHover] = useState<CapacityHover | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);
  const visible = useDocumentVisible();
  const wrapRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<DrawTarget | null>(null);
  const dragRef = useRef<Drag | null>(null);

  // Who is on screen: the agents — and in the city every plain console too, each a floor.
  const shown = useMemo(() => (city ? [...agents, ...consoles] : agents), [city, agents, consoles]);
  const roster = useMemo(() => (city ? planCity(shown) : null), [city, shown]);
  const sig = roster ? planSignature(roster.plans) : planSignature(planHouses(agents));

  // Capacity: the machine sample (polled only while this tab is on screen), the usage
  // strip's last reading and the context card's readings — the latter two only READ here.
  const machine = useMachineCapacity(visible);
  // The sky: the live weather + the local clock (ticks every 30 s), or the HUD override. The same
  // clock ages the context readings (a bar older than CONTEXT_STALE_MS goes grey).
  const sky = useVillageAmbience();
  const clockMs = sky.now.getTime();
  const usage = useUsageStore((s) => s.snapshot);
  const usageError = useUsageStore((s) => s.error);
  const contextEntries = useContextStore((s) => s.entries);
  // The Seats hall (Village and City): the selected agent's context window, read while on screen.
  const hallAgent = useHallAgent(visible);
  // The City's Seats are its lounge under the street: a fixed 64, more by whole bench rows.
  const seats = capacityLayout(agents, city).seats;
  const capInput = useMemo<CapacityInputs>(
    () => ({
      machine: machine.sample,
      machineError: machine.error,
      agents,
      includesOutside: includeExternal,
      usage,
      usageError,
      context: contextEntries,
      nowMs: clockMs,
      lounge: city,
      hallAgent,
    }),
    [machine.sample, machine.error, agents, includeExternal, usage, usageError, contextEntries, clockMs, city, hallAgent],
  );

  // Dressed for the machine's city (Asia/Tokyo: sakura, vending machines, a torii); elsewhere as built.
  const world = useMemo(
    () =>
      dressWorld(
        city
          ? buildCityWorld(JSON.parse(sig) as CityPlan[], { seats })
          : buildWorld(JSON.parse(sig) as HousePlan[], { seats }),
        LOCAL_ZONE,
      ),
    [city, sig, seats],
  );
  // The city seats each leader by its FLOOR: the sim gets the roster's rewritten agents.
  const simAgents = roster ? roster.agents : agents;
  // Declared in this order on purpose: in one commit the new world lands before the
  // agents whose new house it holds.
  useEffect(() => view.setWorld(world), [view, world]);
  useEffect(() => view.setAgents(simAgents), [view, simAgents]);
  useEffect(() => view.setCapacity(capInput), [view, capInput]);
  // The buildings' figures in words, for the canvas's description (who holds which desk does not
  // change a count, so no desk history is needed here).
  const captions = useMemo(() => capacityFrame(capInput, null).captions, [capInput]);
  const capacityId = useId();

  const ambience = useMemo(
    () => computeAmbience(sky.now, sky.weather, sky.override, LOCAL_ZONE),
    [sky.now, sky.weather, sky.override],
  );
  useEffect(() => view.setAmbience(ambience), [view, ambience]);
  /** What the sky is KNOWN to be doing (override, else live report); null = unknown, say only the time. */
  const knownWeather = sky.override.weather !== "auto" || sky.weather ? ambience.weather : null;

  // The art, decoded once for both pictures; a bank that lands after unmount is dropped.
  useEffect(() => {
    let disposed = false;
    void loadSprites().then((loaded) => {
      if (!disposed) setBank(loaded);
    });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (bank) view.setBank(bank);
  }, [view, bank]);

  // Canvas setup for the picture on screen: context, backing-store size, wheel zoom.
  useEffect(() => {
    const canvas = canvasRef.current as HTMLCanvasElement;
    const wrap = wrapRef.current as HTMLDivElement;
    ctxRef.current = canvas.getContext("2d");
    const measure = (w: number, h: number): void => {
      const size = view.resize(w, h, window.devicePixelRatio);
      canvas.width = size.w;
      canvas.height = size.h;
    };
    // The HUD floats over the stage's top-left: Fit keeps the world below it.
    const hud = hudRef.current as HTMLDivElement;
    const inset = (): void => {
      const h = hud.offsetHeight;
      view.setInset(h > 0 ? hud.offsetTop + h + HUD_GAP : 0);
    };
    inset();
    measure(wrap.clientWidth, wrap.clientHeight);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === hud) inset();
        else measure(e.contentRect.width, e.contentRect.height);
      }
    });
    ro.observe(wrap);
    ro.observe(hud);
    // Native + non-passive: React's onWheel is passive, so it could not stop the page scrolling.
    // Deltas accumulate to WHEEL_STEP_PX per zoom step (see WHEEL_STEP_PX).
    let acc = 0;
    let lastAt = -Infinity;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const now = performance.now();
      if (now - lastAt > WHEEL_IDLE_MS) acc = 0;
      lastAt = now;
      acc += e.deltaY * (WHEEL_UNIT[e.deltaMode] ?? 1);
      if (Math.abs(acc) < WHEEL_STEP_PX) return;
      view.zoomBy(acc < 0 ? 1 : -1, local(canvas, e));
      acc = 0;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      ctxRef.current = null;
      // The other picture takes over the canvas: this one's clock must not count the gap.
      view.pause();
    };
  }, [view]);

  // Where the capacity buildings, the neon signs and the skyline landmarks' crowns are on screen, as the
  // canvas's `data-capacity-boxes`, `data-neon-boxes` and `data-landmark-boxes` (the E2E finds, hovers
  // and photographs them there — they exist only as pixels). Each written only when it changes.
  const boxesRef = useRef("");
  const neonRef = useRef("");
  const landmarkRef = useRef("");
  useAnimationLoop(
    (now) => {
      view.frame(now, ctxRef.current);
      const canvas = canvasRef.current as HTMLCanvasElement;
      const boxes = JSON.stringify(view.capacityBoxes());
      if (boxes !== boxesRef.current) {
        boxesRef.current = boxes;
        canvas.setAttribute("data-capacity-boxes", boxes);
      }
      const neon = JSON.stringify(view.neonBoxes());
      if (neon !== neonRef.current) {
        neonRef.current = neon;
        canvas.setAttribute("data-neon-boxes", neon);
      }
      const landmarks = JSON.stringify(view.landmarkBoxes());
      if (landmarks !== landmarkRef.current) {
        landmarkRef.current = landmarks;
        canvas.setAttribute("data-landmark-boxes", landmarks);
      }
    },
    visible,
    () => view.pause(),
  );

  const counts = countAgents(agents);
  const hovered = hover ? shown.find((a) => a.key === hover.key) : undefined;

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return;
    const p = local(e.currentTarget, e);
    dragRef.current = { x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false };
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const p = local(e.currentTarget, e);
    const d = dragRef.current;
    if (d) {
      view.pan(p.x - d.x, p.y - d.y);
      d.x = p.x;
      d.y = p.y;
      if (!d.moved && Math.hypot(p.x - d.sx, p.y - d.sy) > DRAG_SLOP) {
        d.moved = true;
        setDragging(true);
        view.setHovered(null);
        setHover(null);
        setCapHover(null);
      }
      return;
    }
    const key = view.pick(p.x, p.y);
    view.setHovered(key);
    setHover(key ? { key, x: p.x, y: p.y, at: Date.now() } : null);
    // Not over a character: maybe over a capacity building, which has its own card.
    const kind = key ? null : view.pickCapacity(p.x, p.y);
    setCapHover(kind ? { kind, x: p.x, y: p.y, at: Date.now() } : null);
  };

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!d || d.moved) return;
    const p = local(e.currentTarget, e);
    const key = view.pick(p.x, p.y);
    const agent = key ? shown.find((a) => a.key === key) : undefined;
    if (agent?.consoleId) focusLogSource({ terminalId: agent.consoleId, agentId: null });
    else if (agent?.origin === "ide" && agent.ideAgentId) selectAgent(asAgentId(agent.ideAgentId));
    else if (agent?.origin === "external" && agent.host) {
      setFocusError(null);
      focusExternalAgent(agent.key.slice(EXT_PREFIX.length)).catch((err: unknown) =>
        setFocusError(externalErrorCode(err)),
      );
    }
  };

  const onMouseLeave = (): void => {
    dragRef.current = null;
    setDragging(false);
    view.setHovered(null);
    setHover(null);
    setCapHover(null);
  };

  /** Switch pictures; the card of a character from the other one would point at nothing. */
  const pickMode = (next: Scene): void => {
    setHover(null);
    setCapHover(null);
    setMode(next);
  };

  const canvasClass = [
    "village__canvas",
    dragging && "village__canvas--grabbing",
    !dragging && (hovered?.origin === "ide" || Boolean(hovered?.host)) && "village__canvas--pointer",
  ]
    .filter(Boolean)
    .join(" ");

  const skyWords = { weather: knownWeather, phase: ambience.phase };
  const label = roster
    ? citySummary(
        {
          buildings: roster.plans.length,
          floors: roster.plans.reduce((n, p) => n + p.floors.length, 0),
          consoles: consoles.length,
        },
        counts,
        skyWords,
      )
    : villageSummary(counts, skyWords);

  return (
    <div className="village" data-testid="village-panel" data-mode={mode}>
      <div className="village__stage" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={canvasClass}
          role="img"
          aria-label={label}
          aria-describedby={capacityId}
          data-testid="village-canvas"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
        />
        <p id={capacityId} className="village__sr-only" data-testid="village-capacity">
          {captions.seats} · {captions.memory} · {captions.usage}
          {city && ` · ${captions.lounge}`}
        </p>
        {hover && hovered && (
          <VillageInfoCard
            agent={hovered}
            x={hover.x}
            y={hover.y}
            now={hover.at}
            context={contextLine(hovered, contextEntries, hover.at)}
          />
        )}
        {capHover && (
          <CapacityInfoCard
            card={capacityCard(capHover.kind, capInput, view.capacityFrame as CapacityFrame, capHover.at)}
            x={capHover.x}
            y={capHover.y}
          />
        )}
      </div>

      <div className="village-hud" data-testid="village-hud" ref={hudRef}>
        <div className="village-mode" role="radiogroup" aria-label="Picture">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              className="village-mode__opt"
              onClick={() => pickMode(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="village-hud__counts">
          {counts.ide} in IDE · {counts.outside} outside · {counts.active} active
          {city && ` · ${consoles.length} consoles`}
        </div>
        <VillageSkyChip {...sky} phase={ambience.phase} />
        <button
          type="button"
          role="switch"
          aria-checked={includeExternal}
          className="village-switch"
          onClick={() => setIncludeExternal((v) => !v)}
        >
          Show agents outside the IDE
        </button>
        {externalError !== null && (
          <div className="village-hud__err" role="status" data-testid="village-error">
            Couldn&apos;t scan agents outside the IDE ({externalError})
          </div>
        )}
        {focusError !== null && (
          <div className="village-hud__err" role="status" data-testid="village-focus-error">
            Couldn&apos;t switch to that agent&apos;s app ({focusError})
          </div>
        )}
      </div>

      <div className="village-zoom" role="group" aria-label="Village zoom">
        <button type="button" className="village-btn" aria-label="Zoom out" onClick={() => view.zoomBy(-1)}>
          −
        </button>
        <button type="button" className="village-btn" aria-label="Zoom in" onClick={() => view.zoomBy(1)}>
          +
        </button>
        <button type="button" className="village-btn" onClick={() => view.fit()}>
          Fit
        </button>
      </div>

      {shown.length === 0 && (
        <div className="village__empty" data-testid="village-empty">
          {city
            ? "Nothing running — open a terminal, or launch an agent with +"
            : "No agents running — launch one with + or run claude in any terminal"}
        </div>
      )}
    </div>
  );
}
