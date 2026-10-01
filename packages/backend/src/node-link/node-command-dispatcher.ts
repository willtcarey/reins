import { DeliveryDeferred, nodeResult, type NodeCommand, type NodeResult } from "@reins/node-protocol";
import { logger } from "../logger.js";
import {
  claimCommand, commandHeader, deleteFailedCommand, getCommand, getNodeCommand, queuedCommands, requeueCommand, settleCommand,
  type CommandHeader, type CommandRow,
} from "./node-command-store.js";

/** Where the dispatcher delivers: the node hub. */
export interface DispatchTarget {
  /** Sends the session's commands to the node of its current source, resolved once for this delivery;
   * null while that source is invalid or its node has no negotiated connection. */
  route(sessionId: string): ((command: NodeCommand) => Promise<NodeResult>) | null;
  /** After a command settled. */
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
 * if two dispatchers are accidentally started.
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

  constructor(private readonly target: DispatchTarget, options: { maxConcurrentSessions?: number } = {}) {
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? MAX_CONCURRENT_SESSIONS;
  }

  /** Scans now and every 30 seconds. Startup recovery is not the dispatcher's: it runs once per
   * process when the database opens (`openDb`), never while this dispatcher is delivering. */
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
  private deliverable(row: CommandRow): ((command: NodeCommand) => Promise<NodeResult>) | null {
    if (this.deferred.get(row.id) === this.generation) return null;
    return this.target.route(row.session_id);
  }

  /** Must claim synchronously (no await before `deliverCommand`): scans rely on it to see the chain's work. */
  private async deliverSession(rows: CommandRow[]): Promise<void> {
    for (const row of rows) {
      if (this.stopped) return;
      const send = this.deliverable(row);
      if (!send) return;
      const generation = this.generation;
      const command = commandHeader(row.command_json);
      const outcome = await deliverCommand(row.id, async () => {
        const stored = getNodeCommand(row.id);
        if (!stored) throw new Error(`Command ${row.id} is no longer in the outbox`);
        return send(stored.command);
      });
      // Not claimable: another dispatcher is delivering this session's work (a handler reload). Skipped
      // until the next wake, so scans do not spin on it; that dispatcher's chain delivers what follows.
      if (!outcome.claimed) { this.deferred.set(row.id, generation); return; }
      if (outcome.state === "queued") {
        this.deferred.set(row.id, generation);
        // A wake during the attempt could not see this row (it was dispatching): scan again now.
        if (generation !== this.generation) this.rescan = true;
        return;
      }
      this.target.delivered(row.session_id, command, outcome);
      if (outcome.state === "failed") deleteFailedCommand(row.id);
    }
  }

}

/** `claimed: false`: not sent (not queued, or behind earlier work). `queued`: deferred and requeued (tried
 * again on a later wake). Otherwise the recorded result: an admitted command is already deleted, a failed
 * one is left for its failure to be notified and then removed. */
export type DeliveryOutcome =
  | { claimed: false }
  | { claimed: true; state: "queued" }
  | { claimed: true; state: "admitted" | "failed"; result: NodeResult };

/** Delivers one outbox command: claims it once and settles it with `send`'s result. `DeliveryDeferred`
 * requeues it; other delivery exceptions are terminal failures, never automatically retried. */
export async function deliverCommand(id: string, send: () => Promise<NodeResult>): Promise<DeliveryOutcome> {
  if (!claimCommand(id)) return { claimed: false };
  let result: NodeResult;
  try {
    result = nodeResult.parse(await send());
  } catch (error) {
    if (error instanceof DeliveryDeferred) {
      logger.warn(`Command dispatch deferred for ${getCommand(id)?.session_id}:`, error.message);
      requeueCommand(id);
      return { claimed: true, state: "queued" };
    }
    logger.error(`Command dispatch failed for ${getCommand(id)?.session_id}:`, error);
    result = { ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
  settleCommand(id, result.ok ? "admitted" : "failed", JSON.stringify(result));
  return { claimed: true, state: result.ok ? "admitted" : "failed", result };
}
