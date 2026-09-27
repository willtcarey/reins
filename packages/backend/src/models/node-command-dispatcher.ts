import { getSession, type SessionRow } from "../session-store.js";
import { logger } from "../logger.js";
import { getSource } from "../node-store.js";
import { getCommand, blockInterruptedDispatches, deleteFailedCommand, queuedCommands, hasBlockingPredecessor, type InputRow } from "../node-command-store.js";
import { getWork, workForSession, registerCommandWake } from "./node-command-projection.js";
import { deliverCommand } from "./node-command-transport.js";
import { executionTargetFor } from "../runtimes/execution-target.js";
import { onCommandDelivered } from "./node-command-notifications.js";
import { commitMove } from "./session-ownership.js";
import type { ServerState } from "../state.js";

export { blockInterruptedDispatches };
export async function waitForAdmission(state: ServerState, sessionId: string): Promise<void> {
  const work = workForSession(sessionId);
  if (!work) {
    if (getSession(sessionId)?.storage_owner === "internal-node") throw new Error("Session open failed");
    return; // pre-outbox server-owned sessions reopen normally
  }
  if (work.state === "admitted") return;
  if (work.state === "failed") throw new Error(`Session open failed: ${work.result && !work.result.ok ? work.result.error.message : "unknown error"}`);
  if (work.state === "unknown") throw new Error("Session open outcome unknown after restart");
  if (work.state === "queued" && getSource(work.sourceId)?.node_id !== "internal") throw new Error("Execution source unavailable; session open queued");
  // An input submitted immediately after create must not bypass or race open.
  // Drain on demand when no server handler is installed (e.g. scripting tests).
  const dispatcher = dispatcherForInput(state);
  if (work.state === "queued") {
    const waiting = dispatcher.wait(work.id);
    dispatcher.wake();
    await waiting;
  }
  else await dispatcher.wait(work.id);
  return waitForAdmission(state, sessionId);
}

/** Sessions delivering at once; each has at most one command in flight. Bounds the node requests
 * (and their admission timeouts) a startup backlog or burst of sessions can open at the same time. */
export const MAX_CONCURRENT_SESSIONS = 16;

/**
 * Delivers queued outbox commands: one chain per session, strictly in outbox order and one command at a
 * time, with different sessions delivering concurrently (up to `maxConcurrentSessions`). A wake is only
 * a hint: each scan queries SQLite again, and the claim (`claimCommand`) is the guard against two
 * commands of one session in flight, including across dispatcher instances during a handler reload.
 */
export class NodeCommandDispatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** Session ID → its delivery chain. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Requeued commands → the wake generation their deferred attempt began in: skipped until the next
   * wake so a deferral cannot spin, but a wake that arrived while the attempt was in flight (e.g. a new
   * node link negotiated) retries it when the busy chain ends instead of losing that wake. */
  private readonly deferred = new Map<string, number>();
  private generation = 0;
  /** A scan skipped work for a busy session or a full cap: scan again when a chain ends. */
  private rescan = false;
  private readonly maxConcurrentSessions: number;
  private waiters = new Map<string, Array<() => void>>();
  wait(id: string): Promise<void> {
    if (getWork(id)?.state !== "queued" && getWork(id)?.state !== "dispatching") return Promise.resolve();
    return new Promise(resolve => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
  }

  constructor(private readonly state: ServerState, options: { maxConcurrentSessions?: number } = {}) {
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? MAX_CONCURRENT_SESSIONS;
    registerCommandWake(state, () => this.wake());
  }

  start(): void {
    // Recovery belongs to process startup, not handler installation: a previous
    // hot-reload handler may still be dispatching against this database.
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.wake(), 30_000);
    this.timer.unref?.();
    this.wake();
  }

  /** Starts no further deliveries; chains finish the command they are delivering. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (dispatchers.get(this.state) === this) dispatchers.delete(this.state);
  }

  wake(): void {
    this.generation++;
    this.deferred.clear();
    this.scan();
  }

  /** Wakes, then resolves once no session chain is delivering. */
  async drain(): Promise<void> {
    this.wake();
    while (this.chains.size) await Promise.all(this.chains.values());
  }

  private scan(): void {
    this.resolveSettledWaiters();
    if (this.stopped) return;
    this.rescan = false;
    const bySession = new Map<string, InputRow[]>();
    for (const row of queuedCommands()) bySession.set(row.session_id, [...(bySession.get(row.session_id) ?? []), row]);
    for (const [sessionId, rows] of bySession) {
      if (this.chains.has(sessionId)) { this.rescan = true; continue; }
      if (!this.deliverable(rows[0]!)) continue; // later rows wait behind the first
      if (this.chains.size >= this.maxConcurrentSessions) { this.rescan = true; break; }
      const chain = this.deliverSession(rows)
        .catch(error => logger.error(`Command delivery failed for ${sessionId}:`, error))
        .finally(() => {
          this.chains.delete(sessionId);
          if (this.rescan) this.scan();
        });
      this.chains.set(sessionId, chain);
    }
  }

  /** Current source, not the one at submission: a session may be reassigned before delivery. */
  private deliverable(row: InputRow): SessionRow | null {
    if (this.deferred.get(row.id) === this.generation || hasBlockingPredecessor(row.id)) return null;
    const session = getSession(row.session_id);
    const source = session && getSource(session.source_id);
    return session && source && source.project_id === session.project_id && source.node_id === "internal" ? session : null;
  }

  /** Must claim synchronously (no await before `deliverCommand`): scans rely on it to see the chain's work. */
  private async deliverSession(rows: InputRow[]): Promise<void> {
    for (const row of rows) {
      if (this.stopped) return;
      const session = this.deliverable(row);
      if (!session) return;
      const generation = this.generation;
      const command = getWork(row.id)?.command ?? null;
      const claimed = await deliverCommand(row.id, async () => {
        if (!command) throw new Error("Stored node command is invalid");
        return executionTargetFor(this.state, session).send(command, row.id);
      }, command && (command.op === "session.hydrate" || command.op === "session.release") ? result => commitMove(row.session_id, command, result) : undefined);
      if (!claimed) return; // another dispatcher owns it
      onCommandDelivered(this.state, row);
      const outcome = getCommand(row.id)?.state;
      if (outcome === "queued") {
        this.deferred.set(row.id, generation);
        // A wake during the attempt could not see this row (it was dispatching): scan again now.
        if (generation !== this.generation) this.rescan = true;
        return;
      }
      if (outcome === "failed") deleteFailedCommand(row.id);
      this.resolveWaiters(row.id);
    }
  }

  private resolveWaiters(id: string): void {
    for (const resolve of this.waiters.get(id) ?? []) resolve();
    this.waiters.delete(id);
  }

  /** Work settled by another dispatcher (a handler reload) releases this one's waiters on its next scan. */
  private resolveSettledWaiters(): void {
    for (const id of this.waiters.keys()) {
      const state = getWork(id)?.state;
      if (state !== "queued" && state !== "dispatching") this.resolveWaiters(id);
    }
  }
}

const dispatchers = new WeakMap<ServerState, NodeCommandDispatcher>();
export function wakeDispatcher(state: ServerState): void { dispatchers.get(state)?.wake(); }
export function wakeOpenForInput(state: ServerState): void { dispatcherForInput(state).wake(); }
export function recoverInterruptedNodeCommands(): void { blockInterruptedDispatches(); }

function dispatcherForInput(state: ServerState): NodeCommandDispatcher {
  let dispatcher = dispatchers.get(state);
  if (!dispatcher) { dispatcher = new NodeCommandDispatcher(state); dispatchers.set(state, dispatcher); }
  return dispatcher;
}

export function dispatcherFor(state: ServerState): NodeCommandDispatcher {
  const dispatcher = dispatcherForInput(state);
  dispatcher.start();
  return dispatcher;
}
