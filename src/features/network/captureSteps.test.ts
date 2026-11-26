/** Expected strings are written by hand: a guide quoting its own template would pin nothing. */

import { describe, expect, it, vi } from "vitest";

import {
  appOfClient,
  caBundlePath,
  CAPTURE_BUTTON_LABEL,
  caStepHint,
  clientInApp,
  decryptSwitchLabel,
  decryptSwitchTitle,
  decryptTarget,
  PORT_STABLE,
  portChangedText,
  routingState,
  validAppEntry,
  guideKind,
  guideOutcome,
  guidePlatform,
  guideSections,
  proxyAddress,
  type GuideInputs,
} from "./captureSteps";
import type { FlowClient, MachineConn } from "./networkTypes";

const MAC: GuideInputs = { app: "Postman", port: 51234, caPath: "/cfg/netcap/ca.pem", platform: "mac" };

describe("guideKind — which steps an app gets, from its name", () => {
  it.each([
    ["Postman", "postman"],
    ["Postman Helper (Renderer)", "postman"],
    ["Insomnia", "insomnia"],
    ["Google Chrome", "chrome"],
    ["Google Chrome Helper", "chrome"],
    ["Chromium", "chrome"],
    ["chrome_crashpad_handler", "chrome"],
    ["gazelle", "generic"],
    ["node", "generic"],
    ["Safari", "generic"],
    ["", "generic"],
  ] as const)("%s → %s", (name, kind) => expect(guideKind(name)).toBe(kind));
});

describe("guidePlatform — from the Whole-computer backend", () => {
  it.each([
    ["macos-nettop", "mac"],
    ["linux-proc", "linux"],
    ["windows-iphlpapi", "windows"],
    [null, "mac"],
    [undefined, "mac"],
  ] as const)("%s → %s", (backend, platform) => expect(guidePlatform(backend)).toBe(platform));

  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/131.0", "windows"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15", "linux"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "mac"],
  ] as const)("no backend yet: the webview's own OS decides (%s → %s)", (agent, platform) => {
    const ua = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(agent);
    try {
      expect(guidePlatform(null)).toBe(platform);
      expect(guidePlatform(undefined)).toBe(platform);
      // A backend that HAS reported still wins over the webview.
      expect(guidePlatform("macos-nettop")).toBe("mac");
    } finally {
      ua.mockRestore();
    }
  });
});

describe("the shared lines", () => {
  it("proxy address, with a readable placeholder when the proxy is down", () => {
    expect(proxyAddress(51234)).toBe("127.0.0.1:51234");
    expect(proxyAddress(null)).toBe("127.0.0.1:<port>");
  });

  it("the CA-step hint: Decrypt HTTPS, the CA in the app, then the per-app switch (by its words) on its machine-view row", () => {
    expect(CAPTURE_BUTTON_LABEL).toBe("Capture this app's requests…");
    const ua = vi.spyOn(window.navigator, "userAgent", "get");
    try {
      ua.mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X)");
      expect(caStepHint("Postman")).toBe(
        "To see Postman's HTTPS contents: turn on Decrypt HTTPS, add the IDE's CA in Postman, then switch on " +
          "“I added the IDE's certificate in Postman — decrypt its HTTPS” in the Certificate step of " +
          "\"Capture this app's requests…\" on its row in Whole Mac.",
      );
      // On Windows the view is "Whole computer" — there is no "Whole Mac" to find.
      ua.mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
      expect(caStepHint("Postman")).toMatch(/on its row in Whole computer\.$/);
    } finally {
      ua.mockRestore();
    }
  });

  it("the outcome line says where the traffic shows up, as the Source label the table will use", () => {
    expect(guideOutcome("Postman")).toBe("Its requests then appear under IDE traffic, Source external · Postman, Process Postman.");
    expect(guideOutcome("Postman", "Postman Helper")).toBe("Its requests then appear under IDE traffic, Source external · Postman, Process Postman Helper.");
  });
});

describe("guideSections — per app", () => {
  it("Postman: Settings → Proxy (HTTP + HTTPS, 127.0.0.1, the port) and Settings → Certificates → the PEM", () => {
    expect(guideSections("postman", MAC)).toEqual([
      {
        title: "Proxy",
        steps: [
          { text: "Postman → Settings → Proxy → “Add a custom proxy configuration”." },
          { text: "Tick both HTTP and HTTPS. Proxy server: host 127.0.0.1, port:", code: "51234" },
        ],
      },
      {
        title: "Certificate (HTTPS contents)",
        steps: [
          { text: "Settings → Certificates → CA certificates → select the PEM file:", code: "/cfg/netcap/ca.pem" },
          { text: "Keep “Enable SSL certificate verification” on — the IDE's CA is what makes Postman trust the decrypted connection." },
        ],
        decryptSwitch: true,
      },
    ]);
  });

  it("Insomnia: Preferences → Network → Proxy (both), Preferences → Certificates", () => {
    expect(guideSections("insomnia", { ...MAC, app: "Insomnia" })).toEqual([
      {
        title: "Proxy",
        steps: [
          { text: "Insomnia → Preferences → Network → Proxy: enable it." },
          { text: "HTTP proxy and HTTPS proxy:", code: "127.0.0.1:51234" },
        ],
      },
      {
        title: "Certificate (HTTPS contents)",
        steps: [{ text: "Preferences → Certificates → CA certificates → add the PEM file:", code: "/cfg/netcap/ca.pem" }],
        decryptSwitch: true,
      },
    ]);
  });

  it("Chrome on a Mac: the `open -na … --proxy-server` command, and that the Keychain (never touched) means HTTPS stays a tunnel", () => {
    const [proxy, cert] = guideSections("chrome", { ...MAC, app: "Google Chrome" });
    expect(proxy).toEqual({
      title: "Proxy",
      steps: [
        {
          text: "Quit Chrome, then start it with the proxy flag (a running Chrome ignores it):",
          code: 'open -na "Google Chrome" --args --proxy-server=127.0.0.1:51234',
        },
      ],
    });
    expect(cert.title).toBe("Certificate");
    // No per-app decrypt switch: Chrome cannot trust a CA file, so opting it in would only break its HTTPS.
    expect(cert.decryptSwitch).toBeUndefined();
    expect(cert.steps).toHaveLength(1);
    expect(cert.steps[0].code).toBeUndefined();
    expect(cert.steps[0].text).toBe(
      "Chrome trusts the macOS Keychain, not a CA file — and the IDE never writes to the Keychain. " +
        "So HTTPS from Chrome stays an encrypted tunnel here (host and bytes only); plain HTTP shows in full.",
    );
  });

  it("Chrome on Linux: the google-chrome command, and NSS instead of the Keychain", () => {
    const [proxy, cert] = guideSections("chrome", { ...MAC, app: "Google Chrome", platform: "linux" });
    expect(proxy.steps[0].code).toBe("google-chrome --proxy-server=127.0.0.1:51234");
    expect(cert.steps[0].text).toBe(
      "Chrome trusts its own NSS store (~/.pki/nssdb), not a CA file — the IDE never writes there. " +
        "So HTTPS from Chrome stays an encrypted tunnel here (host and bytes only); plain HTTP shows in full.",
    );
  });

  it("Chrome on Windows: `start chrome`, and the Windows certificate store instead of the Keychain", () => {
    const [proxy, cert] = guideSections("chrome", { ...MAC, app: "chrome", platform: "windows" });
    expect(proxy.steps[0].code).toBe("start chrome --proxy-server=127.0.0.1:51234");
    expect(cert.decryptSwitch).toBeUndefined();
    expect(cert.steps[0].text).toBe(
      "Chrome trusts the Windows certificate store, not a CA file — and the IDE never writes there. " +
        "So HTTPS from Chrome stays an encrypted tunnel here (host and bytes only); plain HTTP shows in full.",
    );
  });

  it("anything else on Windows: PowerShell assignments, the BUNDLE for the replacing variables, and Schannel said plainly", () => {
    const caPath = "C:\\Users\\sam\\AppData\\Roaming\\com.agentstudio.app\\netcap\\ca.pem";
    expect(guideSections("generic", { app: "gazelle", port: 51234, caPath, platform: "windows" })).toEqual([
      {
        title: "Proxy",
        steps: [
          {
            text: "Start gazelle from a PowerShell window after setting the proxy in its environment (most HTTP libraries honour these):",
            code: '$env:HTTPS_PROXY="http://127.0.0.1:51234"; $env:HTTP_PROXY="http://127.0.0.1:51234"',
          },
        ],
      },
      {
        title: "Certificate (HTTPS contents)",
        steps: [
          {
            text:
              "Point its TLS trust at the IDE's CA bundle too (Python and other OpenSSL-based tools read SSL_CERT_FILE, " +
              "Python's requests REQUESTS_CA_BUNDLE, Node NODE_EXTRA_CA_CERTS):",
            code:
              '$env:SSL_CERT_FILE="C:\\Users\\sam\\AppData\\Roaming\\com.agentstudio.app\\netcap\\ca-bundle.pem"; ' +
              '$env:REQUESTS_CA_BUNDLE="C:\\Users\\sam\\AppData\\Roaming\\com.agentstudio.app\\netcap\\ca-bundle.pem"; ' +
              '$env:NODE_EXTRA_CA_CERTS="C:\\Users\\sam\\AppData\\Roaming\\com.agentstudio.app\\netcap\\ca.pem"',
          },
          {
            text:
              "Windows' own curl.exe, PowerShell and .NET apps trust the Windows certificate store instead, which " +
              "the IDE never writes — their HTTPS stays an encrypted tunnel here (host and bytes only).",
          },
        ],
        decryptSwitch: true,
      },
    ]);
  });

  it("anything else: HTTPS_PROXY/HTTP_PROXY in the environment, SSL_CERT_FILE + NODE_EXTRA_CA_CERTS for the CA", () => {
    expect(guideSections("generic", { ...MAC, app: "gazelle" })).toEqual([
      {
        title: "Proxy",
        steps: [
          {
            text: "Start gazelle from a shell with the proxy in its environment (most HTTP libraries honour these):",
            code: "HTTPS_PROXY=http://127.0.0.1:51234 HTTP_PROXY=http://127.0.0.1:51234",
          },
        ],
      },
      {
        title: "Certificate (HTTPS contents)",
        steps: [
          {
            text: "Point its TLS trust at the IDE's CA bundle too (OpenSSL/Python/curl read the first, Node the second):",
            // SSL_CERT_FILE REPLACES the trust store: ca.pem alone would fail every tunnel.
            code: "SSL_CERT_FILE=/cfg/netcap/ca-bundle.pem NODE_EXTRA_CA_CERTS=/cfg/netcap/ca.pem",
          },
        ],
        decryptSwitch: true,
      },
    ]);
  });

  it("with the proxy down and no CA file, the placeholders read as placeholders rather than `null`", () => {
    const down: GuideInputs = { app: "x", port: null, caPath: null, platform: "mac" };
    expect(guideSections("postman", down)[0].steps[1].code).toBe("<port>");
    expect(guideSections("postman", down)[1].steps[0].code).toBe("<the IDE's CA file>");
    expect(guideSections("insomnia", down)[0].steps[1].code).toBe("127.0.0.1:<port>");
    expect(guideSections("chrome", down)[0].steps[0].code).toBe('open -na "Google Chrome" --args --proxy-server=127.0.0.1:<port>');
    expect(guideSections("generic", down)[1].steps[0].code).toBe(
      "SSL_CERT_FILE=<the IDE's CA bundle> NODE_EXTRA_CA_CERTS=<the IDE's CA file>",
    );
  });

  it("the bundle is ca-bundle.pem beside ca.pem, in the CA path's own spelling", () => {
    expect(caBundlePath("/cfg/netcap/ca.pem")).toBe("/cfg/netcap/ca-bundle.pem");
    expect(caBundlePath("C:\\cfg\\netcap\\ca.pem")).toBe("C:\\cfg\\netcap\\ca-bundle.pem");
    expect(caBundlePath(null)).toBe("<the IDE's CA bundle>");
  });
});

/* ── routing state, the per-app decrypt switch, the moved port ───────────────────── */

const POSTMAN_MAIN = "/Applications/Postman.app/Contents/MacOS/Postman";
const POSTMAN_HELPER = "/Applications/Postman.app/Contents/Frameworks/Postman Helper.app/Contents/MacOS/Postman Helper";
const c = (name: string, path: string | null): FlowClient => ({ pid: 1, name, path });

describe("clientInApp — the mirror of Rust's user_opted_in (netcap/client.rs)", () => {
  // Every expectation is written out, independent of the implementation. The
  // rows mirror Rust's decision table so the guide and the proxy cannot disagree.
  it.each([
    ["Postman's own executable", c("Postman", POSTMAN_MAIN), "Postman", true],
    ["Postman Helper, inside Postman.app, counts as Postman", c("Postman Helper", POSTMAN_HELPER), "Postman", true],
    ["…and as its own nested bundle", c("Postman Helper", POSTMAN_HELPER), "Postman Helper", true],
    ["a name match with no path (Linux, unreadable exe)", c("insomnia", null), "insomnia", true],
    ["a name match on a path outside any bundle", c("gazelle", "/Users/me/gazelle/target/debug/gazelle"), "gazelle", true],
    ["a different bundle that merely starts with it", c("PostmanCanary", "/Applications/PostmanCanary.app/Contents/MacOS/PostmanCanary"), "Postman", false],
    ["case-sensitive, as in Rust", c("postman", "/Applications/postman.app/Contents/MacOS/postman"), "Postman", false],
    ["a path that names the app without `.app/`", c("node", "/Users/me/Postman/node"), "Postman", false],
    ["an unrelated client", c("curl", "/usr/bin/curl"), "Postman", false],
    ["an empty entry never matches (it would be any bundle)", c("Postman", POSTMAN_MAIN), "", false],
    ["a whitespace entry never matches", c(" ", "/x/ .app/y"), " ", false],
    ["an entry with a slash never matches (a path fragment)", c("Postman", POSTMAN_MAIN), "Applications/Postman", false],
  ] as const)("%s", (_what, client, app, want) => expect(clientInApp(client, app)).toBe(want));

  it("an unresolved client is nobody's", () => {
    expect(clientInApp(null, "Postman")).toBe(false);
  });

  it("validAppEntry", () => {
    expect([validAppEntry("Postman"), validAppEntry(""), validAppEntry("  "), validAppEntry("a/b")]).toEqual([true, false, false, false]);
  });
});

describe("appOfClient — the name an app goes by in decryptApps", () => {
  it.each([
    [c("Postman", POSTMAN_MAIN), "Postman"],
    [c("Postman Helper", POSTMAN_HELPER), "Postman"],
    [c("curl", "/usr/bin/curl"), "curl"],
    [c("insomnia", null), "insomnia"],
    [c("Code Helper", "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper"), "Visual Studio Code"],
  ] as const)("%o → %s", (client, want) => expect(appOfClient(client)).toBe(want));
});

describe("routingState — the guide's live line", () => {
  const conn = (remote: string | null): Pick<MachineConn, "remote"> => ({ remote });
  const postmanRow = { name: "Postman", connections: [conn("151.101.1.69:443"), conn("127.0.0.1:8877"), conn(null), conn("[::1]:8877"), conn("10.0.0.9:443")] };

  it("receiving: counts every flow from inside the app — Postman Helper included — and names the processes, sorted", () => {
    const flows = [
      { client: c("Postman Helper", POSTMAN_HELPER) },
      { client: c("curl", "/usr/bin/curl") },
      { client: c("Postman", POSTMAN_MAIN) },
      { client: null },
      { client: c("Postman Helper", POSTMAN_HELPER) },
    ];
    expect(routingState(flows, postmanRow, 8877)).toEqual({ kind: "receiving", count: 3, processes: ["Postman", "Postman Helper"] });
  });

  it("direct: nothing routed yet; counts the sockets to someone other than the proxy (not listeners, not the proxy itself)", () => {
    expect(routingState([{ client: c("curl", "/usr/bin/curl") }], postmanRow, 8877)).toEqual({ kind: "direct", connections: 2 });
    // With the proxy down, a socket to 127.0.0.1:8877 is just another connection.
    expect(routingState([], postmanRow, null)).toEqual({ kind: "direct", connections: 4 });
    expect(routingState([], { name: "Postman", connections: [] }, 8877)).toEqual({ kind: "direct", connections: 0 });
  });
});

describe("decryptTarget — which entry the switch writes", () => {
  it("the bundle of the first routed flow, so a Helper row opts in all of Postman", () => {
    expect(decryptTarget([{ client: c("curl", "/usr/bin/curl") }, { client: c("Postman Helper", POSTMAN_HELPER) }], "Postman Helper")).toBe("Postman");
  });
  it("the row's own name when nothing has been routed", () => {
    expect(decryptTarget([{ client: null }, { client: c("curl", "/usr/bin/curl") }], "Postman Helper")).toBe("Postman Helper");
  });
});

describe("the routing, decrypt-switch and moved-port words", () => {
  it("the switch's label and hover — including that HTTPS fails without the certificate step", () => {
    expect(decryptSwitchLabel("Postman")).toBe("I added the IDE's certificate in Postman — decrypt its HTTPS");
    expect(decryptSwitchTitle("Postman")).toBe(
      "Tell the capture proxy that Postman trusts the IDE's certificate, so its HTTPS is decrypted (paths, headers, bodies). " +
        "Needs Decrypt HTTPS on in the IDE traffic header. Do the certificate step above first: without it, " +
        "Postman's HTTPS requests will fail, because Postman won't trust the certificate the proxy presents.",
    );
  });
  it("the moved port and the stable port", () => {
    expect(portChangedText({ from: 8877, to: 60123 })).toBe(
      "The proxy moved from :8877 to :60123 (port 8877 was busy) — update the port in apps you configured by hand.",
    );
    expect(PORT_STABLE).toBe("This port stays the same across restarts.");
  });
});
