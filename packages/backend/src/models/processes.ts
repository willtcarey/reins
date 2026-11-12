/**
 * The processes the server keeps on nodes for an owner across its own reloads (ADR-039): one per app,
 * `AppState.processes`. An owner is any string its caller chooses.
 *
 * A process without a key is its owner's handle alone: `unload` stops it. A process with a key is recorded
 * (`process-store.ts`, in the main database), so that the next app can attach to it again; `detach`, `unload`
 * and an app's `release` let go of it instead of stopping it, and `stopOwners` stops the records of owners that
 * are gone. Calls on one key are taken one at a time, so concurrent attaches share one process; an app has one
 * handle per process.
 */

import { createHmac } from "node:crypto";
import { getEncryptionSecret } from "../crypto.js";
import { logger } from "../logger.js";
import { deleteProcess, endProcess, getProcess, listProcesses, processOwners, recordProcess, setProcessOffset, type ProcessRecord } from "../process-store.js";
import { LOST_ERROR, PROCESS_REATTACH_WINDOW_MS, type NodeProcess, type NodeProcessExit } from "../nodes/node-process.js";
import type { AppState } from "../state.js";
import { refusalCode, type NodeHost } from "./node-host.js";
import type { NodeModel } from "./node.js";
import { Models } from "./models.js";

/** How long an app's stop waits for a process without a key to end before it lets go of it (its node then kills
 * it: SIGTERM was sent). */
const RELEASE_STOP_MS = 1_000;
/** How often stopping a gone owner's process waits for its node to connect. */
const STOP_POLL_MS = 250;

const LOST: NodeProcessExit = { code: null, signal: null, error: LOST_ERROR };
const OFFLINE: NodeProcessExit = { code: null, signal: null, error: "Its node is not connected: with no server attached, the node stops it after its grace period" };

/** What to start, checked by its caller. */
export interface SpawnRequest {
  command: string | readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  maxLineBytes?: number;
  signal?: AbortSignal;
  key?: string;
  ifRunning: "replace" | "attach";
}

export interface ProcessView {
  key: string;
  nodeId: string;
  pid: number;
  /** `running`: a handle of this app reads it; `detached`: none does (it runs on its node unless it ended since or
   * its node lost it); `ended`: a handle saw it end. */
  state: "running" | "detached" | "ended";
  exit?: NodeProcessExit;
  startedAt: string;
}

interface Live { owner: string; nodeId: string; key: string | null; handle: NodeProcess }

/** Keyed: a key's secret values are in no record, and two hashes of one value cannot be compared off the
 * server. */
function commandHash({ command, cwd = ".", env = {} }: SpawnRequest): string {
  const sorted = Object.entries(env).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHmac("sha256", getEncryptionSecret()).update(JSON.stringify([cwd, command, sorted])).digest("hex");
}

export class Processes {
  private readonly live = new Set<Live>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** The app is stopping: nothing more is recorded. */
  private released = false;
  /** The app is gone: nothing more is waited for. */
  private closed = false;

  /** Read at each use: the state is built after this. */
  constructor(private readonly app: () => AppState) {}

  /** Starts a process for `owner` on `node`, or with a key and `attach` gives the one kept there. */
  async spawn(owner: string, node: NodeModel, request: SpawnRequest): Promise<NodeProcess> {
    if (this.released) throw new Error("The app is stopping: it starts no process");
    const { key } = request;
    if (key === undefined) return this.track({ owner, nodeId: node.id, key: null, handle: await node.host().spawn(request.command, spawnSpec(request)) });
    return this.serial(owner, node.id, key, async () => this.track({ owner, nodeId: node.id, key, handle: await this.keyed(owner, node, key, request) }));
  }

  /** The owner's kept processes, in key order. */
  list(owner: string): ProcessView[] {
    return listProcesses(owner).map(record => this.view(record));
  }

  /** Stops the process kept under `key` and forgets the key: how it ended, or null when none is kept. */
  stop(owner: string, node: NodeModel, key: string): Promise<NodeProcessExit | null> {
    return this.serial(owner, node.id, key, () => this.stopKeyed(owner, node, key));
  }

  /** Lets go of the owner's keyed processes: they run on, recorded. */
  detach(owner: string): void {
    for (const entry of this.of(owner)) this.letGo(entry);
  }

  /** The owner is gone from this app: its processes without a key are stopped, its keyed ones let go. */
  async unload(owner: string): Promise<void> {
    await Promise.all(this.of(owner).map(async entry => {
      if (entry.key === null) await entry.handle.stop();
      else this.letGo(entry);
    }));
  }

  /**
   * The app stops (a reload, a restart), before its node links close: keyed processes are let go, with where
   * their output was read to, and the others stopped (waited for up to `RELEASE_STOP_MS`).
   */
  async release(): Promise<void> {
    const all = [...this.live];
    for (const entry of all) this.letGo(entry);
    this.released = true;
    this.closed = true;
    await Promise.all(all.filter(entry => entry.key === null).map(async ({ handle }) => {
      await Promise.race([handle.stop(), Bun.sleep(RELEASE_STOP_MS)]);
      handle.detach();
    }));
  }

  /** The app is gone: nothing more is waited for. */
  close(): void {
    this.closed = true;
  }

  /**
   * Stops the kept processes of every owner `gone` says is gone (with `only`, of that owner alone) and forgets
   * them. One on a node not connected (as every node is just after a restart) is stopped once its node connects,
   * if that is within the node's grace period, after which the node has stopped it itself; meanwhile its record
   * stays, and the owner coming back keeps it.
   */
  async stopOwners(gone: (owner: string) => boolean, only?: string): Promise<void> {
    const owners = only === undefined ? processOwners() : [only];
    await Promise.all(owners.filter(gone).flatMap(owner => listProcesses(owner).map(async ({ nodeId, key }) => {
      const failed = (error: unknown) => logger.warn(`Stopping process ${key} of ${owner} on node ${nodeId} failed: ${error instanceof Error ? error.message : String(error)}`);
      const stop = (node: NodeModel) => this.serial(owner, nodeId, key, () => this.stopKeyed(owner, node, key)).then(() => undefined, failed);
      const nodeOf = () => new Models(this.app()).nodes.get(nodeId);
      let node: NodeModel;
      try { node = nodeOf(); }
      catch { deleteProcess(owner, nodeId, key); return; }
      if (connected(node) || this.liveOf(owner, nodeId, key)) { await stop(node); return; }
      // Not awaited: an owner going does not wait for a node away.
      void (async () => {
        for (const deadline = Date.now() + PROCESS_REATTACH_WINDOW_MS; Date.now() < deadline && !this.closed; await Bun.sleep(STOP_POLL_MS)) {
          if (!gone(owner) || !getProcess(owner, nodeId, key)) return;
          const now = nodeOf();
          if (connected(now)) { await stop(now); return; }
        }
        if (!this.closed && gone(owner)) deleteProcess(owner, nodeId, key);
      })().catch(failed);
    })));
  }

  /** A keyed spawn, its key's turn come: attach to the process kept there, or stop it, then start one. */
  private async keyed(owner: string, node: NodeModel, key: string, request: SpawnRequest): Promise<NodeProcess> {
    const host = node.host();
    const hash = commandHash(request);
    const handle = { key, ...(request.maxLineBytes === undefined ? {} : { maxLineBytes: request.maxLineBytes }), ...(request.signal ? { signal: request.signal } : {}) };
    const live = this.liveOf(owner, node.id, key);
    const record = getProcess(owner, node.id, key);
    let previous: NodeProcessExit | undefined = record?.ended ?? undefined;
    if (request.ifRunning === "attach" && record?.commandHash === hash && !record.ended) {
      // This app's handle: one per process, so its options stay as they were.
      if (live) return live.handle;
      try { return await host.attach(record.processId, record.outputOffset, { ...handle, reattached: true }); }
      catch (error) {
        if (refusalCode(error) !== "not_found") throw error;
        previous = LOST;
      }
    } else if (live) {
      await live.handle.stop();
      previous = undefined;
    } else if (record && !record.ended) {
      // Replaced, so stopped first: a server on a port must free it for the next.
      if (await host.stopProcess(record.processId) === null) previous = LOST;
    }
    const started = await host.spawn(request.command, spawnSpec(request), { key, ...(previous ? { previous } : {}) });
    recordProcess({ owner, nodeId: node.id, key, processId: started.id, pid: started.pid, commandHash: hash });
    return started;
  }

  private async stopKeyed(owner: string, node: NodeModel, key: string): Promise<NodeProcessExit | null> {
    const record = getProcess(owner, node.id, key);
    const live = this.liveOf(owner, node.id, key);
    let exit: NodeProcessExit | null = record?.ended ?? null;
    if (live) exit = await live.handle.stop();
    else if (record && !record.ended) {
      let host: NodeHost | null = null;
      try { host = node.host(); } catch { /* not connected */ }
      exit = host ? await host.stopProcess(record.processId) ?? LOST : OFFLINE;
    }
    if (record) deleteProcess(owner, node.id, key);
    return record || live ? exit : null;
  }

  private view(record: ProcessRecord): ProcessView {
    const running = this.liveOf(record.owner, record.nodeId, record.key)?.handle.id === record.processId;
    return {
      key: record.key, nodeId: record.nodeId, pid: record.pid, startedAt: record.startedAt,
      state: running ? "running" : record.ended ? "ended" : "detached",
      ...(record.ended ? { exit: record.ended } : {}),
    };
  }

  private track(entry: Live): NodeProcess {
    if ([...this.live].some(known => known.handle === entry.handle)) return entry.handle;
    this.live.add(entry);
    void entry.handle.exited.then(exit => {
      this.live.delete(entry);
      if (entry.key === null || exit.detached || this.released) return;
      endProcess(entry.owner, entry.nodeId, entry.key, entry.handle.id, exit);
    });
    return entry.handle;
  }

  /** Recorded with where its output was read to, for the next attach. */
  private letGo(entry: Live): void {
    if (entry.key === null) return;
    setProcessOffset(entry.owner, entry.nodeId, entry.key, entry.handle.id, entry.handle.offset);
    entry.handle.detach();
  }

  private of(owner: string): Live[] {
    return [...this.live].filter(entry => entry.owner === owner);
  }

  private liveOf(owner: string, nodeId: string, key: string): Live | undefined {
    return [...this.live].find(entry => entry.owner === owner && entry.nodeId === nodeId && entry.key === key);
  }

  private serial<T>(owner: string, nodeId: string, key: string, work: () => Promise<T>): Promise<T> {
    const id = JSON.stringify([owner, nodeId, key]);
    const next = (this.chains.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    const tail = next.catch(() => {});
    this.chains.set(id, tail);
    void tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
    return next;
  }
}

function connected(node: NodeModel): boolean {
  try { node.host(); return true; } catch { return false; }
}

function spawnSpec({ cwd, env, maxLineBytes, signal }: SpawnRequest) {
  return { ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env }), ...(maxLineBytes === undefined ? {} : { maxLineBytes }), ...(signal === undefined ? {} : { signal }) };
}
