/** The tunnel card's sentences, one case at a time (tunnelExplain.ts). */

import { describe, expect, it } from "vitest";

import type { FlowSummary } from "./networkTypes";
import {
  BYPASS_REASON_TEXT,
  bypassNeutralizedText,
  bypassReasonText,
  isCurlCommand,
  looksLikeRust,
  noteKind,
  OWN_ROOTS_WHY,
  RUSTLS_WHY,
  tunnelGroup,
  tunnelWhy,
} from "./tunnelExplain";

const GAZELLE = { pid: 4242, name: "gazelle", path: "/Users/dev/gazelle/target/debug/gazelle" };
const WGET = { pid: 51, name: "wget", path: "/usr/bin/wget" };

function flow(id: number, o: Partial<FlowSummary> = {}): FlowSummary {
  return {
    id, startedMs: 0, proto: "tunnel", method: "CONNECT", host: "geo.api.example.net", port: 443, path: "",
    status: null, grpcStatus: null, contentType: null, reqBytes: 100, resBytes: 1000, durationMs: 30_000,
    state: "done", error: null, terminalId: "0000eeee-1", httpVersion: "", wsMessages: null, client: GAZELLE,
    note: null, ...o,
  };
}

describe("looksLikeRust", () => {
  it.each([
    ["/Users/dev/gazelle/target/debug/gazelle", true],
    ["/w/app/target/release/app", true],
    ["/w/app/target/aarch64-apple-darwin/release/app", true],
    ["/Users/dev/.cargo/bin/gazelle", true],
    ["/usr/bin/wget", false],
    ["/w/target/debug", false], // the directory itself is not a binary in it
  ])("%s → %s", (path, want) => expect(looksLikeRust({ path })).toBe(want));

  it("an unknown client or path is not guessed at", () => {
    expect(looksLikeRust(null)).toBe(false);
    expect(looksLikeRust({ path: null })).toBe(false);
  });
});

describe("noteKind reads Rust's notes back (netcap::client)", () => {
  it.each([
    [null, "none"],
    ["", "none"],
    ["not decrypted: gazelle doesn't read the IDE's CA", "not-on-list"],
    ["not decrypted: couldn't identify the client process", "unknown-client"],
    ["not decrypted: curl refused the IDE's certificate for this host earlier", "refused-earlier"],
    ["not decrypted: something new", "other"],
  ] as const)("%s → %s", (note, want) => expect(noteKind(note)).toBe(want));
});

describe("tunnelWhy", () => {
  const on = { decrypt: true };
  it("gazelle: not on the decrypt list, and the rustls reason", () => {
    expect(tunnelWhy(flow(1, { note: "not decrypted: gazelle doesn't read the IDE's CA" }), on)).toBe(
      `gazelle isn't on the decrypt list: it doesn't read the IDE's certificate, so the proxy passes its HTTPS through untouched instead of breaking it. ${RUSTLS_WHY}`,
    );
  });

  it("a non-Rust client gets the general own-roots reason", () => {
    expect(tunnelWhy(flow(1, { client: WGET, note: "not decrypted: wget doesn't read the IDE's CA" }), on)).toBe(
      `wget isn't on the decrypt list: it doesn't read the IDE's certificate, so the proxy passes its HTTPS through untouched instead of breaking it. ${OWN_ROOTS_WHY}`,
    );
  });

  it("an unidentified client, one that refused earlier, and a note it does not know", () => {
    expect(tunnelWhy(flow(1, { client: null, note: "not decrypted: couldn't identify the client process" }), on)).toMatch(
      /^The proxy couldn't tell which process opened this connection/,
    );
    expect(tunnelWhy(flow(1, { client: null, note: "not decrypted: the client refused the IDE's certificate for this host earlier" }), on)).toBe(
      `The client refused the IDE's certificate for this host earlier, so its later connections here are passed through untouched. ${OWN_ROOTS_WHY}`,
    );
    expect(tunnelWhy(flow(1, { note: "not decrypted: a future reason" }), on)).toBe("Not decrypted: a future reason.");
  });

  it("no note: Decrypt HTTPS off says so; on, or not known yet, never claims it is off", () => {
    expect(tunnelWhy(flow(1), { decrypt: false })).toBe(
      "Decrypt HTTPS is off, so every HTTPS connection is passed through as an encrypted tunnel.",
    );
    expect(tunnelWhy(flow(1), on)).toBe("The proxy relayed this connection as-is, without decrypting it.");
    expect(tunnelWhy(flow(1), null)).toBe("The proxy relayed this connection as-is, without decrypting it.");
  });
});

describe("bypass sentences", () => {
  it.each([
    ["curl -s --noproxy '*' http://x", true],
    ["cd /w && curl http://x", true],
    ["/usr/bin/curl http://x", true],
    ["(curl x)", true],
    ["NO_PROXY='*' python3 probe.py", false],
    ["curlie get x", false],
    ["echo curl", true], // DECIDED: a word match, not a shell parser — errs toward not showing the note
  ])("isCurlCommand(%s) = %s", (cmd, want) => expect(isCurlCommand(cmd)).toBe(want));

  it("a neutralised bypass names its reasons, or none", () => {
    expect(bypassNeutralizedText(["--noproxy", "NO_PROXY=*"])).toMatch(/^This command tried to skip the IDE proxy \(--noproxy, NO_PROXY=\*\)\. /);
    expect(bypassNeutralizedText([])).toMatch(/^This command tried to skip the IDE proxy\. With/);
  });
});

describe("tunnelGroup — repeated tunnels from one process to one host", () => {
  it("counts the same pid + host + port, sums bytes, counts the open ones", () => {
    const flows = [
      flow(1),
      flow(2, { state: "pending", reqBytes: 5, resBytes: 7 }),
      flow(3, { client: { ...GAZELLE, pid: 1 } }), // another pid
      flow(4, { port: 8443 }), // another port
      flow(5, { host: "mirror1.example.net" }), // another host
      flow(6, { proto: "https" }), // not a tunnel
    ];
    expect(tunnelGroup(flows, flows[0])).toEqual({ count: 2, open: 1, reqBytes: 105, resBytes: 1007 });
  });

  it("an unknown client groups by terminal, never with a known one", () => {
    const flows = [flow(1, { client: null }), flow(2, { client: null }), flow(3, { client: null, terminalId: "x" }), flow(4)];
    expect(tunnelGroup(flows, flows[0]).count).toBe(2);
  });
});

describe("bypassReasonText — every reason Rust reports, in words", () => {
  // The reasons `logstream::bypass::R_*` emits, restated as literals.
  const RUST_REASONS = [
    "--noproxy",
    "-x ''",
    "NO_PROXY=*",
    "NO_PROXY=",
    "*_PROXY=''",
    "unset *_proxy",
    "env -u *_proxy",
    "env -i",
    "--no-proxy",
    "PowerShell 5.1 web cmdlet",
    "-NoProxy",
  ];

  it("has a sentence for each, and no sentence for a reason Rust never sends", () => {
    expect(Object.keys(BYPASS_REASON_TEXT).sort()).toEqual([...RUST_REASONS].sort());
    for (const r of RUST_REASONS) expect(bypassReasonText(r)).toBe(BYPASS_REASON_TEXT[r]);
  });

  it("Windows PowerShell 5.1: nothing asked to skip the proxy — say why, and what to use instead", () => {
    const s = bypassReasonText("PowerShell 5.1 web cmdlet");
    expect(s).toMatch(/Windows PowerShell 5\.1's web cmdlets .* ignore the proxy variables/);
    expect(s).toContain("use curl.exe or PowerShell 7 (pwsh)");
    expect(bypassReasonText("-NoProxy")).toContain("-NoProxy");
  });

  it("a reason this build does not know is still shown, as Rust spelled it", () => {
    expect(bypassReasonText("future --thing")).toBe("It skipped the IDE proxy (future --thing).");
  });
});