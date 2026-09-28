/**
 * Real child processes for process-level tests: the server-only entrypoint, the node-only entrypoint and
 * the supervisor, each in temporary directories (their own HOME, the server's REINS_DATA_DIR, a private
 * socket path), plus a small HTTP/WebSocket client for the server's public API.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { createTestRepo, type TestRepo } from "./test-repo.js";

const REPO_ROOT = new URL("../../../../../", import.meta.url).pathname;
export const SERVER_ENTRY = join(REPO_ROOT, "packages/backend/src/index.ts");
export const NODE_ENTRY = join(REPO_ROOT, "packages/node/src/main.ts");
export const SUPERVISOR_ENTRY = join(REPO_ROOT, "packages/backend/src/supervisor.ts");
/** `supervisor.ts dev` without the frontend watchers (`fixtures/dev-supervisor.ts`). */
export const DEV_SUPERVISOR_ENTRY = join(REPO_ROOT, "packages/backend/src/__tests__/fixtures/dev-supervisor.ts");
/** The node's test-only faux provider (`packages/node/src/testing/faux-provider.ts`). */
export const FAUX_PROVIDER = "process-faux";

export const until = async (condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

export class Child {
  output = "";
  readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  constructor(readonly name: string, cmd: string[], options: { cwd: string; env: Record<string, string | undefined> }) {
    this.proc = Bun.spawn({ cmd, cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    for (const stream of [this.proc.stdout, this.proc.stderr]) void this.pump(stream);
  }
  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) this.output += decoder.decode(chunk, { stream: true });
  }
  count(pattern: RegExp): number { return this.output.match(new RegExp(pattern.source, "g"))?.length ?? 0; }
  /** Waits until `pattern` has appeared `times` times in the combined output. */
  async waitFor(pattern: RegExp, times = 1, timeoutMs = 20_000): Promise<RegExpMatchArray> {
    await until(() => this.count(pattern) >= times || this.proc.exitCode !== null, `${this.name}: ${pattern}`, timeoutMs)
      .catch((error: unknown) => { throw new Error(`${String(error)}\n--- ${this.name} output ---\n${this.output}`); });
    if (this.count(pattern) < times) throw new Error(`${this.name} exited (${this.proc.exitCode}) before ${pattern}\n${this.output}`);
    return this.output.match(pattern)!;
  }
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
    if (this.proc.exitCode === null) this.proc.kill(signal);
    return this.proc.exited;
  }
}

/** Separate temp directories for each side, so a test can check which process created which files. */
export interface ProcessLayout {
  root: string;
  serverHome: string;
  dataDir: string;
  nodeHome: string;
  nodeCwd: string;
  socket: string;
  repo: TestRepo;
  dispose(): void;
}

export async function createProcessLayout(): Promise<ProcessLayout> {
  const root = mkdtempSync(join(tmpdir(), "reins-proc-"));
  const dirs = { serverHome: join(root, "server-home"), dataDir: join(root, "data"), nodeHome: join(root, "node-home"), nodeCwd: join(root, "node-cwd") };
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const repo = await createTestRepo();
  return {
    root, ...dirs, repo,
    socket: join(root, "run", "node.sock"),
    dispose() { repo.cleanup(); rmSync(root, { recursive: true, force: true }); },
  };
}

// Not NODE_ENV=test (bun test sets it): the server would log warnings only.
const baseEnv = () => ({ ...process.env, NODE_ENV: "production", REINS_DEV: "0", REINS_PORT: "0" });

export function serverEnv(layout: ProcessLayout, env: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...baseEnv(), HOME: layout.serverHome, REINS_DATA_DIR: layout.dataDir, REINS_NODE_SOCKET: layout.socket, ...env };
}

export function nodeEnv(layout: ProcessLayout): Record<string, string | undefined> {
  return { ...baseEnv(), HOME: layout.nodeHome, REINS_NODE_SOCKET: layout.socket, REINS_NODE_TEST_FAUX_PROVIDER: FAUX_PROVIDER };
}

export interface ServerChild extends Child { port: number }

/** Starts the server-only entrypoint and resolves once it listens on HTTP. */
export async function startServer(layout: ProcessLayout, env: Record<string, string> = {}): Promise<ServerChild> {
  const child = new Child("server", [process.execPath, SERVER_ENTRY], { cwd: layout.dataDir, env: serverEnv(layout, env) });
  const [, port] = await child.waitFor(/listening on http:\/\/localhost:(\d+)/);
  return Object.assign(child, { port: Number(port) });
}

/** Starts the node-only entrypoint (with the test faux provider). */
export function startNodeProcess(layout: ProcessLayout): Child {
  return new Child("node", [process.execPath, NODE_ENTRY], { cwd: layout.nodeCwd, env: nodeEnv(layout) });
}

/** The server's public HTTP/WebSocket API. */
export class ServerApi {
  constructor(private readonly port: number) {}
  async json<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`http://localhost:${this.port}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
    const value: T = text ? JSON.parse(text) : undefined;
    return value;
  }
  health() { return this.json<{ status: string; nodes: Array<{ id: string; name: string; connected: boolean }> }>("GET", "/api/health"); }
  /** Whether the server reports the local node (the seeded node the node process connects as) connected. */
  async localNodeConnected() { return (await this.health()).nodes.some(node => node.id === "internal" && node.connected); }
  /** API key for the faux provider, faux default model and a project on `repo`. */
  async setUp(repo: string): Promise<{ projectId: number }> {
    await this.json("PUT", `/api/auth/api-keys/${FAUX_PROVIDER}`, { apiKey: "test-key" });
    await this.json("PUT", "/api/settings/default_model", { provider: FAUX_PROVIDER, modelId: "fake", runtimeType: "pi", thinkingLevel: "minimal" });
    const project = await this.json<{ id: number }>("POST", "/api/projects", { name: "processes", path: repo });
    return { projectId: project.id };
  }
  async createSession(projectId: number): Promise<string> {
    return (await this.json<{ id: string }>("POST", `/api/projects/${projectId}/sessions`)).id;
  }
  /** Sends a prompt (or a steer into the active run) over the browser WebSocket and resolves on its ack
   * (the server queued it). */
  async prompt(sessionId: string, clientId: string, text: string, type: "prompt" | "steer" = "prompt"): Promise<void> {
    const ws = new WebSocket(`ws://localhost:${this.port}/ws`);
    try {
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("WebSocket failed")); });
      const acked = new Promise<void>((resolve, reject) => {
        ws.onmessage = event => {
          const message = JSON.parse(String(event.data));
          if (message.type === "ack" && message.clientId === clientId) resolve();
          if (message.type === "error" && message.clientId === clientId) reject(new Error(message.error));
        };
      });
      ws.send(JSON.stringify({ type, sessionId, clientId, message: [{ type: "text", text }] }));
      await acked;
    } finally { ws.close(); }
  }
  /** Text of every user and assistant message in the server's replica transcript, in order. */
  async transcript(sessionId: string): Promise<string[]> {
    const page = await this.json<{ items: Array<{ message: { role: string; content: unknown } }> }>("GET", `/api/sessions/${sessionId}/messages?limit=200`);
    return page.items.map(item => item.message).filter(message => message.role === "user" || message.role === "assistant")
      .map(message => `${message.role}: ${textOf(message.content)}`);
  }
  async activity(sessionId: string): Promise<string | undefined> {
    return (await this.json<{ activityState?: string }>("GET", `/api/sessions/${sessionId}`)).activityState;
  }
  /** Waits until the transcript ends with `entries`. */
  async waitForTranscript(sessionId: string, entries: string[], timeoutMs = 20_000): Promise<string[]> {
    let last: string[] = [];
    await until(async () => {
      last = await this.transcript(sessionId);
      return entries.every((entry, i) => last[last.length - entries.length + i] === entry);
    }, `transcript ending ${JSON.stringify(entries)}`, timeoutMs).catch((error: unknown) => {
      throw new Error(`${String(error)}; transcript: ${JSON.stringify(last)}`);
    });
    return last;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(block => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "")).join("");
}

/** Every file under `dir`, relative to it. */
export async function filesUnder(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(dir.length + 1));
}

export function expectNoUnexpectedExit(...children: Child[]): void {
  for (const child of children) expect({ name: child.name, exitCode: child.proc.exitCode }).toEqual({ name: child.name, exitCode: null });
}
