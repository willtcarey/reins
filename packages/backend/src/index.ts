/**
 * Herald Backend Server
 *
 * Bun HTTP + WebSocket server with five responsibilities:
 * 1. Session registry — multiple concurrent AgentSessions with idle eviction
 * 2. WebSocket endpoint (/ws) for relaying agent events and handling commands
 * 3. Session list endpoint (GET /api/sessions)
 * 4. Git diff endpoint (GET /api/diff)
 * 5. Static file serving for the frontend
 */

import { createAgentSession, createCodingTools, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

const PORT = parseInt(process.env.HERALD_PORT || "3100", 10);
const PROJECT_DIR = process.env.HERALD_PROJECT_DIR || process.cwd();
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const EVICTION_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

console.log(`Herald backend starting...`);
console.log(`  Project dir: ${PROJECT_DIR}`);
console.log(`  Port: ${PORT}`);

// ---------------------------------------------------------------------------
// 1. Session registry
// ---------------------------------------------------------------------------

interface ManagedSession {
  session: AgentSession;
  id: string;
  lastActivity: number;
}

const sessions = new Map<string, ManagedSession>();

// Model override from env vars (or undefined to let SDK auto-discover)
const explicitProvider = process.env.HERALD_PROVIDER;
const explicitModelId = process.env.HERALD_MODEL;
const explicitModel = explicitProvider && explicitModelId
  ? getModel(explicitProvider as any, explicitModelId)
  : undefined;

async function openSession(sessionManager: SessionManager): Promise<ManagedSession> {
  const tools = createCodingTools(PROJECT_DIR);
  const result = await createAgentSession({
    cwd: PROJECT_DIR,
    tools,
    sessionManager,
    model: explicitModel,
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
    for (const client of clients) {
      if (client.activeSessionId === id) {
        try { client.ws.send(payload); } catch {}
      }
    }
  });

  sessions.set(id, managed);
  console.log(`  Session opened: ${id} (total: ${sessions.size})`);
  return managed;
}

async function getOrOpenSession(sessionPath: string): Promise<ManagedSession> {
  // Check if already open by matching session path against open sessions
  for (const managed of sessions.values()) {
    if (managed.session.sessionFile === sessionPath) {
      managed.lastActivity = Date.now();
      return managed;
    }
  }

  const sessionManager = SessionManager.open(sessionPath);
  return openSession(sessionManager);
}

// Idle eviction — close sessions with no viewers and no activity
setInterval(() => {
  const now = Date.now();
  for (const [id, managed] of sessions) {
    if (managed.session.isStreaming) continue;

    const hasViewers = [...clients].some(c => c.activeSessionId === id);
    if (hasViewers) continue;

    if (now - managed.lastActivity > IDLE_TIMEOUT_MS) {
      sessions.delete(id);
      console.log(`  Session evicted (idle): ${id} (remaining: ${sessions.size})`);
    }
  }
}, EVICTION_CHECK_INTERVAL_MS);

// ---------------------------------------------------------------------------
// 2. WebSocket management
// ---------------------------------------------------------------------------

interface WsClient {
  ws: any; // Bun ServerWebSocket
  activeSessionId: string | null;
}

const clients = new Set<WsClient>();

function buildInitPayload(managed: ManagedSession) {
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

function sendToWs(ws: any, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // ignore send errors on closed sockets
  }
}

function getClientSession(client: WsClient): AgentSession | null {
  if (!client.activeSessionId) return null;
  return sessions.get(client.activeSessionId)?.session ?? null;
}

function touchActivity(client: WsClient): void {
  if (!client.activeSessionId) return;
  const managed = sessions.get(client.activeSessionId);
  if (managed) managed.lastActivity = Date.now();
}

/** Handle an incoming WebSocket command */
async function handleWsCommand(client: WsClient, raw: string): Promise<void> {
  let cmd: { type: string; message?: string; sessionPath?: string };
  try {
    cmd = JSON.parse(raw);
  } catch {
    sendToWs(client.ws, { type: "error", error: "Invalid JSON" });
    return;
  }

  switch (cmd.type) {
    case "prompt": {
      const session = getClientSession(client);
      if (!session) { sendToWs(client.ws, { type: "error", error: "No active session" }); return; }
      if (!cmd.message) { sendToWs(client.ws, { type: "error", error: "Missing message field" }); return; }
      touchActivity(client);
      sendToWs(client.ws, { type: "ack", command: "prompt" });
      try {
        await session.prompt(cmd.message);
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `prompt failed: ${err.message}` });
      }
      break;
    }

    case "steer": {
      const session = getClientSession(client);
      if (!session) { sendToWs(client.ws, { type: "error", error: "No active session" }); return; }
      if (!cmd.message) { sendToWs(client.ws, { type: "error", error: "Missing message field" }); return; }
      touchActivity(client);
      sendToWs(client.ws, { type: "ack", command: "steer" });
      try {
        await session.steer(cmd.message);
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `steer failed: ${err.message}` });
      }
      break;
    }

    case "abort": {
      const session = getClientSession(client);
      if (!session) { sendToWs(client.ws, { type: "error", error: "No active session" }); return; }
      touchActivity(client);
      sendToWs(client.ws, { type: "ack", command: "abort" });
      try {
        await session.abort();
      } catch (err: any) {
        sendToWs(client.ws, { type: "error", error: `abort failed: ${err.message}` });
      }
      break;
    }

    case "get_state": {
      const session = getClientSession(client);
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
      const session = getClientSession(client);
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
        const managed = await getOrOpenSession(cmd.sessionPath);
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
        const sessionManager = SessionManager.create(PROJECT_DIR);
        const managed = await openSession(sessionManager);
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

// ---------------------------------------------------------------------------
// 3. Git diff endpoint
// ---------------------------------------------------------------------------

async function getGitDiff(): Promise<{ committed: string; uncommitted: string }> {
  const run = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn(["git", ...args], {
      cwd: PROJECT_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout;
  };

  const [committed, uncommitted] = await Promise.all([
    run(["diff", "main...HEAD"]).catch(() => ""),
    run(["diff", "HEAD"]).catch(() => ""),
  ]);

  return { committed, uncommitted };
}

// ---------------------------------------------------------------------------
// 4. Bun server (HTTP + WebSocket)
// ---------------------------------------------------------------------------

let defaultSessionId: string;

async function startServer(): Promise<void> {
  // Open the most recent session (or create a new one)
  const sessionManager = SessionManager.continueRecent(PROJECT_DIR);
  const initial = await openSession(sessionManager);
  defaultSessionId = initial.id;

  console.log(`  Model: ${initial.session.model?.provider}/${initial.session.model?.id ?? "none"}`);
  console.log(`  Thinking: ${initial.session.thinkingLevel}`);

  const server = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",

    // HTTP routes
    async fetch(req, server) {
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
          const list = await SessionManager.list(PROJECT_DIR);
          list.sort((a, b) => b.modified.getTime() - a.modified.getTime());
          const serialized = list.map(s => ({
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
          const diff = await getGitDiff();
          return Response.json(diff);
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }

      // Health check
      if (url.pathname === "/api/health") {
        return Response.json({ status: "ok", projectDir: PROJECT_DIR, activeSessions: sessions.size });
      }

      // Static file serving (frontend)
      const frontendDir = new URL("../../frontend/", import.meta.url).pathname;
      let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
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
    },

    // WebSocket handlers
    websocket: {
      open(ws) {
        const client: WsClient = { ws, activeSessionId: defaultSessionId };
        clients.add(client);
        (ws as any)._heraldClient = client;

        console.log(`WebSocket client connected (total: ${clients.size})`);

        // Send init for the default session
        const managed = sessions.get(defaultSessionId);
        if (managed) {
          sendToWs(ws, buildInitPayload(managed));
        }
      },

      message(ws, message) {
        const client = (ws as any)._heraldClient as WsClient;
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        handleWsCommand(client, raw).catch((err) => {
          console.error("WebSocket command error:", err);
          sendToWs(ws, { type: "error", error: "Internal server error" });
        });
      },

      close(ws) {
        const client = (ws as any)._heraldClient as WsClient | undefined;
        if (client) {
          clients.delete(client);
        }
        console.log(`WebSocket client disconnected (total: ${clients.size})`);
      },
    },
  });

  console.log(`Herald backend listening on http://localhost:${server.port}`);
}

startServer().catch((err) => {
  console.error("Fatal: failed to start Herald backend:", err);
  process.exit(1);
});
