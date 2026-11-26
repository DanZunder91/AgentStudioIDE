/** Wrappers for the Rust ws_* commands (the exact wire contract). Events stream over a
 * Channel<string>, as in editor/lsp/transport.ts, and are parsed into WsEvent once, here. Nothing
 * is written to disk; header values cross as the LITERAL {{VAR}} template; Rust resolves them. */

import { Channel, invoke } from "@tauri-apps/api/core";

/** Sent as JSON on the channel. closed covers clean and remote closes (code/reason when the peer
 * sent them); error is a transport failure. */
export type WsEvent =
  | { kind: "open" }
  | { kind: "message"; data: string }
  | { kind: "closed"; code: number | null; reason: string }
  | { kind: "error"; message: string };

/** A handshake header. value is the LITERAL template: never substitute it, here or in the caller.
 * Rust resolves it from the Vault (ws.rs) and scrubs resolved values from its error events. Same
 * row shape as GrpcMetadata. */
export interface WsHeader {
  name: string;
  value: string;
}

/** Rejects (a string) if the initial connect fails. Empty headers leave the key off the payload, so
 * Rust gets None and never opens the Vault (tests pin this). A rejected header arrives as an error
 * event, not a rejection. */
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
