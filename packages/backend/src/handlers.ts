/**
 * Herald Request Handlers (hot-reloadable)
 *
 * All HTTP and WebSocket handler logic lives here. Functions receive a
 * ServerState object so they can access sessions, clients, and config
 * without owning them. The entry point (index.ts) holds the actual state
 * and can re-import this module to pick up code changes without losing
 * in-memory agent sessions.
 */

import { createAgentSession, createCodingTools, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { ServerState, ManagedSession, WsClient } from "./state.js";

// ---- Session helpers -------------------------------------------------------

export async function openSession(
  state: ServerState,
  sessionManager: SessionManager,
): Promise<ManagedSession> {
  const tools = createCodingTools(state.projectDir);
  const result = await createAgentSession({
    cwd: state.projectDir,
    tools,
    sessionManager,
    model: state.explicitModel,
  });

  const agentSession = result.session;
  const id = agentSession.sessionId;

  if (result.modelFallbackMessage) {
    console.warn(`  Model fallback: ${result.modelFallbackMessage}`);
  }

  const managed: ManagedSession = {
    session: agentSession,
    id,
    lastActivity: Date.now(),
  };

  // Subscribe to events — route to clients viewing this session
  agentSession.subscribe((event: AgentSessionEvent) => {
    const payload = JSON.stringify({ type: "event", event });
    for (const client of state.clients) {
      if (client.activeSessionId === id) {
        try { client.ws.send(payload); } catch {}
      }
    }
  });

  state.sessions.set(id, managed);
  console.log(`  Session opened: ${id} (total: ${state.sessions.size})`);
  return managed;
}

export async function getOrOpenSession(
  state: ServerState,
  sessionPath: string,
): Promise<ManagedSession> {
  for (const managed of state.sessions.values()) {
    if (managed.session.sessionFile === sessionPath) {
      managed.lastActivity = Date.now();
      return managed;
    }
  }

  const sessionManager = SessionManager.open(sessionPath);
  return openSession(state, sessionManager);
}

// ---- Payload builders ------------------------------------------------------

export function buildInitPayload(managed: ManagedSession) {
  const s = managed.session;
  return {
    type: "init" as const,
    data: {
      messages: s.messages,
      state: {
        model: s.model ? { provider: s.model.provider, id: s.model.id } : null,
        thinkingLevel: s.thinkingLevel,
        isStreaming: s.isStreaming,
        messageCount: s.messages.length,
      },
      sessionId: managed.id,
    },
  };
}

// ---- Helpers ---------------------------------------------------------------

function sendToWs(ws: any, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // ignore send errors on closed sockets
  }
}

function getClientSession(state: ServerState, client: WsClient): AgentSession | null {
  if (!client.activeSessionId) return null;
  return state.sessions.get(client.activeSessionId)?.session ?? null;
}

function touchActivity(state: ServerState, client: WsClient): void {
  if (!client.activeSessionId) return;
  const managed = state.sessions.get(client.activeSessionId);
  if (managed) managed.lastActivity = Date.now();
}

// ---- WebSocket command handler ---------------------------------------------

export async function handleWsCommand(
  state: ServerState,
  client: WsClient,
  raw: string,
): Promise<void> {
  let cmd: { type: string; message?: string; sessionPath?: string };
  try {
    cmd = JSON.parse(raw);
  } catch {
    sendToWs(client.ws, { type: "error", error: "Invalid JSON" });
    return;
  }

  switch (cmd.type) {
    case "prompt": {
      const session = getClientSession(state, client);
      if (!session) { sendToWs(client.ws, { type: "error", error: "No active session" }); return; }
      if (!cmd.message) { sendToWs(client.ws, { type: "error", error: "Missing message field" }); return; }
      touchActivity(state, client);
      sendToWs(client.ws, { type: "ack", command: "prompt" });
      try {
        await session.prompt(cmd.message);
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `prompt failed: ${err.message}` });
      }
      break;
    }

    case "steer": {
      const session = getClientSession(state, client);
      if (!session) { sendToWs(client.ws, { type: "error", error: "No active session" }); return; }
      if (!cmd.message) { sendToWs(client.ws, { type: "error", error: "Missing message field" }); return; }
      touchActivity(state, client);
      sendToWs(client.ws, { type: "ack", command: "steer" });
      try {
        await session.steer(cmd.message);
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `steer failed: ${err.message}` });
      }
      break;
    }

    case "abort": {
      const session = getClientSession(state, client);
      if (!session) { sendToWs(client.ws, { type: "error", error: "No active session" }); return; }
      touchActivity(state, client);
      sendToWs(client.ws, { type: "ack", command: "abort" });
      try {
        await session.abort();
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `abort failed: ${err.message}` });
      }
      break;
    }

    case "get_state": {
      const session = getClientSession(state, client);
      if (!session) { sendToWs(client.ws, { type: "error", error: "No active session" }); return; }
      sendToWs(client.ws, {
        type: "state",
        data: {
          model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
          thinkingLevel: session.thinkingLevel,
          isStreaming: session.isStreaming,
          messageCount: session.messages.length,
        },
      });
      break;
    }

    case "get_messages": {
      const session = getClientSession(state, client);
      if (!session) { sendToWs(client.ws, { type: "error", error: "No active session" }); return; }
      sendToWs(client.ws, { type: "messages", data: { messages: session.messages } });
      break;
    }

    case "switch_session": {
      if (!cmd.sessionPath) {
        sendToWs(client.ws, { type: "error", error: "Missing sessionPath field" });
        return;
      }
      sendToWs(client.ws, { type: "ack", command: "switch_session" });
      try {
        const managed = await getOrOpenSession(state, cmd.sessionPath);
        client.activeSessionId = managed.id;
        managed.lastActivity = Date.now();
        sendToWs(client.ws, buildInitPayload(managed));
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `switch_session failed: ${err.message}` });
      }
      break;
    }

    case "new_session": {
      sendToWs(client.ws, { type: "ack", command: "new_session" });
      try {
        const sessionManager = SessionManager.create(state.projectDir);
        const managed = await openSession(state, sessionManager);
        client.activeSessionId = managed.id;
        sendToWs(client.ws, buildInitPayload(managed));
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `new_session failed: ${err.message}` });
      }
      break;
    }

    default: {
      sendToWs(client.ws, { type: "error", error: `Unknown command: ${cmd.type}` });
    }
  }
}

// ---- Git diff --------------------------------------------------------------

export async function getGitDiff(
  projectDir: string,
  contextLines = 3,
): Promise<{ committed: string; uncommitted: string }> {
  const run = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout;
  };

  const ctxFlag = `-U${contextLines}`;

  const [committed, uncommitted] = await Promise.all([
    run(["diff", ctxFlag, "main...HEAD"]).catch(() => ""),
    run(["diff", ctxFlag, "HEAD"]).catch(() => ""),
  ]);

  return { committed, uncommitted };
}

// ---- HTTP fetch handler ----------------------------------------------------

export async function handleFetch(
  state: ServerState,
  req: Request,
  server: any,
): Promise<Response | undefined> {
  const url = new URL(req.url);

  // WebSocket upgrade
  if (url.pathname === "/ws") {
    const upgraded = server.upgrade(req);
    if (!upgraded) {
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return undefined;
  }

  // Session list endpoint
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    try {
      const list = await SessionManager.list(state.projectDir);
      list.sort((a: any, b: any) => b.modified.getTime() - a.modified.getTime());
      const serialized = list.map((s: any) => ({
        path: s.path,
        id: s.id,
        name: s.name,
        created: s.created.toISOString(),
        modified: s.modified.toISOString(),
        messageCount: s.messageCount,
        firstMessage: s.firstMessage,
      }));
      return Response.json(serialized);
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // Git diff endpoint
  if (url.pathname === "/api/diff" && req.method === "GET") {
    try {
      const contextLines = Math.min(
        Math.max(parseInt(url.searchParams.get("context") ?? "3", 10) || 3, 0),
        500,
      );
      const diff = await getGitDiff(state.projectDir, contextLines);
      return Response.json(diff);
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // Health check
  if (url.pathname === "/api/health") {
    const streaming = [...state.sessions.values()].some(
      (m) => m.session.isStreaming,
    );
    return Response.json({
      status: "ok",
      projectDir: state.projectDir,
      activeSessions: state.sessions.size,
      streaming,
    });
  }

  // Static file serving (frontend)
  const frontendDir = state.frontendDir;
  const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const fullPath = `${frontendDir}${filePath}`;

  const file = Bun.file(fullPath);
  if (await file.exists()) {
    return new Response(file);
  }

  // SPA fallback
  const indexFile = Bun.file(`${frontendDir}/index.html`);
  if (await indexFile.exists()) {
    return new Response(indexFile);
  }

  return new Response("Not Found", { status: 404 });
}

// ---- WebSocket lifecycle handlers ------------------------------------------

export function handleWsOpen(state: ServerState, ws: any): void {
  const client: WsClient = { ws, activeSessionId: state.defaultSessionId };
  state.clients.add(client);
  (ws as any)._heraldClient = client;

  console.log(`WebSocket client connected (total: ${state.clients.size})`);

  // Send init for the default session
  const managed = state.sessions.get(state.defaultSessionId);
  if (managed) {
    sendToWs(ws, buildInitPayload(managed));
  }
}

export function handleWsMessage(state: ServerState, ws: any, message: string | Buffer): void {
  const client = (ws as any)._heraldClient as WsClient;
  const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
  handleWsCommand(state, client, raw).catch((err) => {
    console.error("WebSocket command error:", err);
    sendToWs(ws, { type: "error", error: "Internal server error" });
  });
}

export function handleWsClose(state: ServerState, ws: any): void {
  const client = (ws as any)._heraldClient as WsClient | undefined;
  if (client) {
    state.clients.delete(client);
  }
  console.log(`WebSocket client disconnected (total: ${state.clients.size})`);
}
