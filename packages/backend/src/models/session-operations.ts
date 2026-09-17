import { getSession, type SessionRow } from "../session-store.js";
import { getProject } from "../project-store.js";
import { loadActiveMessages, type RuntimeMessage } from "../messages-store.js";
import type { ManagedSession } from "../state.js";
import type { AgentRuntimeEvent } from "../runtimes/registry.js";
import type { CreateSessionFn } from "../runtimes/sessions-manager.js";
import type { Broadcast } from "./broadcast.js";
import { SessionMessages } from "./session-messages.js";

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

export interface SessionOperationContext {
  callerId: string;
  sessions: Map<string, ManagedSession>;
  broadcast: Broadcast;
  createSession?: CreateSessionFn;
  openSession?: (sessionId: string) => Promise<ManagedSession>;
}

type AgentEndEvent = Extract<AgentRuntimeEvent, { type: "agent_end" }>;

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

function session(sessionId: string): SessionRow {
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session ${sessionId} not found`);
  return row;
}

function scopedSession(context: SessionOperationContext, sessionId: string): SessionRow {
  const caller = session(context.callerId);
  const target = session(sessionId);
  if (caller.project_id !== target.project_id || caller.task_id !== target.task_id) {
    throw new Error("Session is outside the current project/task scope");
  }
  return target;
}

export async function startSession(
  context: SessionOperationContext,
  prompt: string,
  options: SessionStartOptions,
): Promise<{ sessionId: string }> {
  if (!context.createSession) throw new Error("Session creation is unavailable");
  const caller = session(context.callerId);
  const project = getProject(caller.project_id);
  if (!project) throw new Error("Project not found");
  if (!!options.modelProvider !== !!options.modelId) throw new Error("Both modelProvider and modelId are required for a model override");
  if (options.title !== undefined && !options.title.trim()) throw new Error("Title must not be blank");
  if (options.parentSessionId === "current") {
    let ancestor: SessionRow | null = caller;
    let depth = 0;
    while (ancestor?.parent_session_id) {
      if (++depth >= 3) throw new Error("Maximum child session depth (3) reached");
      ancestor = getSession(ancestor.parent_session_id);
    }
  }
  const provider = options.modelProvider ?? caller.model_provider;
  const modelId = options.modelId ?? caller.model_id;
  const managed = await context.createSession(caller.project_id, project.path, {
    taskId: caller.task_id ?? undefined,
    parentSessionId: options.parentSessionId === "current" ? caller.id : undefined,
    title: options.title,
    model: provider && modelId ? { provider, modelId } : undefined,
    thinkingLevel: options.thinkingLevel ?? (caller.thinking_level === "off" ? undefined : caller.thinking_level),
  });
  await new SessionMessages(context.sessions, context.broadcast, async () => managed)
    .start(managed.id, prompt, { sourceSessionId: context.callerId });
  return { sessionId: managed.id };
}

export async function sendSessionMessage(
  context: SessionOperationContext,
  sessionId: string,
  message: string,
): Promise<{ sessionId: string }> {
  scopedSession(context, sessionId);
  return new SessionMessages(context.sessions, context.broadcast, context.openSession)
    .send(sessionId, message, { sourceSessionId: context.callerId });
}

export async function waitForSession(
  context: SessionOperationContext,
  sessionId: string,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<SessionWaitResult> {
  scopedSession(context, sessionId);
  if (sessionId === context.callerId) throw new Error("A session cannot wait for itself");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
    throw new Error("timeoutMs must be an integer between 0 and 30000");
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const managed = context.sessions.get(sessionId);
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
    // Cancelling this observation never calls runtime.abort().
    settledResult(managed).then(
      (result) => { cleanup(); resolve(result); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function settledResult(managed: ManagedSession): Promise<SessionWaitResult> {
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
