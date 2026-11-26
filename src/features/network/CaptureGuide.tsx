/** Inline capture guide under a Whole Mac app row (the open row lives in `machineStore`; the panel
 * remounts). Shows live whether requests arrive ({@link routingState}), the per-app decrypt
 * switch and the moved-port warning; IDE-started apps get `IdeAppCapture`, not manual steps. */

import { useMemo, useState } from "react";

import { useAppStore } from "../../app/store";
import { useProcsPolling, useProcsStore } from "../procs/procsStore";
import type { DevApp } from "../procs/procsTypes";

import {
  CAPTURE_BUTTON_LABEL,
  decryptSwitchLabel,
  decryptSwitchTitle,
  decryptTarget,
  guideKind,
  guideOutcome,
  guidePlatform,
  guideSections,
  PORT_STABLE,
  portChangedText,
  proxyAddress,
  routingState,
} from "./captureSteps";
import { IdeAppCapture } from "./IdeAppCapture";
import { revealMachinePid, setCaptureGuide, useMachineStore } from "./machineStore";
import { ignoresIdeCa, RUST_GO_CAVEAT } from "./networkApps";
import { sourceIndex } from "./networkSource";
import { setAppDecrypt, showAppFlows, useNetworkStore } from "./networkStore";
import type { MachineApp, NetcapStatus } from "./networkTypes";

export const PROXY_DOWN =
  "The capture proxy isn't running, so there is nothing to point this app at. It starts with the IDE; restart the IDE and come back.";
export const NO_CA_FILE = "The IDE has no CA file, so HTTPS contents can't be decrypted — plain HTTP still shows in full.";
export const STATUS_PENDING = "Waiting for the capture proxy's status…";

export function CaptureGuide({ app }: { app: MachineApp }): React.JSX.Element {
  useProcsPolling();
  const devApp = useProcsStore((s) => s.list?.apps.find((a) => a.pid !== null && a.pid === app.pid) ?? null);
  if (devApp !== null && devApp.origin === "ide") return <IdeGuide machine={app} app={devApp} />;
  return <ExternalGuide app={app} devApp={devApp} />;
}

/** The guide for an app the IDE started: no manual steps (module doc). */
function IdeGuide({ machine, app }: { machine: MachineApp; app: DevApp }): React.JSX.Element {
  const tabs = useAppStore((s) => s.tabs);
  const agents = useAppStore((s) => s.agents);
  // An IDE app always names its terminal (Rust's contract; the golden seam test pins it).
  const source = sourceIndex(tabs, agents).get(app.terminalId as string) ?? app.launchedBy ?? "its terminal";
  return (
    <section className="netm-guide" data-testid="netm-guide" data-guide="ide" aria-label={`Capture ${machine.name}'s requests`}>
      <div className="netm-guide__head">
        <strong>Capture {app.name}&apos;s requests</strong>
        <button type="button" className="net-btn" aria-label="Close the capture guide" onClick={() => setCaptureGuide(null)}>
          ✕ Close
        </button>
      </div>
      <p className="netm-guide__dim" data-testid="netm-guide-ide">
        {app.name} was started in the IDE ({source}) — the IDE sets its proxy, so there is nothing to configure by hand.
      </p>
      <IdeAppCapture
        app={app}
        source={source}
        ownsDialog
        onShowRequests={(process) => showAppFlows([process])}
        onShowConnections={(pid) => revealMachinePid(pid)}
      />
    </section>
  );
}

function ExternalGuide({ app, devApp }: { app: MachineApp; devApp: DevApp | null }): React.JSX.Element {
  const status = useNetworkStore((s) => s.status);
  const backend = useMachineStore((s) => s.status?.backend);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const port = status !== null && status.running ? status.port : null;
  const caPath = status?.caPath ?? null;
  const sections = guideSections(guideKind(app.name), { app: app.name, port, caPath, platform: guidePlatform(backend) });
  const flows = useNetworkStore((s) => s.flows);
  const routing = useMemo(() => routingState(flows, app, port), [flows, app, port]);

  const copyPath = (): void => {
    if (!navigator.clipboard) return;
    void navigator.clipboard
      .writeText(caPath as string)
      .then(() => setCopied("ok"))
      .catch(() => setCopied("failed"));
  };

  return (
    <section className="netm-guide" data-testid="netm-guide" aria-label={`Capture ${app.name}'s requests`}>
      <div className="netm-guide__head">
        <strong>Capture {app.name}&apos;s requests</strong>
        <button type="button" className="net-btn" aria-label="Close the capture guide" onClick={() => setCaptureGuide(null)}>
          ✕ Close
        </button>
      </div>
      <PortChangedBanner status={status} />
      <RoutingLine app={app.name} routing={routing} />
      <dl className="net-facts">
        <div className="net-facts__row">
          <dt>Proxy</dt>
          <dd data-testid="netm-guide-proxy">
            {status === null ? (
              STATUS_PENDING
            ) : port === null ? (
              PROXY_DOWN
            ) : (
              <>
                {proxyAddress(port)} <span className="netm-guide__dim">{PORT_STABLE}</span>
              </>
            )}
          </dd>
        </div>
        <div className="net-facts__row">
          <dt>CA file</dt>
          <dd data-testid="netm-guide-ca">
            {caPath === null ? (
              status === null ? STATUS_PENDING : NO_CA_FILE
            ) : (
              <>
                <code className="netm-guide__path">{caPath}</code>{" "}
                <button type="button" className="net-btn" onClick={copyPath}>
                  Copy path
                </button>
                {copied ? (
                  <span className={copied === "ok" ? "net-actions__ok" : "net-actions__err"} role="status">
                    {copied === "ok" ? "Copied path" : "Copy failed"}
                  </span>
                ) : null}
              </>
            )}
          </dd>
        </div>
        <div className="net-facts__row">
          <dt>Decrypt</dt>
          <dd data-testid="netm-guide-decrypt">
            {status === null
              ? STATUS_PENDING
              : status.decrypt
                ? "Decrypt HTTPS is on — with the CA trusted in the app, HTTPS paths, headers and bodies show."
                : "Decrypt HTTPS is off (IDE traffic header) — until it is on, HTTPS shows as encrypted tunnels (host and bytes only)."}
            {devApp !== null && ignoresIdeCa(devApp.runtime) ? (
              <span className="netm-guide__dim" data-testid="netm-guide-caveat">
                {" "}
                {RUST_GO_CAVEAT}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      {sections.map((s) => (
        <div key={s.title} className="netm-guide__section" data-testid="netm-guide-section">
          <h4 className="net-headers__title">{s.title}</h4>
          <ol className="netm-guide__steps">
            {s.steps.map((step, i) => (
              <li key={i}>
                {step.text}
                {step.code !== undefined ? <pre className="netm-guide__code">{step.code}</pre> : null}
              </li>
            ))}
          </ol>
          {s.decryptSwitch ? <AppDecryptSwitch app={decryptTarget(flows, app.name)} status={status} /> : null}
        </div>
      ))}
      <p className="netm-guide__outcome" data-testid="netm-guide-outcome">
        {guideOutcome(app.name)}
      </p>
    </section>
  );
}

/** The persisted port was taken at startup, so hand-configured apps still point at the old one. */
export function PortChangedBanner({ status }: { status: NetcapStatus | null }): React.JSX.Element | null {
  if (!status?.portChanged) return null;
  return (
    <div className="net-portmoved" role="alert" data-testid="net-port-changed">
      {portChangedText(status.portChanged)}
    </div>
  );
}

/** Are this app's requests arriving? Said first, because it is the answer. */
function RoutingLine({ app, routing }: { app: string; routing: ReturnType<typeof routingState> }): React.JSX.Element {
  if (routing.kind === "receiving") {
    return (
      <p className="netm-guide__routing netm-guide__routing--ok" data-testid="netm-guide-routing" data-routing="receiving">
        ✓ Receiving {app}&apos;s requests — {routing.count} so far.{" "}
        <button
          type="button"
          className="netm-guide__link"
          title={`IDE traffic, filtered to ${routing.processes.join(", ")}`}
          onClick={() => showAppFlows(routing.processes)}
        >
          show them
        </button>
      </p>
    );
  }
  return (
    <p className="netm-guide__routing netm-guide__routing--direct" data-testid="netm-guide-routing" data-routing="direct">
      Not routed yet — {app} is connecting directly ({routing.connections}{" "}
      {routing.connections === 1 ? "connection" : "connections"}). Follow the steps below; its requests show here as
      soon as they reach the proxy.
    </p>
  );
}

/** Reflects `status.decryptApps` as Rust returns it, never the click. The hover sits on a
 * non-disabled wrapper so a waiting switch still says why. */
function AppDecryptSwitch({ app, status }: { app: string; status: NetcapStatus | null }): React.JSX.Element {
  const setting = useNetworkStore((s) => s.setting);
  const on = status?.decryptApps.includes(app) ?? false;
  return (
    <span className="net-switch-wrap netm-guide__decrypt" title={status === null ? STATUS_PENDING : decryptSwitchTitle(app)}>
      <button
        type="button"
        role="switch"
        className="net-switch"
        aria-checked={on}
        disabled={status === null || setting}
        onClick={() => void setAppDecrypt(app, !on)}
      >
        {decryptSwitchLabel(app)}
      </button>
    </span>
  );
}

/** The row's toggle: opens this app's guide, or closes it when it is the open one. */
export function CaptureGuideButton({ appKey }: { appKey: string }): React.JSX.Element {
  const open = useMachineStore((s) => s.guideKey === appKey);
  return (
    <button
      type="button"
      className="net-btn netm-guide__toggle"
      aria-expanded={open}
      title="How to point this app at the IDE's capture proxy, so its requests show under IDE traffic."
      onClick={() => setCaptureGuide(open ? null : appKey)}
    >
      {CAPTURE_BUTTON_LABEL}
    </button>
  );
}
