/**
 * WebSocket Handlers
 *
 * Handles WebSocket lifecycle (open/message/close) and command dispatch.
 * Commands: prompt, steer, abort — each requires sessionId.
 *
 * Sessions are backed by SQLite; the WS layer ensures they're open in memory
 * before dispatching commands. The projectDir is needed to resume a session
 * (tools need a cwd), so it's resolved from the project the session belongs to.
 */

import type { ServerState, WsClient, WebSocketLike } from "./state.js";
import { ensureSessionOpen } from "./runtimes/sessions-manager.js";
import { getSession } from "./session-store.js";
import { createBroadcastExcluding } from "./models/broadcast.js";
import { logger } from "./logger.js";
import type { ClientPromptContent } from "./messages-store.js";
import { parseClientPromptContent } from "./session-attachments-store.js";

/** Maps raw WebSocket objects to their WsClient wrappers. */
const wsClientMap = new WeakMap<WebSocketLike, WsClient>();

function sendToWs(ws: WebSocketLike, data: unknown): void {
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
  let cmd: { type?: unknown; sessionId?: unknown; message?: unknown };
  try {
    cmd = JSON.parse(raw);
  } catch {
    sendToWs(client.ws, { type: "error", error: "Invalid JSON" });
    return;
  }

  // Heartbeat ping — no sessionId required
  if (cmd.type === "ping") {
    sendToWs(client.ws, { type: "pong" });
    return;
  }

  if (typeof cmd.sessionId !== "string" || cmd.sessionId.length === 0) {
    sendToWs(client.ws, { type: "error", error: "Missing sessionId" });
    return;
  }

  switch (cmd.type) {
    case "prompt": {
      if (cmd.message === undefined) { sendToWs(client.ws, { type: "error", error: "Missing message field" }); return; }
      const sessionId = cmd.sessionId;
      let message: ClientPromptContent;
      try {
        message = parseClientPromptContent(cmd.message);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        sendToWs(client.ws, { type: "error", error: `Invalid message field: ${detail}` });
        return;
      }
      try {
        const row = getSession(sessionId);
        if (!row) { sendToWs(client.ws, { type: "error", error: "Session not found" }); return; }
        const managed = await ensureSessionOpen(state, sessionId);

        sendToWs(client.ws, { type: "ack", command: "prompt" });

        // Broadcast the raw user message to other clients so other devices see
        // what was typed. Skill content is not expanded into the visible copy.
        const broadcast = createBroadcastExcluding(state.clients, client);
        broadcast({
          type: "user_message",
          sessionId,
          projectId: row.project_id,
          message,
        });

        void managed.runtime.prompt(message).catch((err: unknown) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          sendToWs(client.ws, { type: "error", error: `prompt failed: ${errorMessage}` });
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        sendToWs(client.ws, { type: "error", error: `prompt failed: ${errorMessage}` });
      }
      break;
    }

    case "steer": {
      if (cmd.message === undefined) { sendToWs(client.ws, { type: "error", error: "Missing message field" }); return; }
      const sessionId = cmd.sessionId;
      let message: ClientPromptContent;
      try {
        message = parseClientPromptContent(cmd.message);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        sendToWs(client.ws, { type: "error", error: `Invalid message field: ${detail}` });
        return;
      }
      try {
        if (!getSession(sessionId)) { sendToWs(client.ws, { type: "error", error: "Session not found" }); return; }
        const managed = await ensureSessionOpen(state, sessionId);

        sendToWs(client.ws, { type: "ack", command: "steer" });
        await managed.runtime.steer(message);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        sendToWs(client.ws, { type: "error", error: `steer failed: ${errorMessage}` });
      }
      break;
    }

    case "abort": {
      const managed = state.sessions.get(cmd.sessionId);
      if (!managed) { sendToWs(client.ws, { type: "error", error: "Session not active" }); return; }
      managed.lastActivity = Date.now();
      sendToWs(client.ws, { type: "ack", command: "abort" });
      try {
        await managed.runtime.abort();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        sendToWs(client.ws, { type: "error", error: `abort failed: ${message}` });
      }
      break;
    }

    default: {
      sendToWs(client.ws, { type: "error", error: `Unknown command: ${cmd.type}` });
    }
  }
}

export function handleWsOpen(state: ServerState, ws: WebSocketLike): void {
  const client: WsClient = { ws };
  state.clients.add(client);
  wsClientMap.set(ws, client);
  logger.info(`WebSocket client connected (total: ${state.clients.size})`);
}

export function handleWsMessage(state: ServerState, ws: WebSocketLike, message: string | Buffer): void {
  const client = wsClientMap.get(ws);
  if (!client) return;
  const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
  handleWsCommand(state, client, raw).catch((err) => {
    logger.error("WebSocket command error:", err);
    sendToWs(ws, { type: "error", error: "Internal server error" });
  });
}

export function handleWsClose(state: ServerState, ws: WebSocketLike): void {
  const client = wsClientMap.get(ws);
  if (client) {
    state.clients.delete(client);
  }
  logger.info(`WebSocket client disconnected (total: ${state.clients.size})`);
}
