/**
 * WebSocket Handlers
 *
 * Handles browser WebSocket messages and command dispatch; the process owner (`server-process.ts`)
 * registers and unregisters the sockets in `state.clients`. Commands: prompt, steer, abort — each requires
 * sessionId.
 *
 * Sessions run on nodes: prompt/steer are queued in the command outbox (`Sessions.submit`); abort calls
 * the session's node directly (`Sessions.abort`).
 */

import type { ServerState, WsClient, WebSocketLike } from "./state.js";
import { Models } from "./models/models.js";
import { getSession } from "./session-store.js";
import { logger } from "./logger.js";
import type { ClientPromptContent } from "./messages-store.js";
import { parseClientPromptContent } from "./session-attachments-store.js";
import { observeSubmission } from "./nodes/node-command-notifications.js";

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
  const models = new Models(state);
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
        observeSubmission(client, sessionId, clientId);
        models.sessions.submit(sessionId, { op: command, content: message, clientId });
        sendToWs(client.ws, { type: "ack", command, clientId });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        sendError(`${command} failed: ${errorMessage}`, clientId);
      }
      break;
    }

    case "abort": {
      // Abort always goes to the session's node: it aborts a live run and answers `aborted: false`
      // when none is running.
      if (!getSession(sessionId)) { sendError("Session not active"); return; }
      sendToWs(client.ws, { type: "ack", command: "abort" });
      try {
        await models.sessions.abort(sessionId);
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

/** A message from browser socket `ws`. The process owner registers its sockets in `state.clients` (they
 * outlive a handler reload), so the sender is looked up there; an unregistered socket is ignored. */
export function handleWsMessage(state: ServerState, ws: WebSocketLike, message: string | Buffer): void {
  const client = [...state.clients].find(candidate => candidate.ws === ws);
  if (!client) return;
  const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
  handleWsCommand(state, client, raw).catch((err) => {
    logger.error("WebSocket command error:", err);
    sendToWs(ws, { type: "error", error: "Internal server error" });
  });
}

