/**
 * The `@codemirror/lsp-client` Transport, backed by our Tauri relay (M5).
 *
 * The Transport is a 3-method string interface — `send`/`subscribe`/`unsubscribe`
 * (JSON-RPC bodies). Outgoing → `lsp_send`; incoming ← the per-server
 * `Channel<String>` captured at `lsp_start`. Rust moves bytes; the client owns
 * the protocol. The channel is created here and handed to `lsp_start`; the
 * server id is bound once `lsp_start` returns.
 */

import { Channel } from "@tauri-apps/api/core";
import type { Transport } from "@codemirror/lsp-client";

import { lspSend } from "./lspIpc";

export interface LspConnection {
  /** Hand this to `lsp_start`; Rust fills it with server→client frames. */
  channel: Channel<string>;
  /** The Transport to hand to `LSPClient.connect`. */
  transport: Transport;
  /** Wire outgoing messages to this server id (known only after `lsp_start`). */
  bind(serverId: string): void;
  /** Deliver an incoming message to subscribers (what the channel calls). */
  deliver(message: string): void;
}

export function makeConnection(): LspConnection {
  const handlers = new Set<(message: string) => void>();
  const deliver = (message: string) => {
    for (const handler of handlers) handler(message);
  };

  const channel = new Channel<string>();
  channel.onmessage = deliver;

  let serverId: string | null = null;

  const transport: Transport = {
    send: (message) => {
      // Silently drop until bound: nothing should send before `lsp_start`
      // resolves. And a send that FAILS — the server exited, or the webview was
      // torn down so the relay is gone — must never surface as an unhandled
      // rejection: a dropped send is inert, the client keeps working.
      if (serverId !== null) void lspSend(serverId, message).catch(() => {});
    },
    subscribe: (handler) => {
      handlers.add(handler);
    },
    unsubscribe: (handler) => {
      handlers.delete(handler);
    },
  };

  return {
    channel,
    transport,
    bind: (id) => {
      serverId = id;
    },
    deliver,
  };
}
