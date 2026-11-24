/**
 * A throwaway HTTP server for the Network spec, bound to this machine's NON-loopback IPv4.
 *
 * Why not 127.0.0.1 like http-fixture.ts: IDE terminals get `NO_PROXY=…,localhost,127.0.0.1,::1`,
 * so a loopback request would bypass the capture proxy
 * and the Network view would rightly show nothing. A private interface address (inside the
 * Docker container: the bridge IP) is routed through the proxy, yet the packets never leave
 * the machine — the server and the client are both local.
 *
 * Node's built-in `http` only; the wdio worker (same host/container as the app) runs it, so
 * the spec needs nothing from the image beyond what the IDE terminal already has (curl).
 */

import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";

export const PROBE_PATH = "/e2e-probe";
export const PROBE_HEADER = "x-agentstudio-e2e-probe";
export const PROBE_HEADER_VALUE = "probe-ok";

export interface ProbeServer {
  host: string;
  port: number;
  url: string;
  /** Requests the server has answered, as `METHOD path`. */
  hits: string[];
  close: () => Promise<void>;
}

/** The first non-internal IPv4 address, or throw — a loopback-only box cannot run this spec. */
export function nonLoopbackIPv4(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  throw new Error("no non-loopback IPv4 interface: the Network spec needs one so the request goes through the proxy");
}

export async function startProbeServer(): Promise<ProbeServer> {
  const host = nonLoopbackIPv4();
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === PROBE_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain", [PROBE_HEADER]: PROBE_HEADER_VALUE });
      res.end("probe body\n");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    host,
    port,
    url: `http://${host}:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
