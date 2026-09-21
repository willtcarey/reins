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
import { ensureSessionOpen } from "./runtimes/session-manager.js";
import { getSession } from "./session-store.js";
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
  let cmd: { type?: unknown; sessionId?: unknown; clientId?: unknown; message?: unknown };
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

  const sessionId = cmd.sessionId;
  const sendError = (error: string, clientId?: string) => {
    sendToWs(client.ws, { type: "error", sessionId, ...(clientId ? { clientId } : {}), error });
  };

  switch (cmd.type) {
    case "prompt":
    case "steer": {
      const command = cmd.type;
      const requestClientId = typeof cmd.clientId === "string" && cmd.clientId.length > 0
        ? cmd.clientId
        : undefined;
      if (cmd.message === undefined) { sendError("Missing message field", requestClientId); return; }
      if (!requestClientId) { sendError("Missing clientId"); return; }
      const clientId = requestClientId;
      let message: ClientPromptContent;
      try {
        message = parseClientPromptContent(cmd.message);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        sendError(`Invalid message field: ${detail}`, clientId);
        return;
      }
      try {
        if (!getSession(sessionId)) { sendError("Session not found", clientId); return; }
        const managed = await ensureSessionOpen(state, sessionId);
        if (command === "prompt") await managed.runtime.prompt(message, { reinsId: clientId });
        else await managed.runtime.steer(message, { reinsId: clientId });
        sendToWs(client.ws, { type: "ack", command, clientId });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        sendError(`${command} failed: ${errorMessage}`, clientId);
      }
      break;
    }

    case "abort": {
      const managed = state.sessions.get(sessionId);
      if (!managed) { sendError("Session not active"); return; }
      managed.lastActivity = Date.now();
      sendToWs(client.ws, { type: "ack", command: "abort" });
      try {
        await managed.runtime.abort();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        sendError(`abort failed: ${message}`);
      }
      break;
    }

    default: {
      sendError(`Unknown command: ${cmd.type}`);
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
