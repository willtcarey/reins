import { deliveryPolicy, nodeCommand, nodeResult, type NodeCommand, type NodeResult } from "@reins/node/contract";
import { getSession } from "../session-store.js";
import { getSource } from "../node-store.js";
import { adapterFor } from "../runtimes/node-execution.js";
import { getCommand, insertCommandWithSession, claimCommand, settleCommand, blockInterruptedDispatches, queuedCommandIds, type CommandState } from "../node-command-store.js";
import type { ServerState } from "../state.js";

export { blockInterruptedDispatches };
type Work = { id: string; sessionId: string; sourceId: number; state: CommandState; command: NodeCommand; result: NodeResult | null };

export function getWork(id: string): Work | null {
  const row = getCommand(id);
  if (!row) return null;
  const command = nodeCommand.parse({ ...JSON.parse(row.command_json), sessionId: row.session_id, sourceId: row.source_id });
  return { id: row.id, sessionId: row.session_id, sourceId: row.source_id, state: row.state, command, result: row.result_json ? nodeResult.parse(JSON.parse(row.result_json)) : null };
}

export function scheduleWork(id: string, command: NodeCommand, create: () => void): Work {
  if (deliveryPolicy(command) !== "submit-work" || command.op !== "session.open" || command.mode !== "create") throw new Error("Only submit-work commands may be scheduled");
  nodeCommand.parse(command);
  insertCommandWithSession(id, command.sessionId, JSON.stringify({ op: command.op, mode: command.mode }), create);
  return getWork(id)!;
}

/** Unknown outcomes are never replayed without durable node-side admission proof. */
export async function dispatchWork(id: string, send: (command: NodeCommand, id: string) => Promise<NodeResult>, available = true): Promise<Work> {
  const work = getWork(id);
  if (!work) throw new Error(`Unknown command: ${id}`);
  if (work.state !== "queued" || !available) return work;
  const session = getSession(work.sessionId);
  const source = session && getSource(session.source_id);
  if (!source || source.project_id !== session?.project_id) return work;
  if (!claimCommand(id)) return getWork(id)!;
  try {
    const current = getWork(id)!;
    const result = nodeResult.parse(await send(current.command, id));
    settleCommand(id, result.ok ? "admitted" : "failed", JSON.stringify(result));
  } catch {
    settleCommand(id, "unknown");
  }
  return getWork(id)!;
}

/** Signal is only a hint: each pass queries SQLite again. */
export class NodeCommandDispatcher {
  private running = false;
  private pending = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private waiters = new Map<string, Array<() => void>>();
  private errors = new Map<string, unknown>();

  error(id: string): unknown { return this.errors.get(id); }

  wait(id: string): Promise<void> {
    if (getWork(id)?.state !== "queued" && getWork(id)?.state !== "dispatching") return Promise.resolve();
    return new Promise(resolve => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
  }

  constructor(private readonly state: ServerState) {}

  start(): void {
    blockInterruptedDispatches();
    this.timer ??= setInterval(() => this.wake(), 30_000);
    this.timer.unref?.();
    this.wake();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

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
        for (const id of queuedCommandIds()) {
          const work = getWork(id);
          if (!work) continue;
          const session = getSession(work.sessionId);
          const source = session && getSource(session.source_id);
          if (!source || source.project_id !== session?.project_id || source.node_id !== "internal") continue;
          await dispatchWork(id, async (command, commandId) => {
            try { return await adapterFor(source).open(this.state, command, commandId); }
            catch (error) { this.errors.set(id, error); throw error; }
          });
          for (const resolve of this.waiters.get(id) ?? []) resolve();
          this.waiters.delete(id);
        }
      } while (this.pending);
    } finally { this.running = false; }
  }
}

const dispatchers = new WeakMap<ServerState, NodeCommandDispatcher>();
export function dispatcherFor(state: ServerState): NodeCommandDispatcher {
  let dispatcher = dispatchers.get(state);
  if (!dispatcher) { dispatcher = new NodeCommandDispatcher(state); dispatchers.set(state, dispatcher); dispatcher.start(); }
  return dispatcher;
}
