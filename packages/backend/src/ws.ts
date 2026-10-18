/**
 * WebSocket Handlers
 *
 * Handles browser WebSocket messages and command dispatch; the process owner (`server-process.ts`)
 * registers and unregisters the sockets (they outlive an app) and hands each browser message to the
 * running app. Commands: prompt, steer, abort — each requires sessionId.
 *
 * Sessions run on the server (ADR-029): prompt/steer are submitted to the session's runtime
 * (`Sessions.submit`) and acknowledged once Pi committed them, or answered with their error; abort acts on
 * its live runtime (`Sessions.abort`).
 */

import type { AppState, WebSocketLike } from "./state.js";
import { Models } from "./models/models.js";
import { getSession } from "./session-store.js";
import { logger } from "./logger.js";
import type { ClientPromptContent } from "./messages-store.js";
import { parseClientPromptContent } from "./session-attachments-store.js";

function sendToWs(ws: WebSocketLike, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // ignore send errors on closed sockets
  }
}

async function handleWsCommand(
  state: AppState,
  ws: WebSocketLike,
  raw: string,
): Promise<void> {
  let cmd: { type?: unknown; sessionId?: unknown; clientId?: unknown; message?: unknown };
  try {
    cmd = JSON.parse(raw);
  } catch {
    sendToWs(ws, { type: "error", error: "Invalid JSON" });
    return;
  }

  // Heartbeat ping — no sessionId required
  if (cmd.type === "ping") {
    sendToWs(ws, { type: "pong" });
    return;
  }

  if (typeof cmd.sessionId !== "string" || cmd.sessionId.length === 0) {
    sendToWs(ws, { type: "error", error: "Missing sessionId" });
    return;
  }

  const sessionId = cmd.sessionId;
  const models = new Models(state);
  const sendError = (error: string, clientId?: string) => {
    sendToWs(ws, { type: "error", sessionId, ...(clientId ? { clientId } : {}), error });
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
        await models.sessions.submit(sessionId, { op: command, content: message, clientId });
        sendToWs(ws, { type: "ack", command, clientId });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        sendError(`${command} failed: ${errorMessage}`, clientId);
      }
      break;
    }

    case "abort": {
      // Abort acts on the session's live runtime, if it has one.
      if (!getSession(sessionId)) { sendError("Session not active"); return; }
      sendToWs(ws, { type: "ack", command: "abort" });
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

/** A message from browser socket `ws`, which the process registered: replies go to it, broadcasts to
 * every browser connection. */
export function handleWsMessage(state: AppState, ws: WebSocketLike, message: string | Buffer): void {
  const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
  handleWsCommand(state, ws, raw).catch((err) => {
    logger.error("WebSocket command error:", err);
    sendToWs(ws, { type: "error", error: "Internal server error" });
  });
}

