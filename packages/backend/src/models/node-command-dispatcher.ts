import type { NodeCommand, NodeResult } from "@reins/node/contract";
import { getSession } from "../session-store.js";
import { logger } from "../logger.js";
import { commandHeader, deleteFailedCommand, getNodeCommand, queuedCommands, isCommandPending, type CommandHeader, type CommandRow } from "../node-command-store.js";
import { deliverCommand } from "./node-command-delivery.js";
import { commitPlacement, queueRehydration } from "./session-ownership.js";
import { resolveSessionSource } from "../runtimes/node-source.js";

/** Where the dispatcher delivers: the node hub. */
export interface DispatchTarget {
  /** Whether a negotiated connection of the node is open. */
  connected(nodeId: string): boolean;
  /** Delivers one command to the node of its session's source. */
  send(command: NodeCommand): Promise<NodeResult>;
  /** After a command settled (its placement change already committed). */
  delivered(sessionId: string, command: CommandHeader, outcome: { state: "admitted" | "failed"; result: NodeResult }): void;
}

/** Sessions delivering at once; each has at most one command in flight. Bounds the node requests
 * (and their admission timeouts) a startup backlog or burst of sessions can open at the same time. */
export const MAX_CONCURRENT_SESSIONS = 16;

/**
 * Delivers queued outbox commands: one chain per session, strictly in outbox order and one command at a
 * time, with different sessions delivering concurrently (up to `maxConcurrentSessions`). A session's
 * commands are delivered only while its source is valid and that source's node is connected; the rest
 * wait until a wake finds the node connected. A wake is only a hint: each scan queries SQLite again, and
 * the claim (`claimCommand`) is the guard against two commands of one session in flight, including
 * across dispatcher instances during a handler reload.
 */
export class NodeCommandDispatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** Session ID → its delivery chain. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Requeued (or unclaimable) commands → the wake generation their attempt began in: skipped until the next
   * wake so a deferral cannot spin, but a wake that arrived while the attempt was in flight (e.g. a new
   * node link negotiated) retries it when the busy chain ends instead of losing that wake. */
  private readonly deferred = new Map<string, number>();
  private generation = 0;
  /** A scan skipped work for a busy session or a full cap: scan again when a chain ends. */
  private rescan = false;
  private readonly maxConcurrentSessions: number;
  private waiters = new Map<string, Array<() => void>>();
  wait(id: string): Promise<void> {
    if (!isCommandPending(id)) return Promise.resolve();
    return new Promise(resolve => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
  }

  constructor(private readonly target: DispatchTarget, options: { maxConcurrentSessions?: number } = {}) {
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? MAX_CONCURRENT_SESSIONS;
  }

  /** Scans now and every 30 seconds. Startup recovery is not the dispatcher's: it runs once per
   * process when the database opens (`openDb`), as a previous handler may still be delivering. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.wake(), 30_000);
    this.timer.unref?.();
    void this.wake();
  }

  /** Starts no further deliveries; chains finish the command they are delivering. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Scans now; resolves once no session chain is delivering. */
  async wake(): Promise<void> {
    this.generation++;
    this.deferred.clear();
    this.scan();
    while (this.chains.size) await Promise.all(this.chains.values());
  }

  private scan(): void {
    this.resolveSettledWaiters();
    if (this.stopped) return;
    this.rescan = false;
    const bySession = new Map<string, CommandRow[]>();
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

  /** Current source, not the one at submission: a session may be reassigned before delivery. Work
   * behind a command another dispatcher is delivering is not claimed (`claimCommand`, the one guard). */
  private deliverable(row: CommandRow): boolean {
    if (this.deferred.get(row.id) === this.generation) return false;
    const session = getSession(row.session_id);
    const placed = session && resolveSessionSource(session);
    return !!placed && this.target.connected(placed.nodeId);
  }

  /** Must claim synchronously (no await before `deliverCommand`): scans rely on it to see the chain's work.
   * A `not_found` for lost node data requeues the work behind a hydrate (`queueRehydration`); the chain
   * ends and the rescan delivers the hydrate first. */
  private async deliverSession(rows: CommandRow[]): Promise<void> {
    for (const row of rows) {
      if (this.stopped) return;
      if (!this.deliverable(row)) return;
      const generation = this.generation;
      const command = commandHeader(row.command_json);
      const outcome = await deliverCommand(row.id, async () => {
        const stored = getNodeCommand(row.id);
        if (!stored) throw new Error(`Command ${row.id} is no longer in the outbox`);
        return this.target.send(stored.command);
      }, result => {
        if (queueRehydration(row.id, row.session_id, command, result)) return "requeue";
        commitPlacement(row.session_id, command, result);
      });
      // Not claimable: another dispatcher is delivering this session's work (a handler reload). Skipped
      // until the next wake, so scans do not spin on it; that dispatcher's chain delivers what follows.
      if (!outcome.claimed) { this.deferred.set(row.id, generation); return; }
      if (outcome.state === "requeued") { this.rescan = true; return; }
      if (outcome.state === "queued") {
        this.deferred.set(row.id, generation);
        // A wake during the attempt could not see this row (it was dispatching): scan again now.
        if (generation !== this.generation) this.rescan = true;
        return;
      }
      this.target.delivered(row.session_id, command, outcome);
      if (outcome.state === "failed") deleteFailedCommand(row.id);
      this.resolveWaiters(row.id);
    }
  }

  private resolveWaiters(id: string): void {
    for (const resolve of this.waiters.get(id) ?? []) resolve();
    this.waiters.delete(id);
  }

  /** Work settled by another dispatcher (a handler reload) releases this one's waiters on its next scan. */
  private resolveSettledWaiters(): void {
    for (const id of this.waiters.keys()) if (!isCommandPending(id)) this.resolveWaiters(id);
  }
}
