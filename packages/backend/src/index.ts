/**
 * Herald Backend Server
 *
 * Single-file Bun HTTP + WebSocket server with four responsibilities:
 * 1. AgentSession creation via pi-coding-agent SDK
 * 2. WebSocket endpoint (/ws) for relaying agent events and handling commands
 * 3. Git diff endpoint (GET /api/diff) for branch + working copy changes
 * 4. Static file serving for the frontend
 */

import { createAgentSession, createCodingTools, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

const PORT = parseInt(process.env.HERALD_PORT || "3100", 10);
const PROJECT_DIR = process.env.HERALD_PROJECT_DIR || process.cwd();

console.log(`Herald backend starting...`);
console.log(`  Project dir: ${PROJECT_DIR}`);
console.log(`  Port: ${PORT}`);

// ---------------------------------------------------------------------------
// 1. AgentSession creation
// ---------------------------------------------------------------------------

let session: AgentSession;

async function initSession(): Promise<void> {
  const tools = createCodingTools(PROJECT_DIR);
  const sessionManager = SessionManager.create(PROJECT_DIR);

  // Allow explicit override via env vars, otherwise let the SDK auto-discover
  // from ~/.pi/agent/auth.json (OAuth) or environment API keys
  const provider = process.env.HERALD_PROVIDER;
  const modelId = process.env.HERALD_MODEL;
  const model = provider && modelId ? getModel(provider as any, modelId) : undefined;

  const result = await createAgentSession({
    cwd: PROJECT_DIR,
    tools,
    sessionManager,
    model,
  });

  session = result.session;

  if (result.modelFallbackMessage) {
    console.warn(`Model fallback: ${result.modelFallbackMessage}`);
  }

  console.log(`  Model: ${session.model?.provider}/${session.model?.id ?? "none"}`);
  console.log(`  Thinking: ${session.thinkingLevel}`);
}

// ---------------------------------------------------------------------------
// 2. WebSocket management
// ---------------------------------------------------------------------------

interface WsClient {
  ws: any; // Bun ServerWebSocket
  unsubscribe: (() => void) | null;
}

const clients = new Set<WsClient>();

function broadcastEvent(event: AgentSessionEvent): void {
  const payload = JSON.stringify({ type: "event", event });
  for (const client of clients) {
    try {
      client.ws.send(payload);
    } catch {
      // Client may have disconnected
    }
  }
}

function sendToWs(ws: any, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // ignore send errors on closed sockets
  }
}

/** Handle an incoming WebSocket command */
async function handleWsCommand(ws: any, raw: string): Promise<void> {
  let cmd: { type: string; message?: string };
  try {
    cmd = JSON.parse(raw);
  } catch {
    sendToWs(ws, { type: "error", error: "Invalid JSON" });
    return;
  }

  switch (cmd.type) {
    case "prompt": {
      if (!cmd.message) {
        sendToWs(ws, { type: "error", error: "Missing message field" });
        return;
      }
      sendToWs(ws, { type: "ack", command: "prompt" });
      try {
        await session.prompt(cmd.message);
      } catch (err: any) {
        sendToWs(ws, { type: "error", error: `prompt failed: ${err.message}` });
      }
      break;
    }

    case "steer": {
      if (!cmd.message) {
        sendToWs(ws, { type: "error", error: "Missing message field" });
        return;
      }
      sendToWs(ws, { type: "ack", command: "steer" });
      try {
        await session.steer(cmd.message);
      } catch (err: any) {
        sendToWs(ws, { type: "error", error: `steer failed: ${err.message}` });
      }
      break;
    }

    case "abort": {
      sendToWs(ws, { type: "ack", command: "abort" });
      try {
        await session.abort();
      } catch (err: any) {
        sendToWs(ws, { type: "error", error: `abort failed: ${err.message}` });
      }
      break;
    }

    case "get_state": {
      sendToWs(ws, {
        type: "state",
        data: {
          model: session.model
            ? { provider: session.model.provider, id: session.model.id }
            : null,
          thinkingLevel: session.thinkingLevel,
          isStreaming: session.isStreaming,
          messageCount: session.messages.length,
        },
      });
      break;
    }

    case "get_messages": {
      sendToWs(ws, {
        type: "messages",
        data: { messages: session.messages },
      });
      break;
    }

    default: {
      sendToWs(ws, { type: "error", error: `Unknown command: ${cmd.type}` });
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

async function startServer(): Promise<void> {
  await initSession();

  // Subscribe to agent events and broadcast to all connected clients
  session.subscribe(broadcastEvent);

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
        return Response.json({ status: "ok", projectDir: PROJECT_DIR });
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
        const client: WsClient = { ws, unsubscribe: null };
        clients.add(client);

        // Store client ref on ws for lookup in other handlers
        (ws as any)._heraldClient = client;

        console.log(`WebSocket client connected (total: ${clients.size})`);

        // Send current messages for reconnect support
        sendToWs(ws, {
          type: "init",
          data: {
            messages: session.messages,
            state: {
              model: session.model
                ? { provider: session.model.provider, id: session.model.id }
                : null,
              thinkingLevel: session.thinkingLevel,
              isStreaming: session.isStreaming,
              messageCount: session.messages.length,
            },
          },
        });
      },

      message(ws, message) {
        const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
        // Handle command asynchronously — don't block the WebSocket event loop
        handleWsCommand(ws, raw).catch((err) => {
          console.error("WebSocket command error:", err);
          sendToWs(ws, { type: "error", error: "Internal server error" });
        });
      },

      close(ws) {
        const client = (ws as any)._heraldClient as WsClient | undefined;
        if (client) {
          if (client.unsubscribe) {
            client.unsubscribe();
          }
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
