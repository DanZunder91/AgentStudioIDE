/** Deterministic HTTP server for the API spec (seam S7) on 127.0.0.1:0, so parallel runs never
 * collide: GET /health canned JSON, POST /echo echoes method and body, anything else 404. */

import http from "node:http";
import type { AddressInfo } from "node:net";

/** The canned GET body. Exported so the spec asserts on the exact same bytes. */
export const GET_BODY = { ok: true, fixture: "get" } as const;

export interface HttpFixture {
  /** The base URL, e.g. `http://127.0.0.1:54321`. */
  url: string;
  /** The bound ephemeral port. */
  port: number;
  /** Close the server (idempotent). */
  close: () => Promise<void>;
}

/** Read a request body to a string (bounded by node's default socket limits). */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Start the fixture server and resolve once it is listening. */
export async function startHttpFixture(): Promise<HttpFixture> {
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && req.url === "/health") {
      json(200, GET_BODY);
      return;
    }
    if (req.method === "POST" && req.url === "/echo") {
      void readBody(req).then((body) => {
        json(200, { echoed: body, method: req.method });
      });
      return;
    }
    json(404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
