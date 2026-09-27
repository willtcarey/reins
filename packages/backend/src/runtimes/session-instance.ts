import { logger } from "../logger.js";
import { getProject } from "../project-store.js";
import { loadActiveMessages, type RuntimeMessage } from "../messages-store.js";
import { getSession, updateActivityState, updateSessionMeta, type SessionRow } from "../session-store.js";
import { getDb } from "../db.js";
import type { AgentRuntime, AgentRuntimeEvent, RuntimeLifecycleSink, RuntimeRunOutcome } from "./registry.js";
import type { ManagedSession, ServerState } from "../state.js";
import type { Broadcast } from "../models/broadcast.js";
import { enqueueSessionInput, executeSessionCommand, wakeSessionInput } from "./node-execution.js";
import { workForSession } from "../models/node-command-projection.js";
import { commandState, hasPendingInput, pendingInputIds } from "../node-command-store.js";
import { pendingMove } from "../models/session-ownership.js";
import { latestNodeSettlement } from "../node-replica.js";
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

type AgentEndEvent = Extract<AgentRuntimeEvent, { type: "agent_end" }>;

export interface SessionCreationOptions {
  taskId?: number;
  parentSessionId?: string;
  title?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  sourceId?: number;
  /** Legacy caller-directed sessions retain their existing execution owner. */
  storageOwner?: "server" | "internal-node";
}

/** The manager capabilities a session instance uses (implemented by `SessionManager`). */
export interface SessionInstanceHost {
  readonly state: ServerState;
  readonly sessions: Map<string, ManagedSession>;
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
/** Records a node lifecycle receipt inside the effect's transaction; false means an already applied replay. */
export type LifecycleReceipt = () => boolean;

export function transcriptResult(
  sessionId: string,
  messages: RuntimeMessage[],
  terminal?: Pick<AgentEndEvent, "status" | "error">,
): SessionWaitResult {
  return replyResult(sessionId, finalReply(messages), terminal);
}

export function replyResult(
  sessionId: string,
  last: FinalReply | null,
  terminal?: Pick<AgentEndEvent, "status" | "error">,
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

/** Caller-scoped session operations and runtime lifecycle effects. */
export class SessionInstance implements RuntimeLifecycleSink {
  private activeRunId: string | null = null;

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
      storageOwner: caller.storage_owner,
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
    const managed = await this.manager.create(caller.project_id, project.path, { taskId, sourceId: caller.source_id, storageOwner: caller.storage_owner });
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
    // Node-owned sessions, and sessions moving onto a node (their input waits behind the move), settle
    // durably on the node. A session at rest on the server runs nowhere: it is idle, unless a legacy
    // runtime the server still holds is live.
    if (this.session(sessionId).storage_owner === "internal-node" || pendingMove(sessionId)) return this.waitForNodeSettlement(sessionId, timeoutMs, signal);
    const managed = this.manager.sessions.get(sessionId);
    if (!managed) return transcriptResult(sessionId, loadActiveMessages(sessionId));
    managed.lastActivity = Date.now();
    if (hasPendingInput(sessionId)) {
      const deadline = Date.now() + timeoutMs;
      while (hasPendingInput(sessionId) && Date.now() < deadline) {
        await this.pauseForAdmission(Math.min(10, deadline - Date.now()), signal);
      }
      if (hasPendingInput(sessionId)) return { sessionId, status: "timeout", result: null, error: null };
    }
    if (timeoutMs === 0 && managed.runtime.isStreaming()) {
      return { sessionId, status: "timeout", result: null, error: null };
    }

    return new Promise<SessionWaitResult>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      const onAbort = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ sessionId, status: "timeout", result: null, error: null });
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.settledResult(managed).then(
        (result) => { cleanup(); resolve(result); },
        (error) => { cleanup(); reject(error); },
      );
    });
  }

  started(runId: string): void {
    this.activeRunId = runId;
    try {
      this.startedWith();
    } catch (error) {
      logger.error(`Failed to update runtime lifecycle for ${this.sessionId}:`, error);
    }
  }

  settled(runtime: AgentRuntime, outcome: RuntimeRunOutcome): void {
    const metadata = runtime.getSessionMetadata?.();
    const apply = (facts: RunSettlementFacts) => {
      try {
        this.settledWith(outcome, facts);
      } catch (error) {
        logger.error(`Failed to update runtime lifecycle for ${this.sessionId}:`, error);
      }
    };
    // Only a parent consumes the final reply, so only child sessions read the transcript.
    if (!getSession(this.sessionId)?.parent_session_id) return apply({ metadata, reply: null });
    void runtime.getMessages().then(
      (messages) => apply({ metadata, reply: finalReply(messages) }),
      (replyError: unknown) => apply({ metadata, reply: null, replyError }),
    );
  }

  /** Marks the session running. With a node `receipt`, applies at most once and atomically with it; errors propagate. */
  startedWith(receipt?: LifecycleReceipt): void {
    const applied = getDb().transaction(() => {
      if (receipt && !receipt()) return false;
      updateActivityState(this.sessionId, "running");
      return true;
    })();
    if (applied) this.notifyUpdated();
  }

  /**
   * Shared by in-process runtimes and node `session.settled` reports. Persists runtime metadata,
   * enqueues a child's report to its parent and updates activity in one transaction, together with a
   * node `receipt` when given, so a replayed report can neither re-steer the parent nor re-flip state.
   * A reply-read failure or an unreachable parent is logged and leaves the child `finished` without a
   * misleading report. Errors outside those effects (e.g. receipt divergence) propagate.
   */
  settledWith(outcome: RuntimeRunOutcome, facts: RunSettlementFacts, receipt?: LifecycleReceipt): void {
    let enqueued = false;
    const applied = getDb().transaction(() => {
      if (receipt && !receipt()) return false;
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
      // A late in-process settlement must not finish a newer run of the same instance.
      if (this.activeRunId === null || this.activeRunId === outcome.runId) updateActivityState(this.sessionId, activityState);
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
   * Node-owned sessions settle durably: this reads only server projections (provision work, the
   * command outbox, `activity_state` from `session.started`/`session.settled`, the lifecycle receipts
   * and the replica transcript), polling every 10ms. It resolves once no observed input is still
   * queued or being delivered, the session is not running, and every input the node admitted during
   * the wait is covered by a settlement newer than the wait's start (closing the gap between the
   * node admitting a prompt and its `session.started` arriving). The result is the replica
   * transcript's final reply with the latest settlement's status/error as the terminal outcome, the
   * same shape an in-process runtime yields. An input that failed (removed from the outbox) expects no
   * run. Limit: an input admitted before the wait began whose `session.started` is still in flight
   * reads as idle.
   */
  private async waitForNodeSettlement(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<SessionWaitResult> {
    const deadline = Date.now() + timeoutMs;
    const baseline = latestNodeSettlement(getDb(), sessionId)?.seq ?? 0;
    const inputs = new Set<string>();
    for (;;) {
      const work = workForSession(sessionId);
      if (!work || work.state === "failed" || work.state === "unknown") return { sessionId, status: "failed", result: null, error: "Session open failed" };
      for (const id of pendingInputIds(sessionId)) inputs.add(id);
      const states = [...inputs].map(commandState);
      const settlement = latestNodeSettlement(getDb(), sessionId);
      const busy = this.session(sessionId).activity_state === "running"
        || states.some(state => state === "queued" || state === "dispatching")
        || (states.includes("admitted") && (settlement?.seq ?? 0) <= baseline);
      if (!busy) return transcriptResult(sessionId, loadActiveMessages(sessionId), settlement ?? undefined);
      if (Date.now() >= deadline) return { sessionId, status: "timeout", result: null, error: null };
      await this.pauseForAdmission(Math.min(10, deadline - Date.now()), signal);
    }
  }

  private async settledResult(managed: ManagedSession): Promise<SessionWaitResult> {
    for (;;) {
      let failure: unknown;
      try {
        await managed.runtime.waitForIdle();
      } catch (error) {
        failure = error;
      }
      if (managed.runtime.isStreaming()) continue;
      const result = transcriptResult(
        managed.id,
        await managed.runtime.getMessages(),
        await managed.runtime.getLastRunOutcome?.() ?? undefined,
      );
      if (managed.runtime.isStreaming()) continue;
      if (failure) {
        result.result = null;
        result.status = failure instanceof Error && failure.name === "AbortError" ? "cancelled" : "failed";
        result.error = failure instanceof Error ? failure.message : String(failure);
      }
      return result;
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
