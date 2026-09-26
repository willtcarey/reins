import { getSession } from "../session-store.js";
import { getSource } from "../node-store.js";
import { getCommand, blockInterruptedDispatches, queuedCommands, hasBlockingPredecessor } from "../node-command-store.js";
import { getWork, workForSession, registerCommandWake } from "./node-command-projection.js";
import { deliverCommand } from "./node-command-transport.js";
import { internalNodeFor, provisionForSession } from "../runtimes/internal-node.js";
import { sendLegacySessionCommand } from "../runtimes/legacy-session-execution.js";
import { onCommandDelivered } from "./node-command-notifications.js";
import type { ServerState } from "../state.js";

export { blockInterruptedDispatches };
export async function waitForAdmission(state: ServerState, sessionId: string): Promise<void> {
  const work = workForSession(sessionId);
  if (!work) return; // pre-outbox sessions reopen normally
  if (work.state === "admitted") return;
  if (work.state === "failed") throw new Error(`Session open failed: ${work.result && !work.result.ok ? work.result.error.message : "unknown error"}`);
  if (work.state === "unknown") throw new Error("Session open outcome unknown; manual reconciliation required");
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

/** Signal is only a hint: each pass queries SQLite again. */
export class NodeCommandDispatcher {
  private running = false;
  private pending = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private waiters = new Map<string, Array<() => void>>();
  wait(id: string): Promise<void> {
    if (getWork(id)?.state !== "queued" && getWork(id)?.state !== "dispatching") return Promise.resolve();
    return new Promise(resolve => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
  }

  constructor(private readonly state: ServerState) { registerCommandWake(state, () => this.wake()); }

  start(): void {
    // Recovery belongs to process startup, not handler installation: a previous
    // hot-reload handler may still be dispatching against this database.
    if (this.timer) return;
    this.timer ??= setInterval(() => this.wake(), 30_000);
    this.timer.unref?.();
    this.wake();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; dispatchers.delete(this.state); }

  wake(): void {
    if (this.running) { this.pending = true; return; }
    void this.drain();
  }

  async drain(): Promise<void> {
    if (this.running) { this.pending = true; return; }
    this.running = true;
    try {
      do {
        this.pending = false;
        for (const row of queuedCommands()) {
          if (hasBlockingPredecessor(row.id)) continue;
          const session = getSession(row.session_id);
          const source = session && getSource(session.source_id);
          if (!session || !source || source.project_id !== session.project_id || source.node_id !== "internal") continue;
          await deliverCommand(row.id, () => {
            const command = getWork(row.id)!.command;
            if (session.storage_owner !== "internal-node") return sendLegacySessionCommand(this.state, command);
            const provision = provisionForSession(session.id);
            return internalNodeFor(this.state).send(command, provision.binding, row.id);
          });
          onCommandDelivered(this.state, row);
          const outcome = getCommand(row.id)?.state;
          if (outcome === "queued" || outcome === "dispatching") continue;
          for (const resolve of this.waiters.get(row.id) ?? []) resolve();
          this.waiters.delete(row.id);
        }
      } while (this.pending);
    } finally { this.running = false; }
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
