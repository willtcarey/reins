/**
 * Real child processes for process-level tests: the server-only entrypoint, the node-only entrypoint and
 * the supervisor, each in temporary directories (their own HOME, the server's REINS_DATA_DIR, a private
 * socket path), plus a small HTTP client for the server's public API.
 *
 * Every child runs in its own process group (the supervisor's services join its group) and is recorded
 * at spawn. Each test file calls `stopChildren` first in its `afterEach` (a hook registered here would
 * attach only to the first file that imports this module); a watchdog (`process-reaper.ts`) kills the
 * groups and removes the temp directories if the test runner dies before that, SIGKILL included.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { ReinsClient } from "@reins/client";
import type { NodeView } from "../../models/node.js";
import { createTestRepo, type TestRepo } from "./test-repo.js";

const REPO_ROOT = new URL("../../../../../", import.meta.url).pathname;
export const SERVER_ENTRY = join(REPO_ROOT, "packages/backend/src/index.ts");
export const NODE_ENTRY = join(REPO_ROOT, "packages/node/src/main.ts");
export const SUPERVISOR_ENTRY = join(REPO_ROOT, "packages/backend/src/supervisor.ts");
/** The `reins` command (`bun run reins`). */
export const CLI_ENTRY = join(REPO_ROOT, "packages/cli/src/cli.ts");
/** The test-only faux provider sessions run on, on the server (`pi/test-faux-provider.ts`). */
export const FAUX_PROVIDER = "process-faux";

export const until = async (condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

/** Process groups of children that may still have members; emptied by `stopChildren`. */
const groups = new Set<number>();
const STOP_GRACE_MS = 3_000;

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch { /* the group is empty */ }
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

async function groupEnded(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pgid)) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
  return true;
}

/** Stops every child's process group still running: SIGTERM to the child (to its group once the child
 * is gone), SIGCONT in case it was stopped, then SIGKILL to the group after STOP_GRACE_MS. The child
 * gets the chance to stop its own children first, as the supervisor does. */
export async function stopChildren(): Promise<void> {
  await Promise.all([...groups].map(async pgid => {
    if (groupAlive(pgid)) {
      try { process.kill(pgid, "SIGTERM"); } catch { signalGroup(pgid, "SIGTERM"); }
      signalGroup(pgid, "SIGCONT");
      if (!(await groupEnded(pgid, STOP_GRACE_MS))) {
        signalGroup(pgid, "SIGKILL");
        if (!(await groupEnded(pgid, STOP_GRACE_MS))) throw new Error(`Process group ${pgid} survived SIGKILL`);
      }
    }
    groups.delete(pgid);
    tellReaper(`-group ${pgid}`);
  }));
}

/** Has `stopChildren` (and the watchdog) stop the process group of `pid`, a process a child started in a
 * group of its own (a node `reins node setup` started in the background). */
export function adoptProcessGroup(pid: number): void {
  const ps = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const pgid = Number.parseInt(ps.stdout.toString().trim(), 10);
  if (!Number.isInteger(pgid)) throw new Error(`No process group for pid ${pid}`);
  groups.add(pgid);
  tellReaper(`+group ${pgid}`);
}

let reaper: Bun.Subprocess<"pipe", "ignore", "ignore"> | undefined;

function tellReaper(line: string): void {
  if (!reaper) {
    reaper = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dirname, "process-reaper.ts")],
      cwd: tmpdir(), stdin: "pipe", stdout: "ignore", stderr: "ignore", detached: true,
    });
    reaper.unref();
  }
  reaper.stdin.write(`${line}\n`);
  void reaper.stdin.flush();
}

export class Child {
  output = "";
  readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  constructor(readonly name: string, cmd: string[], options: { cwd: string; env: Record<string, string | undefined> }) {
    this.proc = Bun.spawn({ cmd, cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    groups.add(this.proc.pid);
    tellReaper(`+group ${this.proc.pid}`);
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
  /** Signals the child alone (the supervisor test checks that the supervisor stops its own children);
   * `stopChildren` cleans up the rest of its group. */
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill(signal);
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
  tellReaper(`+dir ${root}`);
  const repo = await createTestRepo();
  tellReaper(`+dir ${repo.dir}`);
  return {
    root, ...dirs, repo,
    socket: join(root, "run", "node.sock"),
    dispose() {
      repo.cleanup();
      rmSync(root, { recursive: true, force: true });
      tellReaper(`-dir ${repo.dir}`);
      tellReaper(`-dir ${root}`);
    },
  };
}

// Not NODE_ENV=test (bun test sets it): the server would log warnings only.
const baseEnv = () => ({ ...process.env, NODE_ENV: "production", REINS_DEV: "0", REINS_PORT: "0" });

export function serverEnv(layout: ProcessLayout, env: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...baseEnv(), HOME: layout.serverHome, REINS_DATA_DIR: layout.dataDir, REINS_NODE_SOCKET: layout.socket, REINS_TEST_FAUX_PROVIDER: FAUX_PROVIDER, ...env };
}

export function nodeEnv(layout: ProcessLayout): Record<string, string | undefined> {
  return { ...baseEnv(), HOME: layout.nodeHome, REINS_NODE_SOCKET: layout.socket };
}

/** The environment of a remote node's `reins` commands: its own HOME and node home (`<home>/.reins`), no
 * local socket. The docs' variable is unset, so a bundle sets its own. */
export function remoteNodeEnv(home: string): Record<string, string | undefined> {
  return {
    ...process.env, NODE_ENV: "production", HOME: home, REINS_NODE_DATA_DIR: join(home, ".reins"),
    REINS_NODE_SOCKET: undefined, REINS_DOCS_DIR: undefined,
  };
}

/** `reins node pair` with a code from the API (which only the command's arguments see); `reins` is the
 * command line before its arguments (the CLI from source, or a bundle). Resolves with the node's ID, the
 * code and the command's output. */
export async function pairRemoteNode(api: ServerApi, options: { reins: readonly string[]; serverUrl: string; name: string; cwd: string; env: Record<string, string | undefined> }): Promise<{ nodeId: string; code: string; output: string }> {
  const { reins, serverUrl, name, cwd, env } = options;
  const { code } = await api.client.nodes.createPairingCode({ name });
  const pair = new Child("pair", [...reins, "node", "pair", serverUrl, code], { cwd, env });
  expect(await pair.proc.exited).toBe(0);
  const [, nodeId] = await pair.waitFor(new RegExp(`as node "${name}" \\(([\\w-]+)\\)`));
  return { nodeId: nodeId!, code, output: pair.output };
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

/** The server's public HTTP API: `client` (`@reins/client`) and helpers on it. */
export class ServerApi {
  readonly client: ReinsClient;
  constructor(private readonly port: number) {
    this.client = new ReinsClient({ baseUrl: `http://localhost:${port}` });
  }
  async health(): Promise<{ status: string; nodes: Array<Pick<NodeView, "id" | "name" | "connected">> }> {
    const response = await fetch(`http://localhost:${this.port}/api/health`);
    if (!response.ok) throw new Error(`GET /api/health → ${response.status}: ${await response.text()}`);
    return response.json();
  }
  /** Whether the server reports the local node (the seeded node the node process connects as) connected. */
  async localNodeConnected() { return (await this.client.nodes.list()).some(node => node.id === "internal" && node.connected); }
  /** API key for the faux provider, faux default model and a project on `repo`, a checkout on the node
   * (the local node by default), which must be connected: creating a project checks its checkout there. */
  async setUp(repo: string, nodeId = "internal"): Promise<{ projectId: number }> {
    await this.client.auth.putApiKey(FAUX_PROVIDER, "test-key");
    await this.client.settings.put("default_model", { provider: FAUX_PROVIDER, modelId: "fake", runtimeType: "pi", thinkingLevel: "minimal" });
    const project = await this.client.projects.create({ name: "processes", path: repo, nodeId });
    return { projectId: project.id };
  }
  async createSession(projectId: number): Promise<string> {
    return (await this.client.sessions.create(projectId)).id;
  }
  /** Submits a prompt (or a steer into the active run) and resolves once the session admitted it. */
  async prompt(sessionId: string, clientId: string, text: string, op: "prompt" | "steer" = "prompt"): Promise<void> {
    await this.client.sessions[op](sessionId, { clientId, message: [{ type: "text", text }] });
  }
  /** Text of every user and assistant message in the server's transcript, in order. */
  async transcript(sessionId: string): Promise<string[]> {
    const page = await this.client.sessions.messages(sessionId, { limit: 200 });
    return page.items.map(item => item.message).filter(message => message.role === "user" || message.role === "assistant")
      .map(message => `${message.role}: ${textOf(message.content)}`);
  }
  /** Every tool result in the server's transcript, in order: its text and whether it is an error. */
  async toolResults(sessionId: string): Promise<Array<{ text: string; isError: boolean }>> {
    const page = await this.client.sessions.messages(sessionId, { limit: 200 });
    return page.items.map(item => item.message).filter(message => message.role === "toolResult")
      .map(message => ({ text: textOf(message.content), isError: "isError" in message && message.isError === true }));
  }
  async activity(sessionId: string): Promise<string | null> {
    return (await this.client.sessions.get(sessionId)).activityState;
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
