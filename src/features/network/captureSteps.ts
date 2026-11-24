/**
 * "Capture this app": the words that tell a
 * user how to point ANOTHER app at the IDE's capture proxy — Postman, Insomnia, a Chrome,
 * or anything that honours `HTTPS_PROXY`. Pure: every line is a function of the app's name,
 * the proxy's port, the CA file's path and the platform, so a test pins one app at a time.
 *
 * Zero OS permission, on purpose: nothing here installs a system proxy or touches a
 * keychain (no OS permission may be required). The user does the pointing, inside the
 * other app.
 */

import { dirname, joinPath } from "../../lib/paths";
import { os } from "../../lib/platform";
import { modeLabel } from "./machineFormat";
import type { FlowClient, FlowSummary, MachineBackend, MachineConn, NetcapStatus } from "./networkTypes";

export type GuideKind = "postman" | "insomnia" | "chrome" | "generic";
export type GuidePlatform = "mac" | "linux" | "windows";

export const CAPTURE_BUTTON_LABEL = "Capture this app's requests…";

/** What the Whole Mac row's button opens, by the app's (executable) name. */
export function guideKind(appName: string): GuideKind {
  const n = appName.toLowerCase();
  if (n.includes("postman")) return "postman";
  if (n.includes("insomnia")) return "insomnia";
  if (n.includes("chrome") || n.includes("chromium")) return "chrome";
  return "generic";
}

/**
 * The guide's platform: the Whole-computer backend when there is one, else the webview's own OS
 * (`lib/platform`) — before, a Windows machine whose backend had not reported yet (or failed)
 * was handed the macOS steps (`open -na "Google Chrome"`, a POSIX env prefix).
 */
export function guidePlatform(backend: MachineBackend | null | undefined): GuidePlatform {
  if (backend === "linux-proc") return "linux";
  if (backend === "windows-iphlpapi") return "windows";
  if (backend == null) {
    const here = os();
    if (here === "windows") return "windows";
    if (here === "linux") return "linux";
  }
  return "mac";
}

/** How Chrome is started with a flag, per platform (it must not already be running). */
const CHROME_COMMAND: Record<GuidePlatform, (addr: string) => string> = {
  mac: (addr) => `open -na "Google Chrome" --args --proxy-server=${addr}`,
  linux: (addr) => `google-chrome --proxy-server=${addr}`,
  // Works in PowerShell (Start-Process) and in cmd alike.
  windows: (addr) => `start chrome --proxy-server=${addr}`,
};

/** Where Chrome keeps its trust, per platform — never a CA file, and never written by the IDE. */
const CHROME_TRUST: Record<GuidePlatform, string> = {
  mac: "Chrome trusts the macOS Keychain, not a CA file — and the IDE never writes to the Keychain.",
  linux: "Chrome trusts its own NSS store (~/.pki/nssdb), not a CA file — the IDE never writes there.",
  windows: "Chrome trusts the Windows certificate store, not a CA file — and the IDE never writes there.",
};

/**
 * Environment variables for one command, per platform. A POSIX shell takes them as a prefix
 * on the command line; PowerShell (the IDE's shell on Windows) sets them for the session.
 */
function envAssignments(platform: GuidePlatform, pairs: readonly (readonly [string, string])[]): string {
  return platform === "windows"
    ? pairs.map(([k, v]) => `$env:${k}="${v}"`).join("; ")
    : pairs.map(([k, v]) => `${k}=${v}`).join(" ");
}

export interface GuideInputs {
  app: string;
  /** Null when the proxy is not running. */
  port: number | null;
  /** Null when the IDE has no CA file. */
  caPath: string | null;
  platform: GuidePlatform;
}

export interface GuideStep {
  text: string;
  /** A command or value to paste, shown in a code box under the text. */
  code?: string;
}

export interface GuideSection {
  title: string;
  steps: GuideStep[];
  /**
   * The per-app "decrypt its HTTPS" switch belongs under this section. Only
   * on a Certificate section of an app that CAN trust a CA file — never Chrome's, which
   * reads the Keychain / NSS store the IDE never writes: opting Chrome in would only break
   * every HTTPS request it makes.
   */
  decryptSwitch?: true;
}

/** `127.0.0.1:51234`, or a placeholder the user can read when the proxy is down. */
export function proxyAddress(port: number | null): string {
  return `127.0.0.1:${port ?? "<port>"}`;
}

const ca = (path: string | null): string => path ?? "<the IDE's CA file>";

/** The file `netcap/ca.rs` writes beside `ca.pem` (`BUNDLE_FILE`): the OS trust anchors, the
 *  bundled Mozilla set, then the IDE's CA — the same file `pty_env` gives the IDE's terminals. */
const BUNDLE_FILE = "ca-bundle.pem";

/**
 * The CA BUNDLE's path, next to `ca.pem`. `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` REPLACE a
 * program's trust store rather than adding to it, so pointing them at `ca.pem` alone would
 * make every connection the proxy does not decrypt (a tunnel, a passthrough host) fail
 * verification. `NODE_EXTRA_CA_CERTS` is the one that adds, so `ca.pem` is right for it.
 */
export function caBundlePath(caPath: string | null): string {
  return caPath === null ? "<the IDE's CA bundle>" : joinPath(dirname(caPath), BUNDLE_FILE);
}

/**
 * The CA step in one sentence — reused by the detail pane when an external source's
 * connection is an undecrypted tunnel (the guide's "CA step"). With the per-app switch the
 * last step is the guide's per-app switch: trusting the CA inside the app is not enough on
 * its own, the proxy must also be told the app now trusts it. The view is named as the Network
 * toggle names it ({@link modeLabel}) — "Whole computer" on Windows and Linux.
 */
export function caStepHint(appName: string): string {
  return (
    `To see ${appName}'s HTTPS contents: turn on Decrypt HTTPS, add the IDE's CA in ${appName}, then switch on ` +
    `“${decryptSwitchLabel(appName)}” in the Certificate step of "${CAPTURE_BUTTON_LABEL}" on its row in ${modeLabel(null)}.`
  );
}

/* ── live routing state, the per-app decrypt switch, a moved port ─────────────────── */

/** The per-app switch's words. */
export function decryptSwitchLabel(appName: string): string {
  return `I added the IDE's certificate in ${appName} — decrypt its HTTPS`;
}

/** Its hover: what it does, what it needs, and what breaks without the certificate step. */
export function decryptSwitchTitle(appName: string): string {
  return (
    `Tell the capture proxy that ${appName} trusts the IDE's certificate, so its HTTPS is decrypted (paths, headers, bodies). ` +
    `Needs Decrypt HTTPS on in the IDE traffic header. Do the certificate step above first: without it, ` +
    `${appName}'s HTTPS requests will fail, because ${appName} won't trust the certificate the proxy presents.`
  );
}

/** Said under the proxy address — the port is persisted across restarts. */
export const PORT_STABLE = "This port stays the same across restarts.";

/** The moved-port warning, shown in the Network header and in the guide. */
export function portChangedText(moved: NonNullable<NetcapStatus["portChanged"]>): string {
  return (
    `The proxy moved from :${moved.from} to :${moved.to} (port ${moved.from} was busy) — ` +
    `update the port in apps you configured by hand.`
  );
}

/**
 * A `decryptApps` entry that can match safely — the mirror of Rust's `valid_app_entry`
 * (`netcap/client.rs`): non-empty, not all whitespace, no `/` (which would turn
 * `/<entry>.app/` into "any bundle" or a path fragment).
 */
export function validAppEntry(app: string): boolean {
  return app.trim() !== "" && !app.includes("/");
}

/**
 * Whether a flow's client IS this app — the ONE copy of Rust's `user_opted_in` rule
 * (`netcap/client.rs`), so the guide's "Receiving …" and the proxy's decrypt decision can
 * never disagree about who Postman is: the executable NAME equals `app`, or the executable
 * PATH contains `/<app>.app/` — every helper inside the bundle counts
 * (`…/Postman.app/Contents/Frameworks/Postman Helper.app/…` is Postman), a different bundle
 * that merely starts with it (`PostmanCanary.app`) does not. Case-sensitive, as in Rust.
 */
export function clientInApp(client: Pick<FlowClient, "name" | "path"> | null, app: string): boolean {
  if (client === null || !validAppEntry(app)) return false;
  return client.name === app || (client.path !== null && client.path.includes(`/${app}.app/`));
}

/**
 * The name an app goes by in `decryptApps`: the OUTERMOST `.app` bundle on the client's path
 * (a helper's flows belong to the app the user installed), else the executable name. Rust
 * expects the entry to be built from a flow's own `client.path`, so this reads it verbatim.
 */
export function appOfClient(client: Pick<FlowClient, "name" | "path">): string {
  const m = client.path === null ? null : /\/([^/]+)\.app\//.exec(client.path);
  return m ? m[1] : client.name;
}

export type RoutingState =
  /** At least one flow came through the proxy from inside the app. */
  | { kind: "receiving"; count: number; /** The client names seen, sorted — the Process picker's keys. */ processes: string[] }
  /** Nothing yet: the app's own sockets that go somewhere other than the proxy. */
  | { kind: "direct"; connections: number };

/** `127.0.0.1:8877` / `[::1]:8877` — a socket to the proxy itself is routed, not direct. */
function toProxy(remote: string, port: number | null): boolean {
  return port !== null && (remote === `127.0.0.1:${port}` || remote === `[::1]:${port}`);
}

/**
 * The guide's live routing line, derived — never stored:
 * "receiving" as soon as ANY flow's client is inside the app ({@link clientInApp}), else
 * "direct" with the app's connected sockets that do not go to the proxy (listeners and
 * peer-less UDP are not connections to anyone).
 */
export function routingState(
  flows: readonly Pick<FlowSummary, "client">[],
  app: { name: string; connections: readonly Pick<MachineConn, "remote">[] },
  proxyPort: number | null,
): RoutingState {
  const names = new Set<string>();
  let count = 0;
  for (const f of flows) {
    if (!clientInApp(f.client, app.name)) continue;
    count += 1;
    names.add((f.client as FlowClient).name);
  }
  if (count > 0) return { kind: "receiving", count, processes: [...names].sort() };
  return {
    kind: "direct",
    connections: app.connections.filter((c) => c.remote !== null && !toProxy(c.remote, proxyPort)).length,
  };
}

/**
 * Which `decryptApps` entry the guide's switch writes: the bundle of the first routed flow
 * from this app ({@link appOfClient} — so a "Postman Helper" row opts in all of Postman, the
 * way Rust matches it), else the row's own name when nothing has been routed yet.
 */
export function decryptTarget(
  flows: readonly Pick<FlowSummary, "client">[],
  appName: string,
): string {
  const hit = flows.find((f) => clientInApp(f.client, appName));
  return hit ? appOfClient(hit.client as FlowClient) : appName;
}

/** The closing line of every guide: where the traffic shows up. */
/**
 * Where an external app's requests show once it is pointed at the proxy — named exactly (a
 * vague pointer left no way to tell where to look): the Source picker's `external · <app>` row
 * and the Process picker's executable name, which is the Whole Mac row's name.
 */
export function guideOutcome(appName: string, exe: string = appName): string {
  return `Its requests then appear under IDE traffic, Source external · ${appName}, Process ${exe}.`;
}

export function guideSections(kind: GuideKind, i: GuideInputs): GuideSection[] {
  const addr = proxyAddress(i.port);
  const portText = i.port === null ? "<port>" : String(i.port);
  switch (kind) {
    case "postman":
      return [
        {
          title: "Proxy",
          steps: [
            { text: "Postman → Settings → Proxy → “Add a custom proxy configuration”." },
            { text: "Tick both HTTP and HTTPS. Proxy server: host 127.0.0.1, port:", code: portText },
          ],
        },
        {
          title: "Certificate (HTTPS contents)",
          steps: [
            { text: "Settings → Certificates → CA certificates → select the PEM file:", code: ca(i.caPath) },
            { text: "Keep “Enable SSL certificate verification” on — the IDE's CA is what makes Postman trust the decrypted connection." },
          ],
          decryptSwitch: true,
        },
      ];
    case "insomnia":
      return [
        {
          title: "Proxy",
          steps: [
            { text: "Insomnia → Preferences → Network → Proxy: enable it." },
            { text: "HTTP proxy and HTTPS proxy:", code: addr },
          ],
        },
        {
          title: "Certificate (HTTPS contents)",
          steps: [{ text: "Preferences → Certificates → CA certificates → add the PEM file:", code: ca(i.caPath) }],
          decryptSwitch: true,
        },
      ];
    case "chrome":
      return [
        {
          title: "Proxy",
          steps: [
            {
              text: "Quit Chrome, then start it with the proxy flag (a running Chrome ignores it):",
              code: CHROME_COMMAND[i.platform](addr),
            },
          ],
        },
        {
          title: "Certificate",
          steps: [
            {
              text: `${CHROME_TRUST[i.platform]} So HTTPS from Chrome stays an encrypted tunnel here (host and bytes only); plain HTTP shows in full.`,
            },
          ],
        },
      ];
    case "generic":
      return [
        {
          title: "Proxy",
          steps: [
            {
              text:
                i.platform === "windows"
                  ? `Start ${i.app} from a PowerShell window after setting the proxy in its environment (most HTTP libraries honour these):`
                  : `Start ${i.app} from a shell with the proxy in its environment (most HTTP libraries honour these):`,
              code: envAssignments(i.platform, [
                ["HTTPS_PROXY", `http://${addr}`],
                ["HTTP_PROXY", `http://${addr}`],
              ]),
            },
          ],
        },
        {
          title: "Certificate (HTTPS contents)",
          steps:
            i.platform === "windows"
              ? // Windows' own TLS (Schannel: curl.exe, PowerShell, .NET) reads the Windows
                // certificate store and no file variable at all — saying "curl reads it" here
                // would be false (platform-native: the Windows words are Windows-true).
                [
                  {
                    text:
                      "Point its TLS trust at the IDE's CA bundle too (Python and other OpenSSL-based tools read SSL_CERT_FILE, " +
                      "Python's requests REQUESTS_CA_BUNDLE, Node NODE_EXTRA_CA_CERTS):",
                    code: envAssignments(i.platform, [
                      ["SSL_CERT_FILE", caBundlePath(i.caPath)],
                      ["REQUESTS_CA_BUNDLE", caBundlePath(i.caPath)],
                      ["NODE_EXTRA_CA_CERTS", ca(i.caPath)],
                    ]),
                  },
                  {
                    text:
                      "Windows' own curl.exe, PowerShell and .NET apps trust the Windows certificate store instead, which " +
                      "the IDE never writes — their HTTPS stays an encrypted tunnel here (host and bytes only).",
                  },
                ]
              : [
                  {
                    text: "Point its TLS trust at the IDE's CA bundle too (OpenSSL/Python/curl read the first, Node the second):",
                    code: envAssignments(i.platform, [
                      ["SSL_CERT_FILE", caBundlePath(i.caPath)],
                      ["NODE_EXTRA_CA_CERTS", ca(i.caPath)],
                    ]),
                  },
                ],
          decryptSwitch: true,
        },
      ];
  }
}
