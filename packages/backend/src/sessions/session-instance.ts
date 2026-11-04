import { getSession, type SessionRow } from "../session-store.js";
import type { Models } from "../models/models.js";
import { assertPlace, inheritedSource } from "./create-session.js";
import type { SessionWaitResult } from "./session-runs.js";

export interface SessionStartOptions {
  parentSessionId: "current" | null;
  /** The project to start it in; the caller's when omitted or "current". */
  projectId?: number | "current";
  /** A task of its project: in the caller's project the caller's task when omitted or "current"; null for a
   * scratch session. */
  taskId?: number | null | "current";
  title?: string;
  /** Where it works, a node and a path there (a directory not known yet is checked on its node); the
   * caller's source by default, or in another project the source a session of it inherits. */
  source?: { nodeId: string; path: string } | null;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/** Session operations of a calling session (the scripting API): start (with the caller's defaults and a
 * child-depth limit), send and wait. All three reach any project. */
export class SessionInstance {
  constructor(
    /** The calling script's or tool call's models. */
    private readonly models: Models,
    /** The calling session. */
    private readonly sessionId: string,
  ) {}

  /** What the caller leaves out is its own (its project, task, source and model); `Sessions.create` checks the rest.
   * In another project it gets no task unless one is named, and that project's source rather than the
   * caller's (or its parent's, the caller). */
  async start(prompt: string, options: SessionStartOptions): Promise<{ sessionId: string }> {
    const caller = this.session(this.sessionId);
    if (!!options.modelProvider !== !!options.modelId) throw new Error("Both modelProvider and modelId are required for a model override");
    if (options.parentSessionId === "current") this.assertChildDepth(caller);
    const projectId = options.projectId === undefined || options.projectId === "current" ? caller.project_id : options.projectId;
    const elsewhere = projectId !== caller.project_id;
    const taskId = options.taskId === undefined ? (elsewhere ? null : caller.task_id)
      : options.taskId === "current" ? caller.task_id : options.taskId;
    let source: { nodeId: string; path: string } | number = options.source ?? caller.source_id;
    if (elsewhere && !options.source && projectId !== null) {
      // Checked first: inheriting a source assumes the project, and the task of it, exist.
      assertPlace(projectId, taskId ?? undefined, true);
      source = inheritedSource(projectId, taskId ?? undefined).id;
    }
    const provider = options.modelProvider ?? caller.model_provider;
    const modelId = options.modelId ?? caller.model_id;
    const thinkingLevel = options.thinkingLevel ?? (caller.thinking_level === "off" ? undefined : caller.thinking_level);
    const managed = await this.models.sessions.create({
      ...(projectId === null ? {} : { projectId }),
      ...(taskId === null ? {} : { taskId }),
      source,
      ...(options.parentSessionId === "current" ? { parentSessionId: caller.id } : {}),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(provider && modelId ? { model: { provider, modelId, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) } } : {}),
    });
    await this.deliver(managed.id, prompt, "prompt");
    return { sessionId: managed.id };
  }

  async startTaskSession(taskId: number, prompt: string): Promise<{ sessionId: string }> {
    const caller = this.session(this.sessionId);
    const managed = await this.models.sessions.create({ ...(caller.project_id === null ? {} : { projectId: caller.project_id }), taskId, source: caller.source_id });
    await this.deliver(managed.id, prompt, "prompt");
    return { sessionId: managed.id };
  }

  async send(sessionId: string, message: string): Promise<{ sessionId: string }> {
    this.session(sessionId);
    return this.deliver(sessionId, message, "steer", this.sessionId);
  }

  async wait(sessionId: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<SessionWaitResult> {
    this.session(sessionId);
    // It would always time out: the caller is running while it waits.
    if (sessionId === this.sessionId) throw new Error("A session cannot wait for itself");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
      throw new Error("timeoutMs must be an integer between 0 and 30000");
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return this.models.sessions.waitForSettlement(sessionId, timeoutMs, { signal });
  }

  private session(sessionId: string): SessionRow {
    const row = getSession(sessionId);
    if (!row) throw new Error(`Session ${sessionId} not found`);
    return row;
  }

  private assertChildDepth(caller: SessionRow): void {
    let ancestor: SessionRow | null = caller;
    let depth = 0;
    while (ancestor?.parent_session_id) {
      if (++depth >= 3) throw new Error("Maximum child session depth (3) reached");
      ancestor = getSession(ancestor.parent_session_id);
    }
  }

  /** Submits the message to the session's runtime; resolves once Pi admitted it. */
  private async deliver(
    sessionId: string,
    message: string,
    mode: "prompt" | "steer",
    sourceSessionId?: string,
  ): Promise<{ sessionId: string }> {
    this.session(sessionId);
    const content = [{ type: "text" as const, text: message }];
    await this.models.sessions.submit(sessionId, { op: mode, content, clientId: crypto.randomUUID(), sourceSessionId });
    return { sessionId };
  }
}
