import { logger } from "../logger.js";
import { getProject } from "../project-store.js";
import { loadActiveMessages, type RuntimeMessage } from "../messages-store.js";
import { getSession, updateSessionMeta, type SessionRow } from "../session-store.js";
import type { AgentRuntime, AgentRuntimeEvent, RuntimeLifecycleSink, RuntimeRunOutcome } from "./registry.js";
import type { SessionManager } from "./session-manager.js";
import type { ManagedSession } from "../state.js";
import { Sessions } from "../models/sessions.js";

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
}

export function transcriptResult(
  sessionId: string,
  messages: RuntimeMessage[],
  terminal?: Pick<AgentEndEvent, "status" | "error">,
): SessionWaitResult {
  const last = messages.findLast((message) => message.role === "assistant");
  const result = last && Array.isArray(last.content)
    ? last.content.filter((block) => block.type === "text").map((block) => String(block.text)).join("\n")
    : null;
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
      : last?.stopReason === "error" ? String(last.errorMessage ?? "Runtime response failed") : null,
  };
}

/** Caller-scoped session operations and runtime lifecycle effects. */
export class SessionInstance implements RuntimeLifecycleSink {
  private readonly sessionModel: Sessions;

  constructor(
    private readonly manager: SessionManager,
    private readonly sessionId: string,
  ) {
    this.sessionModel = new Sessions(manager.sessions, manager.broadcast);
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
      parentSessionId: options.parentSessionId === "current" ? caller.id : undefined,
      title: options.title,
      model: provider && modelId ? { provider, modelId } : undefined,
      thinkingLevel: options.thinkingLevel ?? (caller.thinking_level === "off" ? undefined : caller.thinking_level),
    });
    await this.deliver(managed.id, prompt, "prompt", undefined, managed);
    return { sessionId: managed.id };
  }

  async startTaskSession(taskId: number, prompt: string): Promise<{ sessionId: string }> {
    const caller = this.session(this.sessionId);
    const project = getProject(caller.project_id);
    if (!project) throw new Error("Project not found");
    const managed = await this.manager.create(caller.project_id, project.path, { taskId });
    await this.deliver(managed.id, prompt, "prompt", undefined, managed);
    return { sessionId: managed.id };
  }

  async send(sessionId: string, message: string): Promise<{ sessionId: string }> {
    this.scopedSession(sessionId);
    return this.deliver(sessionId, message, "steer", this.sessionId);
  }

  async wait(sessionId: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<SessionWaitResult> {
    this.scopedSession(sessionId);
    if (sessionId === this.sessionId) throw new Error("A session cannot wait for itself");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
      throw new Error("timeoutMs must be an integer between 0 and 30000");
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const managed = this.manager.sessions.get(sessionId);
    if (!managed) return transcriptResult(sessionId, loadActiveMessages(sessionId));
    managed.lastActivity = Date.now();
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

  started(): void {
    try {
      this.sessionModel.updateActivityState(this.sessionId, "running");
    } catch (error) {
      logger.error(`Failed to update runtime lifecycle for ${this.sessionId}:`, error);
    }
  }

  settled(runtime: AgentRuntime, outcome: RuntimeRunOutcome): void {
    try {
      this.persistRuntimeMetadata(runtime);
      this.sessionModel.updateActivityState(this.sessionId, "finished");
      void this.reportSettlement(runtime, outcome)
        .catch((error: unknown) => logger.error(`Failed to report session ${this.sessionId} settlement:`, error));
    } catch (error) {
      logger.error(`Failed to update runtime lifecycle for ${this.sessionId}:`, error);
    }
  }

  private session(sessionId: string): SessionRow {
    const row = getSession(sessionId);
    if (!row) throw new Error(`Session ${sessionId} not found`);
    return row;
  }

  private scopedSession(sessionId: string): SessionRow {
    const caller = this.session(this.sessionId);
    const target = this.session(sessionId);
    if (caller.project_id !== target.project_id || caller.task_id !== target.task_id) {
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
    opened?: ManagedSession,
  ): Promise<{ sessionId: string }> {
    const row = this.session(sessionId);
    const managed = opened ?? this.manager.sessions.get(sessionId) ?? await this.manager.open(sessionId);
    const content = [{ type: "text" as const, text: message }];
    const promptOptions = sourceSessionId ? { metadata: { sourceSessionId } } : undefined;
    managed.lastActivity = Date.now();
    if (mode === "prompt") await managed.runtime.prompt(content, promptOptions);
    else await managed.runtime.steer(content, promptOptions);
    this.manager.broadcast({
      type: "user_message",
      sessionId,
      projectId: row.project_id,
      message: content,
      ...(promptOptions ? { metadata: promptOptions.metadata } : {}),
    });
    return { sessionId };
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

  private persistRuntimeMetadata(runtime: AgentRuntime): void {
    const metadata = runtime.getSessionMetadata?.();
    if (!metadata?.model?.provider || !metadata.model.modelId) return;
    updateSessionMeta(this.sessionId, {
      modelProvider: metadata.model.provider,
      modelId: metadata.model.modelId,
      thinkingLevel: metadata.thinkingLevel ?? undefined,
    });
  }

  private async reportSettlement(runtime: AgentRuntime, outcome: RuntimeRunOutcome): Promise<void> {
    const child = getSession(this.sessionId);
    const parent = child?.parent_session_id ? getSession(child.parent_session_id) : null;
    if (!child || !parent) return;
    if (child.project_id !== parent.project_id || child.task_id !== parent.task_id) {
      throw new Error("Parent is outside the child's project/task scope");
    }
    const result = transcriptResult(this.sessionId, await runtime.getMessages(), outcome);
    const content = result.status === "completed"
      ? result.result ?? "Session completed."
      : result.error ? `Session ${result.status}: ${result.error}` : `Session ${result.status}.`;
    await this.deliver(parent.id, content, "steer", this.sessionId);
  }
}
