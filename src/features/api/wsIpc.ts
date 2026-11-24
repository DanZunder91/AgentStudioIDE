/**
 * WebSocket IPC — typed wrapper for the API client's live WS/WSS console.
 *
 * The streaming half mirrors `editor/lsp/transport.ts`: a client-side
 * `Channel<string>` is created here, its `onmessage` wired to the caller's
 * `onEvent`, and handed to `ws_connect`. Rust pushes each socket event as a JSON
 * string frame (`WsEvent`); we parse it once, at this boundary, so the rest of
 * the frontend deals in a typed union rather than raw text. `ws_connect` resolves
 * the `connectionId` used to address `ws_send`/`ws_close`.
 *
 * Kept feature-local so the wire types live next to their feature. These types are
 * the EXACT wire contract the Rust `ws_*` commands implement, mirrored by their serde
 * structs.
 *
 * Secret-safety: every frame crosses the boundary in memory only —
 * nothing here writes a URL or a message to disk. Handshake header values cross
 * as the LITERAL `{{VAR}}` template the user typed; Rust resolves them against
 * the Vault, so the token itself never crosses IPC at all.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * One event from the socket, as Rust serializes it (a JSON string on the
 * channel). `open` on connect, `message` per inbound frame, `closed` on a clean
 * or remote close (`code`/`reason` when the peer supplied them), `error` on a
 * transport failure.
 */
export type WsEvent =
  | { kind: "open" }
  | { kind: "message"; data: string }
  | { kind: "closed"; code: number | null; reason: string }
  | { kind: "error"; message: string };

/**
 * One opening-handshake header — a WebSocket handshake IS an HTTP request, so a
 * server that authenticates the upgrade needs these (without them: a 401).
 *
 * 🔴 `value` is the LITERAL template the user typed, `{{VAR}}` and all. It is
 * NOT substituted here, and must not be substituted by the caller either: the
 * Vault lookup happens in Rust (`ws.rs`'s `substitute` → `db::secret::resolve`),
 * which is the whole point of the secret-safety design — pre-resolving would put the real token
 * on the IPC boundary, the exact thing this design exists to avoid. Rust also
 * scrubs every resolved value out of its error events, which it can only do
 * because it is the one that resolved them.
 *
 * Same `{name, value}` row shape as `GrpcMetadata` (and the same `camelCase`
 * wire form), because it is the same header-row widget on both consoles.
 */
export interface WsHeader {
  name: string;
  value: string;
}

/**
 * `ws_connect` — open a socket to `url` and stream its events to `onEvent`.
 * Creates the `Channel<string>`, parses each raw JSON frame into a `WsEvent`, and
 * resolves the `connectionId` that `wsSend`/`wsClose` address. Rejects with a
 * string if the initial connect fails (the console surfaces it inline).
 *
 * `headers` are applied to the opening handshake. An **empty or omitted** list
 * leaves the `headers` key off the payload entirely, so the call is byte for byte
 * the pre-header one — Rust's `Option<Vec<WsHeader>>` deserializes the missing key
 * to `None` and never opens the Vault. That "absent, not `[]`" detail is the
 * negative control the tests pin: a version that always sent a (possibly empty)
 * array would still connect, and would still read the Vault file on every connect.
 *
 * A REJECTED header (bad name, bad value, a header the handshake writes itself, a
 * `{{VAR}}` the Vault has no value for) does not reject this promise — it arrives
 * as an `error` event on the channel, because it is a failure to *establish* the
 * socket and takes the same path as a refused connect.
 */
export function wsConnect(
  url: string,
  onEvent: (e: WsEvent) => void,
  headers?: WsHeader[],
): Promise<string> {
  const ch = new Channel<string>();
  ch.onmessage = (raw) => onEvent(JSON.parse(raw) as WsEvent);
  return invoke<string>("ws_connect", {
    url,
    ...(headers && headers.length > 0 ? { headers } : {}),
    onEvent: ch,
  });
}

/** `ws_send` — send `message` over the open connection. */
export async function wsSend(
  connectionId: string,
  message: string,
): Promise<void> {
  await invoke("ws_send", { connectionId, message });
}

/** `ws_close` — close the connection (idempotent on the Rust side). */
export async function wsClose(connectionId: string): Promise<void> {
  await invoke("ws_close", { connectionId });
}
