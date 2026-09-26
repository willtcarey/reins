import type { Database } from "bun:sqlite";
import type { NodeCommand, NodeResult } from "./contract.js";
import { bindNodeSession, deliverNodeCommits, initializeNodeStorage, nodeAdmissionReceipt, nodeSessionBinding, openNodeStorage, recordNodeAdmission, type NodeCommitDelivery, type NodeSessionBinding } from "./storage.js";
import { buildNodeRuntime, type NodeRuntimePolicy } from "./runtime/build.js";
import type { AgentHarnessPiRuntime } from "./runtime/pi-runtime.js";

/** Product policy is supplied in-process; Pi assembly, canonical storage and runtime handles remain node-owned. */
export interface NodeDependencies {
  db: Database;
  deliver: NodeCommitDelivery;
  prepare: (sessionId: string, binding: NodeSessionBinding) => Promise<NodeRuntimePolicy>;
}

export interface Node {
  stop(): void;
  hasRuntime(sessionId: string): boolean;
  runtimeCount(): number;
  anyStreaming(): boolean;
  runtime(sessionId: string): AgentHarnessPiRuntime | undefined;
  isStreaming(sessionId: string): boolean;
  close(sessionId: string): Promise<void>;
  open(sessionId: string, binding: NodeSessionBinding): Promise<AgentHarnessPiRuntime>;
  send(input: NodeCommand, binding: NodeSessionBinding, commandId?: string): Promise<NodeResult>;
}

const instances = new WeakMap<Database, { node: Node; update: (dependencies: NodeDependencies) => void; retain: () => void }>();

export function startNode({ db, deliver, prepare }: NodeDependencies): Node {
  const existing = instances.get(db);
  if (existing) {
    existing.update({ db, deliver, prepare });
    existing.retain();
    return existing.node;
  }
  initializeNodeStorage(db);
  let running = true;
  let leases = 1;
  let currentDeliver = deliver;
  let currentPrepare = prepare;
  const runtimes = new Map<string, AgentHarnessPiRuntime>();
  const openings = new Map<string, Promise<AgentHarnessPiRuntime>>();
  const verify = (id: string, binding: NodeSessionBinding) => {
    const stored = nodeSessionBinding(db, id);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(binding)) throw new Error(`Node session binding mismatch: ${id}`);
    return stored;
  };
  const node: Node = {
    stop(): void {
      if (--leases > 0) return;
      running = false;
      instances.delete(db);
    },
    hasRuntime(sessionId: string): boolean { return runtimes.has(sessionId); },
    runtimeCount(): number { return runtimes.size; },
    anyStreaming(): boolean { return [...runtimes.values()].some(runtime => runtime.isStreaming()); },
    runtime(sessionId: string): AgentHarnessPiRuntime | undefined { return runtimes.get(sessionId); },
    isStreaming(sessionId: string): boolean { return runtimes.get(sessionId)?.isStreaming() ?? false; },
    async close(sessionId: string): Promise<void> {
      const runtime = runtimes.get(sessionId);
      if (!runtime) return;
      if (runtime.isStreaming()) throw new Error(`Cannot close active node runtime: ${sessionId}`);
      try { await runtime.close(); }
      finally { runtimes.delete(sessionId); }
    },
    async open(sessionId: string, binding: NodeSessionBinding): Promise<AgentHarnessPiRuntime> {
      if (!running) throw new Error("Node stopped");
      const stored = verify(sessionId, binding);
      const cached = runtimes.get(sessionId);
      if (cached) return cached;
      const pending = openings.get(sessionId);
      if (pending) return pending;
      const opening = (async () => {
        const policy = await currentPrepare(sessionId, stored);
        const runtime = await buildNodeRuntime(sessionId, stored,
          await openNodeStorage(db, sessionId, (id, seq, writes) => currentDeliver(id, seq, writes)), policy);
        runtimes.set(sessionId, runtime);
        return runtime;
      })();
      openings.set(sessionId, opening);
      try { return await opening; }
      finally { openings.delete(sessionId); }
    },
    async send(input: NodeCommand, binding: NodeSessionBinding, commandId?: string): Promise<NodeResult> {
      if (!running) throw new Error("Node stopped");
      const payload = JSON.stringify(input);
      const receipt = commandId ? nodeAdmissionReceipt(db, commandId) : null;
      if (receipt && (receipt.sessionId !== input.sessionId || receipt.operation !== input.op || receipt.payload !== payload)) {
        throw new Error(`Node admission receipt mismatch: ${commandId}`);
      }
      if (input.op === "session.provision") {
        if (input.sourceId !== binding.sourceId) throw new Error(`Node source mismatch: ${input.sessionId}`);
        if (commandId) recordNodeAdmission(db, commandId, input.sessionId, input.op, payload, () => bindNodeSession(db, input.sessionId, binding));
        else bindNodeSession(db, input.sessionId, binding);
        verify(input.sessionId, binding);
        // Replication unavailability does not invalidate the durable local admission.
        await deliverNodeCommits(db, input.sessionId, (id, seq, writes) => currentDeliver(id, seq, writes)).catch(() => undefined);
        return { ok: true, value: { kind: "provisioned" } };
      }
      verify(input.sessionId, binding);
      if (receipt) {
        // A positive receipt is safe to query; an absent receipt is NOT proof that Pi did not admit.
        if (input.op === "session.prompt" || input.op === "session.steer") return { ok: true, value: { kind: "admitted", inputId: input.clientId } };
        throw new Error(`Unsupported node admission receipt: ${input.op}`);
      }
      const ready = await this.open(input.sessionId, binding);
      switch (input.op) {
        case "session.prompt":
        case "session.steer": {
          const options = { reinsId: input.clientId, ...(input.sourceSessionId ? { metadata: { sourceSessionId: input.sourceSessionId } } : {}) };
          if (input.op === "session.prompt") await ready.prompt(input.content, options);
          else await ready.steer(input.content, options);
          // Pi admission and this insert are separate transactions. Never infer non-admission
          // from a missing receipt after an interrupted send; server unknown remains fenced.
          if (commandId) recordNodeAdmission(db, commandId, input.sessionId, input.op, payload, () => {});
          return { ok: true, value: { kind: "admitted", inputId: input.clientId } };
        }
        case "session.abort":
          await ready.abort();
          return { ok: true, value: { kind: "aborted", aborted: true } };
        case "session.resumePending":
          if (!ready.resumePendingOperation) throw new Error("Runtime does not support pending-operation resume");
          await ready.resumePendingOperation();
          return { ok: true, value: { kind: "resumed", started: true } };
      }
    },
  };
  instances.set(db, {
    node,
    update: (dependencies) => { currentDeliver = dependencies.deliver; currentPrepare = dependencies.prepare; },
    retain: () => { leases++; },
  });
  return node;
}
