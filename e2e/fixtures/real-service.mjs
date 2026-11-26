#!/usr/bin/env node
/** Real local service the specs start inside an IDE terminal, so the IDE sees it via real paths.
 * Routes: /health, /upstream[?fail=1] (child curl), /selfcall (this process, via $HTTP_PROXY when
 * set). Loopback only; port $SVC_PORT (47819). */

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

/** Proxied by hand (absolute URI + Proxy-Authorization, as curl does) so every Node behaves alike.
 * Own agent: where Node honours NODE_USE_ENV_PROXY (the IDE sets it), the global agent would send
 * this hand-made proxy request through the proxy again. */
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
