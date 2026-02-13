/**
 * WebSocket Handlers
 *
 * Handles WebSocket lifecycle (open/message/close) and command dispatch.
 * Commands: prompt, steer, abort — each requires sessionId + sessionPath.
 */

import type { ServerState, WsClient } from "./state.js";
import { ensureSessionOpen } from "./sessions.js";

function sendToWs(ws: any, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // ignore send errors on closed sockets
  }
}

async function handleWsCommand(
  state: ServerState,
  client: WsClient,
  raw: string,
): Promise<void> {
  let cmd: { type: string; sessionId?: string; sessionPath?: string; message?: string };
  try {
    cmd = JSON.parse(raw);
  } catch {
    sendToWs(client.ws, { type: "error", error: "Invalid JSON" });
    return;
  }

  // All commands require sessionId + sessionPath
  if (!cmd.sessionId || !cmd.sessionPath) {
    sendToWs(client.ws, { type: "error", error: "Missing sessionId or sessionPath" });
    return;
  }

  switch (cmd.type) {
    case "prompt": {
      if (!cmd.message) { sendToWs(client.ws, { type: "error", error: "Missing message field" }); return; }
      try {
        const managed = await ensureSessionOpen(state, cmd.sessionId, cmd.sessionPath);
        sendToWs(client.ws, { type: "ack", command: "prompt" });
        await managed.session.prompt(cmd.message);
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `prompt failed: ${err.message}` });
      }
      break;
    }

    case "steer": {
      if (!cmd.message) { sendToWs(client.ws, { type: "error", error: "Missing message field" }); return; }
      try {
        const managed = await ensureSessionOpen(state, cmd.sessionId, cmd.sessionPath);
        sendToWs(client.ws, { type: "ack", command: "steer" });
        await managed.session.steer(cmd.message);
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `steer failed: ${err.message}` });
      }
      break;
    }

    case "abort": {
      // Abort only works on already-open sessions (no point opening to abort)
      const managed = state.sessions.get(cmd.sessionId!);
      if (!managed) { sendToWs(client.ws, { type: "error", error: "Session not active" }); return; }
      managed.lastActivity = Date.now();
      sendToWs(client.ws, { type: "ack", command: "abort" });
      try {
        await managed.session.abort();
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `abort failed: ${err.message}` });
      }
      break;
    }

    default: {
      sendToWs(client.ws, { type: "error", error: `Unknown command: ${cmd.type}` });
    }
  }
}

export function handleWsOpen(state: ServerState, ws: any): void {
  const client: WsClient = { ws };
  state.clients.add(client);
  (ws as any)._wsClient = client;

  console.log(`WebSocket client connected (total: ${state.clients.size})`);
}

export function handleWsMessage(state: ServerState, ws: any, message: string | Buffer): void {
  const client = (ws as any)._wsClient as WsClient;
  const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
  handleWsCommand(state, client, raw).catch((err) => {
    console.error("WebSocket command error:", err);
    sendToWs(ws, { type: "error", error: "Internal server error" });
  });
}

export function handleWsClose(state: ServerState, ws: any): void {
  const client = (ws as any)._wsClient as WsClient | undefined;
  if (client) {
    state.clients.delete(client);
  }
  console.log(`WebSocket client disconnected (total: ${state.clients.size})`);
}
