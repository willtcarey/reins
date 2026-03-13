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

import type { ServerState, WsClient } from "./state.js";
import { ensureSessionOpen, runManualCompaction } from "./sessions.js";
import { getSession } from "./session-store.js";
import { getProject } from "./project-store.js";
import { createBroadcastExcluding } from "./models/broadcast.js";

function sendToWs(ws: any, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // ignore send errors on closed sockets
  }
}

/**
 * Resolve the project directory for a session ID.
 */
function resolveProjectDir(sessionId: string): string | null {
  const row = getSession(sessionId);
  if (!row) return null;
  const project = getProject(row.project_id);
  return project?.path ?? null;
}

async function handleWsCommand(
  state: ServerState,
  client: WsClient,
  raw: string,
): Promise<void> {
  let cmd: { type: string; sessionId?: string; message?: string };
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

  if (!cmd.sessionId) {
    sendToWs(client.ws, { type: "error", error: "Missing sessionId" });
    return;
  }

  switch (cmd.type) {
    case "prompt": {
      if (!cmd.message) { sendToWs(client.ws, { type: "error", error: "Missing message field" }); return; }
      try {
        const row = getSession(cmd.sessionId);
        if (!row) { sendToWs(client.ws, { type: "error", error: "Session not found" }); return; }
        const project = getProject(row.project_id);
        if (!project) { sendToWs(client.ws, { type: "error", error: "Session not found" }); return; }
        const managed = await ensureSessionOpen(state, cmd.sessionId, project.path);
        sendToWs(client.ws, { type: "ack", command: "prompt" });

        // Broadcast user message to other clients so other devices see what was typed
        // (the sender already appended it optimistically)
        const broadcast = createBroadcastExcluding(state.clients, client);
        broadcast({
          type: "user_message",
          sessionId: cmd.sessionId,
          projectId: row.project_id,
          message: cmd.message,
        });

        // Handle /compact as a slash command
        const compactMatch = cmd.message.match(/^\/compact\s*(.*)?$/);
        if (compactMatch) {
          const instructions = compactMatch[1]?.trim() || undefined;
          await runManualCompaction(state, managed, cmd.sessionId, row.project_id, instructions);
        } else {
          await managed.session.prompt(cmd.message);
        }
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `prompt failed: ${err.message}` });
      }
      break;
    }

    case "steer": {
      if (!cmd.message) { sendToWs(client.ws, { type: "error", error: "Missing message field" }); return; }
      try {
        const projectDir = resolveProjectDir(cmd.sessionId);
        if (!projectDir) { sendToWs(client.ws, { type: "error", error: "Session not found" }); return; }
        const managed = await ensureSessionOpen(state, cmd.sessionId, projectDir);
        sendToWs(client.ws, { type: "ack", command: "steer" });
        await managed.session.steer(cmd.message);
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `steer failed: ${err.message}` });
      }
      break;
    }

    case "abort": {
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
