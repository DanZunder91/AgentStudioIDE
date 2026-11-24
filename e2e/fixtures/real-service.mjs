#!/usr/bin/env node
/**
 * A small, REAL local service for the real-service E2E specs (e2e/specs/real-service*.e2e.ts).
 *
 * It is started by the spec INSIDE an IDE terminal, exactly as a user (or an agent) would start
 * their own service, so everything the IDE shows about it comes through the product's real
 * paths: its stdout is PTY output (→ Agent logs), calls to it go through the terminal's injected
 * proxy (→ Network), and its own outbound call is a child `curl` that inherits the same env.
 *
 *   GET /health            → 200 {"status":"ok"}          logs `<ISO> INFO svc: GET /health 200`
 *   GET /upstream          → shells out to `curl -s https://example.com/` (the only public host
 *                            the external spec allows); 200 + the upstream's size on success,
 *                            logs `INFO svc: upstream example.com 200` or `ERROR svc: upstream failed …`
 *   GET /upstream?fail=1   → a deterministic, LOCAL failure: curl to https://localhost:1/ (nothing
 *                            listens there), 502, logs `ERROR svc: upstream failed …` — no internet.
 *   GET /selfcall          → the service ITSELF (this node process, not a child curl) calls its own
 *                            /health — through $HTTP_PROXY when it is set, the way a proxy-aware
 *                            client does; directly when it is not. 200 {"selfcall":"proxy"|"direct"}.
 *                            The capture-guard E2E uses it: started with the proxy vars stripped,
 *                            the call bypasses Network; restarted with capture, it shows up as this
 *                            process's own request.
 *
 * Node built-ins only. Listens on loopback (the proxy captures loopback).
 * Port: $SVC_PORT (default 47819).
 */

import http from "node:http";
import { execFile } from "node:child_process";

const port = Number(process.env.SVC_PORT ?? "47819");
const log = (level, msg) => process.stdout.write(`${new Date().toISOString()} ${level} svc: ${msg}\n`);

function upstream(url, done) {
  // -f: an HTTP error is a failure too; -sS: quiet, but say why on failure.
  execFile("curl", ["-sS", "-f", "--max-time", "20", url], { maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
    if (err) done({ ok: false, why: (stderr || err.message).trim().split("\n")[0] });
    else done({ ok: true, body: stdout });
  });
}

/**
 * GET `http://localhost:${port}/health` from this process. Via $HTTP_PROXY (`http://user:pass@host:port`)
 * as an absolute-URI request with Proxy-Authorization, exactly what curl sends; else directly.
 * Node's own http client ignores proxy variables unless NODE_USE_ENV_PROXY is honoured (Node ≥ 24,
 * and 22 from 22.21), so the fixture does it by hand and behaves the same on every Node. Where Node
 * DOES honour it, the proxying lives on the global agent — and the IDE sets NODE_USE_ENV_PROXY=1 —
 * so this request gets an agent of its own: otherwise the hand-made proxy request is itself sent
 * through the proxy and fails (as it did on Node 22.23.5).
 */
const ownAgent = new http.Agent();
function selfcall(done) {
  const raw = process.env.HTTP_PROXY ?? process.env.http_proxy ?? "";
  const target = `http://localhost:${port}/health`;
  let opts = { host: "127.0.0.1", port, path: "/health", headers: { Host: `localhost:${port}` } };
  let via = "direct";
  if (raw !== "") {
    const p = new URL(raw);
    const auth = p.username === "" ? {} : { "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64")}` };
    opts = { host: p.hostname, port: Number(p.port), path: target, headers: { Host: `localhost:${port}`, ...auth } };
    via = "proxy";
  }
  const r = http.get({ ...opts, agent: ownAgent }, (res) => {
    res.resume();
    res.on("end", () => done({ ok: res.statusCode === 200, via }));
  });
  r.on("error", () => done({ ok: false, via }));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "X-Svc": "real-service" });
    res.end(JSON.stringify({ status: "ok" }));
    log("INFO", "GET /health 200");
    return;
  }
  if (req.method === "GET" && u.pathname === "/upstream") {
    const fail = u.searchParams.get("fail") === "1";
    upstream(fail ? "https://localhost:1/" : "https://example.com/", (r) => {
      if (r.ok) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ upstream: "example.com", bytes: r.body.length }));
        log("INFO", "upstream example.com 200");
      } else {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream failed" }));
        log("ERROR", `upstream failed ${fail ? "localhost:1" : "example.com"}: ${r.why}`);
      }
    });
    return;
  }
  if (req.method === "GET" && u.pathname === "/selfcall") {
    selfcall((r) => {
      res.writeHead(r.ok ? 200 : 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ selfcall: r.via, ok: r.ok }));
      log(r.ok ? "INFO" : "ERROR", `selfcall ${r.via} ${r.ok ? 200 : 502}`);
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found\n");
  log("WARN", `${req.method} ${u.pathname} 404`);
});

server.listen(port, "127.0.0.1", () => log("INFO", `listening on http://localhost:${port}`));
