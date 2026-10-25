/**
 * WebSocket Handlers
 *
 * The browser socket carries the server's broadcasts (session events, session and node updates); the
 * process owner (`server-process.ts`) registers and unregisters the sockets (they outlive an app) and hands
 * each browser message to the running app. The browser sends only the heartbeat's `ping`: session operations
 * (prompt, steer, abort) are HTTP routes (`routes/sessions.ts`).
 */

import type { WebSocketLike } from "./state.js";

function sendToWs(ws: WebSocketLike, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // ignore send errors on closed sockets
  }
}

/** A message from browser socket `ws`, which the process registered. */
export function handleWsMessage(ws: WebSocketLike, message: string | Buffer): void {
  const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
  let cmd: { type?: unknown };
  try {
    cmd = JSON.parse(raw);
  } catch {
    sendToWs(ws, { type: "error", error: "Invalid JSON" });
    return;
  }
  if (cmd.type === "ping") sendToWs(ws, { type: "pong" });
  else sendToWs(ws, { type: "error", error: `Unknown command: ${String(cmd.type)}` });
}
