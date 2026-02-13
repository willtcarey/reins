/**
 * Herald Request Handlers (hot-reloadable)
 *
 * All HTTP and WebSocket handler logic lives here. Functions receive a
 * ServerState object so they can access sessions, clients, and config
 * without owning them. The entry point (index.ts) holds the actual state
 * and can re-import this module to pick up code changes without losing
 * in-memory agent sessions.
 *
 * Project context always flows from the request, never from server state:
 *  - REST: session lifecycle + queries scoped under `/api/projects/:id/...`
 *  - WS:   stateless broadcast — all active session events go to all clients
 *           (tagged with sessionId). Commands include explicit sessionId.
 *
 * Session lifecycle:
 *  - GET  .../sessions/:path  → read-only (SessionManager, no AgentSession)
 *  - POST .../sessions        → create new (opens AgentSession immediately)
 *  - POST .../sessions/latest → continue recent (opens AgentSession immediately)
 *  - WS prompt/steer          → lazy-opens AgentSession if not already active
 */

import { createAgentSession, createCodingTools, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { existsSync } from "fs";
import type { ServerState, ManagedSession, WsClient } from "./state.js";
import {
  listProjects, getProject, createProject,
  updateProject, deleteProject, touchProject,
} from "./project-store.js";

// ---- Project dir resolution ------------------------------------------------

function resolveProjectDir(projectId: number): string | null {
  const project = getProject(projectId);
  if (!project) return null;
  return project.path;
}

// ---- Session helpers -------------------------------------------------------

/**
 * Open a full AgentSession (with tools, event subscription, etc.).
 * Used for new sessions, continue-recent, and lazy-open on first prompt.
 */
export async function openSession(
  state: ServerState,
  projectDir: string,
  sessionManager: SessionManager,
): Promise<ManagedSession> {
  const tools = createCodingTools(projectDir);
  const result = await createAgentSession({
    cwd: projectDir,
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

  // Subscribe to events — broadcast to ALL connected clients with sessionId tag
  agentSession.subscribe((event: AgentSessionEvent) => {
    const payload = JSON.stringify({ type: "event", sessionId: id, event });
    for (const client of state.clients) {
      try { client.ws.send(payload); } catch {}
    }
  });

  state.sessions.set(id, managed);
  console.log(`  Session opened: ${id} (total: ${state.sessions.size})`);
  return managed;
}

/**
 * Find an already-open ManagedSession by its file path.
 */
function findOpenSession(state: ServerState, sessionPath: string): ManagedSession | null {
  for (const managed of state.sessions.values()) {
    if (managed.session.sessionFile === sessionPath) {
      managed.lastActivity = Date.now();
      return managed;
    }
  }
  return null;
}

/**
 * Read session data from disk (lightweight — no AgentSession created).
 * Returns the same shape as serializeSession() for API consistency.
 */
function readSessionFromDisk(sessionPath: string) {
  const sm = SessionManager.open(sessionPath);
  const ctx = sm.buildSessionContext();
  return {
    path: sm.getSessionFile(),
    id: sm.getSessionId(),
    messages: ctx.messages,
    state: {
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.modelId } : null,
      thinkingLevel: ctx.thinkingLevel,
      isStreaming: false,
      messageCount: ctx.messages.length,
    },
  };
}

/**
 * Ensure a session is fully open (AgentSession created). If already open,
 * returns the existing ManagedSession. Otherwise opens from sessionPath.
 */
async function ensureSessionOpen(
  state: ServerState,
  sessionId: string,
  sessionPath: string,
): Promise<ManagedSession> {
  // Already open?
  const existing = state.sessions.get(sessionId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }

  // Open from disk
  const sm = SessionManager.open(sessionPath);
  const projectDir = sm.getCwd();
  return openSession(state, projectDir, sm);
}

// ---- Payload builders ------------------------------------------------------

function serializeSession(managed: ManagedSession) {
  const s = managed.session;
  return {
    path: s.sessionFile,
    id: managed.id,
    messages: s.messages,
    state: {
      model: s.model ? { provider: s.model.provider, id: s.model.id } : null,
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      messageCount: s.messages.length,
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

// ---- WebSocket command handler ---------------------------------------------

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

// ---- Shared REST helpers ---------------------------------------------------

async function serializeSessionList(projectDir: string) {
  const list = await SessionManager.list(projectDir);
  list.sort((a: any, b: any) => b.modified.getTime() - a.modified.getTime());
  return list.map((s: any) => ({
    path: s.path,
    id: s.id,
    name: s.name,
    created: s.created.toISOString(),
    modified: s.modified.toISOString(),
    messageCount: s.messageCount,
    firstMessage: s.firstMessage,
  }));
}

// ---- Git diff --------------------------------------------------------------

async function getGitDiff(
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

  // ---- Project CRUD endpoints ----

  // List all projects
  if (url.pathname === "/api/projects" && req.method === "GET") {
    try {
      const projects = listProjects();
      return Response.json(projects);
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // Create a project
  if (url.pathname === "/api/projects" && req.method === "POST") {
    try {
      const body = await req.json() as { name?: string; path?: string };
      if (!body.name || !body.path) {
        return Response.json({ error: "name and path are required" }, { status: 400 });
      }
      if (!existsSync(body.path)) {
        return Response.json({ error: `Directory does not exist: ${body.path}` }, { status: 400 });
      }
      const project = createProject(body.name, body.path);
      return Response.json(project, { status: 201 });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return Response.json({ error: "A project with that path already exists" }, { status: 409 });
      }
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // Update / Delete a project
  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
  if (projectMatch && req.method === "PATCH") {
    try {
      const id = parseInt(projectMatch[1], 10);
      const body = await req.json() as { name?: string; path?: string };
      const updated = updateProject(id, body);
      if (!updated) {
        return Response.json({ error: "Project not found" }, { status: 404 });
      }
      return Response.json(updated);
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (projectMatch && req.method === "DELETE") {
    try {
      const id = parseInt(projectMatch[1], 10);
      const deleted = deleteProject(id);
      if (!deleted) {
        return Response.json({ error: "Project not found" }, { status: 404 });
      }
      return Response.json({ ok: true });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // ---- Project-scoped endpoints ----

  const projectIdMatch = url.pathname.match(/^\/api\/projects\/(\d+)\//);
  if (projectIdMatch) {
    const projectId = parseInt(projectIdMatch[1], 10);
    const projectDir = resolveProjectDir(projectId);

    if (!projectDir) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    if (!existsSync(projectDir)) {
      return Response.json({ error: `Directory does not exist: ${projectDir}` }, { status: 400 });
    }

    const subPath = url.pathname.slice(projectIdMatch[0].length);

    // GET /api/projects/:id/sessions — list sessions
    if (subPath === "sessions" && req.method === "GET") {
      try {
        return Response.json(await serializeSessionList(projectDir));
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/projects/:id/sessions — create a new session (opens AgentSession)
    if (subPath === "sessions" && req.method === "POST") {
      try {
        touchProject(projectId);
        const sessionManager = SessionManager.create(projectDir);
        const managed = await openSession(state, projectDir, sessionManager);
        return Response.json(serializeSession(managed), { status: 201 });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // GET /api/projects/:id/sessions/:sessionPath — read session data (lightweight)
    const sessionSubMatch = subPath.match(/^sessions\/(.+)$/);
    if (sessionSubMatch && req.method === "GET") {
      const sessionPath = decodeURIComponent(sessionSubMatch[1]);
      try {
        // If already open in memory, use that (includes isStreaming state)
        const open = findOpenSession(state, sessionPath);
        if (open) {
          return Response.json(serializeSession(open));
        }
        // Otherwise read from disk — no AgentSession created
        const data = readSessionFromDisk(sessionPath);
        return Response.json(data);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // GET /api/projects/:id/diff — git diff
    if (subPath === "diff" && req.method === "GET") {
      try {
        const contextLines = Math.min(
          Math.max(parseInt(url.searchParams.get("context") ?? "3", 10) || 3, 0),
          500,
        );
        const diff = await getGitDiff(projectDir, contextLines);
        return Response.json(diff);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }
  }

  // Health check
  if (url.pathname === "/api/health") {
    const streaming = [...state.sessions.values()].some(
      (m) => m.session.isStreaming,
    );
    return Response.json({
      status: "ok",
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
  const client: WsClient = { ws };
  state.clients.add(client);
  (ws as any)._heraldClient = client;

  console.log(`WebSocket client connected (total: ${state.clients.size})`);
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
