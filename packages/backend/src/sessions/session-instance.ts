import { getProject } from "../project-store.js";
import { getSession, type SessionRow } from "../session-store.js";
import type { NodeHub, ServerState } from "../state.js";
import { createBroadcast } from "../models/broadcast.js";
import { createSession } from "./create-session.js";
import { submit } from "./node-execution.js";
import { sessionRuns, type SessionWaitResult } from "./session-runs.js";

export interface SessionStartOptions {
  parentSessionId: "current" | null;
  title?: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/** Session operations scoped to a calling session (the scripting API): start, send and wait, within its
 * project/task scope and child depth. */
export class SessionInstance {
  constructor(
    private readonly state: ServerState,
    /** The calling session. */
    private readonly sessionId: string,
  ) {}

  /** The node hub: submissions for its sessions wake delivery (e.g. `session.setModel`). */
  get nodes(): NodeHub {
    return this.state.nodes;
  }

  async start(prompt: string, options: SessionStartOptions): Promise<{ sessionId: string }> {
    const caller = this.session(this.sessionId);
    if (!getProject(caller.project_id)) throw new Error("Project not found");
    if (!!options.modelProvider !== !!options.modelId) throw new Error("Both modelProvider and modelId are required for a model override");
    if (options.title !== undefined && !options.title.trim()) throw new Error("Title must not be blank");
    if (options.parentSessionId === "current") this.assertChildDepth(caller);

    const provider = options.modelProvider ?? caller.model_provider;
    const modelId = options.modelId ?? caller.model_id;
    const managed = createSession(this.state, caller.project_id, {
      taskId: caller.task_id ?? undefined,
      sourceId: caller.source_id,
      parentSessionId: options.parentSessionId === "current" ? caller.id : undefined,
      title: options.title,
      model: provider && modelId ? { provider, modelId } : undefined,
      thinkingLevel: options.thinkingLevel ?? (caller.thinking_level === "off" ? undefined : caller.thinking_level),
    });
    this.deliver(managed.id, prompt, "prompt");
    return { sessionId: managed.id };
  }

  async startTaskSession(taskId: number, prompt: string): Promise<{ sessionId: string }> {
    const caller = this.session(this.sessionId);
    if (!getProject(caller.project_id)) throw new Error("Project not found");
    const managed = createSession(this.state, caller.project_id, { taskId, sourceId: caller.source_id });
    this.deliver(managed.id, prompt, "prompt");
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
    return sessionRuns({ broadcast: createBroadcast(this.state.clients), nodes: this.nodes }).waitForSettlement(sessionId, timeoutMs, signal);
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

  private deliver(
    sessionId: string,
    message: string,
    mode: "prompt" | "steer",
    sourceSessionId?: string,
  ): { sessionId: string } {
    this.session(sessionId);
    const content = [{ type: "text" as const, text: message }];
    submit(this.nodes, sessionId, { op: mode, content, clientId: crypto.randomUUID(), sourceSessionId });
    return { sessionId };
  }
}
