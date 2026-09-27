import { logger } from "../logger.js";
import { getProject } from "../project-store.js";
import { loadActiveMessages, type RuntimeMessage } from "../messages-store.js";
import { getSession, updateActivityState, updateSessionMeta, type SessionRow } from "../session-store.js";
import { getDb } from "../db.js";
import type { ServerState } from "../state.js";
import type { Broadcast } from "../models/broadcast.js";
import { enqueueSessionInput, executeSessionCommand, wakeSessionInput } from "./node-execution.js";
import { pendingInputs } from "../node-command-store.js";
import { latestNodeSettlement, replicaInput } from "../node-replica.js";
import { finalReply, type FinalReply } from "@reins/node/runtime-build";

export interface SessionStartOptions {
  parentSessionId: "current" | null;
  title?: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export interface SessionWaitResult {
  sessionId: string;
  status: "idle" | "completed" | "failed" | "cancelled" | "timeout";
  result: string | null;
  error: string | null;
}

/** How a node run ended (`session.settled`). */
export interface RuntimeRunOutcome {
  runId: string;
  status: "completed" | "failed" | "aborted";
  error?: { code?: string; message: string; details?: unknown };
}
type RunTerminal = Partial<Pick<RuntimeRunOutcome, "status" | "error">>;

export interface SessionCreationOptions {
  taskId?: number;
  parentSessionId?: string;
  title?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  sourceId?: number;
}

/** The manager capabilities a session instance uses (implemented by `SessionManager`). */
export interface SessionInstanceHost {
  readonly state: ServerState;
  readonly broadcast: Broadcast;
  create(projectId: number, projectDir: string, options?: SessionCreationOptions): { id: string };
}

/** What settlement needs from a run, without the live runtime that produced it. */
export interface RunSettlementFacts {
  metadata?: { model?: { provider: string; modelId: string } | null; thinkingLevel?: string | null };
  /** The final assistant reply; read only for child sessions (null otherwise or when there is none). */
  reply: FinalReply | null;
  /** Set when a child's reply could not be read: the parent receives no report and the child is marked finished. */
  replyError?: unknown;
}
/** Advances the node lifecycle watermark inside the effect's transaction; false means an already applied replay. */
export type LifecycleWatermark = () => boolean;

export function transcriptResult(
  sessionId: string,
  messages: RuntimeMessage[],
  terminal?: RunTerminal,
): SessionWaitResult {
  return replyResult(sessionId, finalReply(messages), terminal);
}

export function replyResult(
  sessionId: string,
  last: FinalReply | null,
  terminal?: RunTerminal,
): SessionWaitResult {
  const result = last?.text ?? null;
  if (terminal?.status === "failed") {
    return { sessionId, status: "failed", result: null, error: terminal.error?.message ?? "Runtime response failed" };
  }
  if (terminal?.status === "aborted") {
    return { sessionId, status: "cancelled", result: null, error: terminal.error?.message ?? null };
  }
  return {
    sessionId,
    status: terminal?.status === "completed" ? "completed" : last?.stopReason === "aborted" ? "cancelled" : last?.stopReason === "error" ? "failed" : last ? "completed" : "idle",
    result,
    error: terminal?.status === "completed"
      ? null
      : last?.stopReason === "error" ? last.errorMessage ?? "Runtime response failed" : null,
  };
}

/** Caller-scoped session operations and the effects of node run lifecycle reports. */
export class SessionInstance {
  constructor(
    private readonly manager: SessionInstanceHost,
    private readonly sessionId: string,
  ) {}

  /** Wakes node command delivery after a caller queued work outside `send` (e.g. `session.setModel`). */
  wakeNodeCommands(): void {
    wakeSessionInput(this.manager.state);
  }

  async start(prompt: string, options: SessionStartOptions): Promise<{ sessionId: string }> {
    const caller = this.session(this.sessionId);
    const project = getProject(caller.project_id);
    if (!project) throw new Error("Project not found");
    if (!!options.modelProvider !== !!options.modelId) throw new Error("Both modelProvider and modelId are required for a model override");
    if (options.title !== undefined && !options.title.trim()) throw new Error("Title must not be blank");
    if (options.parentSessionId === "current") this.assertChildDepth(caller);

    const provider = options.modelProvider ?? caller.model_provider;
    const modelId = options.modelId ?? caller.model_id;
    const managed = await this.manager.create(caller.project_id, project.path, {
      taskId: caller.task_id ?? undefined,
      sourceId: caller.source_id,
      parentSessionId: options.parentSessionId === "current" ? caller.id : undefined,
      title: options.title,
      model: provider && modelId ? { provider, modelId } : undefined,
      thinkingLevel: options.thinkingLevel ?? (caller.thinking_level === "off" ? undefined : caller.thinking_level),
    });
    await this.deliver(managed.id, prompt, "prompt");
    return { sessionId: managed.id };
  }

  async startTaskSession(taskId: number, prompt: string): Promise<{ sessionId: string }> {
    const caller = this.session(this.sessionId);
    const project = getProject(caller.project_id);
    if (!project) throw new Error("Project not found");
    const managed = await this.manager.create(caller.project_id, project.path, { taskId, sourceId: caller.source_id });
    await this.deliver(managed.id, prompt, "prompt");
    return { sessionId: managed.id };
  }

  async send(sessionId: string, message: string): Promise<{ sessionId: string }> {
    this.projectSession(sessionId);
    return this.deliver(sessionId, message, "steer", this.sessionId);
  }

  async wait(sessionId: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<SessionWaitResult> {
    this.scopedSession(sessionId);
    if (sessionId === this.sessionId) throw new Error("A session cannot wait for itself");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
      throw new Error("timeoutMs must be an integer between 0 and 30000");
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    // A session at rest on the server runs nowhere (any input for it queued a move, so it is `moving`):
    // its transcript result is returned at once. Every other session settles durably on its node.
    if (this.session(sessionId).placement_status === "server") return transcriptResult(sessionId, loadActiveMessages(sessionId));
    return this.waitForNodeSettlement(sessionId, timeoutMs, signal);
  }

  /** Marks the session running. With a node `watermark`, applies at most once and atomically with it; errors propagate. */
  startedWith(watermark?: LifecycleWatermark): void {
    const applied = getDb().transaction(() => {
      if (watermark && !watermark()) return false;
      updateActivityState(this.sessionId, "running");
      return true;
    })();
    if (applied) this.notifyUpdated();
  }

  /**
   * Applies a node `session.settled` report. Persists runtime metadata,
   * enqueues a child's report to its parent and updates activity in one transaction, together with a
   * node lifecycle `watermark` when given, so a replayed report can neither re-steer the parent nor re-flip state.
   * A reply-read failure or an unreachable parent is logged and leaves the child `finished` without a
   * misleading report. Errors outside those effects (e.g. lifecycle divergence) propagate.
   */
  settledWith(outcome: RuntimeRunOutcome, facts: RunSettlementFacts, watermark?: LifecycleWatermark): void {
    let enqueued = false;
    const applied = getDb().transaction(() => {
      if (watermark && !watermark()) return false;
      this.persistRuntimeMetadata(facts.metadata);
      const session = this.session(this.sessionId);
      let activityState: SessionRow["activity_state"] = "finished";
      if (session.parent_session_id) {
        if (facts.replyError !== undefined) {
          logger.error(`Failed to read session ${this.sessionId} final reply; not reporting it to its parent:`, facts.replyError);
        } else {
          try {
            this.reportChildSettlement(facts.reply, outcome, session.parent_session_id);
            enqueued = true;
            activityState = null;
          } catch (error) {
            logger.error(`Failed to report session ${this.sessionId} settlement:`, error);
          }
        }
      }
      updateActivityState(this.sessionId, activityState);
      return true;
    })();
    if (!applied) return;
    this.notifyUpdated();
    if (enqueued) wakeSessionInput(this.manager.state);
  }

  private session(sessionId: string): SessionRow {
    const row = getSession(sessionId);
    if (!row) throw new Error(`Session ${sessionId} not found`);
    return row;
  }

  private projectSession(sessionId: string): SessionRow {
    const caller = this.session(this.sessionId);
    const target = this.session(sessionId);
    if (caller.project_id !== target.project_id) {
      throw new Error("Session is outside the current project");
    }
    return target;
  }

  private scopedSession(sessionId: string): SessionRow {
    const caller = this.session(this.sessionId);
    const target = this.projectSession(sessionId);
    if (caller.task_id !== target.task_id) {
      throw new Error("Session is outside the current project/task scope");
    }
    return target;
  }

  private assertChildDepth(caller: SessionRow): void {
    let ancestor: SessionRow | null = caller;
    let depth = 0;
    while (ancestor?.parent_session_id) {
      if (++depth >= 3) throw new Error("Maximum child session depth (3) reached");
      ancestor = getSession(ancestor.parent_session_id);
    }
  }

  private async deliver(
    sessionId: string,
    message: string,
    mode: "prompt" | "steer",
    sourceSessionId?: string,
  ): Promise<{ sessionId: string }> {
    this.session(sessionId);
    const content = [{ type: "text" as const, text: message }];
    const clientId = crypto.randomUUID();
    await executeSessionCommand(this.manager.state, sessionId, mode, content, clientId, sourceSessionId);
    return { sessionId };
  }

  private pauseForAdmission(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
      const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /**
   * Node-owned sessions settle durably: this reads only server projections (the session's placement,
   * the command outbox, `activity_state` from `session.started`/`session.settled`, the latest
   * settlement and the replica), polling every 10ms. It fails at once when the session's provisioning
   * failed. It tracks every input it sees pending in the outbox and resolves once none is still queued
   * or being delivered, the session is not running, and every tracked input the node admitted is
   * covered by a settlement. Admission is proven by the replica, not by an outbox row (settled commands
   * are deleted): an admitted prompt/steer is a `reinsInput` there keyed by its clientId (`replicaInput`);
   * one still queued as steering awaits a run; a transcript entry is covered once the latest settlement
   * was applied after it was committed (its seq is below the settlement's `nextSeq`). An input that
   * failed never reaches the replica and expects no run. The result is the replica transcript's final
   * reply with the latest settlement's status/error as the terminal outcome. Limits: an input admitted before the wait began whose `session.started`
   * is still in flight reads as idle; an admitted input whose commit the node has not delivered yet
   * (held behind an earlier undeliverable outbox row) reads as failed.
   */
  private async waitForNodeSettlement(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<SessionWaitResult> {
    const deadline = Date.now() + timeoutMs;
    const inputs = new Map<string, string>(); // outbox command ID → clientId
    for (;;) {
      const row = this.session(sessionId);
      if (row.placement_status === "provision_failed") {
        return { sessionId, status: "failed", result: null, error: `Session provisioning failed: ${row.status_error ?? "unknown error"}` };
      }
      const pending = new Set<string>();
      for (const input of pendingInputs(sessionId)) { inputs.set(input.id, input.clientId); pending.add(input.id); }
      const settlement = latestNodeSettlement(getDb(), sessionId);
      const awaitingRun = (clientId: string) => {
        const admitted = replicaInput(getDb(), sessionId, clientId);
        if (!admitted) return false;
        return "queued" in admitted || admitted.seq >= (settlement?.nextSeq ?? 0);
      };
      const busy = row.activity_state === "running"
        || [...inputs].some(([id, clientId]) => pending.has(id) || awaitingRun(clientId));
      if (!busy) return transcriptResult(sessionId, loadActiveMessages(sessionId), settlement ?? undefined);
      if (Date.now() >= deadline) return { sessionId, status: "timeout", result: null, error: null };
      await this.pauseForAdmission(Math.min(10, deadline - Date.now()), signal);
    }
  }

  private persistRuntimeMetadata(metadata: RunSettlementFacts["metadata"]): void {
    if (!metadata?.model?.provider || !metadata.model.modelId) return;
    updateSessionMeta(this.sessionId, {
      modelProvider: metadata.model.provider,
      modelId: metadata.model.modelId,
      thinkingLevel: metadata.thinkingLevel ?? undefined,
    });
  }

  private notifyUpdated(): void {
    const row = getSession(this.sessionId);
    if (row) this.manager.broadcast({ type: "session_updated", sessionId: this.sessionId, projectId: row.project_id });
  }

  private reportChildSettlement(
    reply: FinalReply | null,
    outcome: RuntimeRunOutcome,
    parentSessionId: string,
  ): void {
    const parent = this.scopedSession(parentSessionId);
    const result = replyResult(this.sessionId, reply, outcome);
    const content = result.status === "completed"
      ? result.result ?? "Session completed."
      : result.error ? `Session ${result.status}: ${result.error}` : `Session ${result.status}.`;
    enqueueSessionInput(parent.id, "steer", [{ type: "text", text: content }], crypto.randomUUID(), this.sessionId);
  }
}
