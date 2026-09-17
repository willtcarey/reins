import { getSession } from "../session-store.js";
import type { ManagedSession } from "../state.js";
import type { Broadcast } from "./broadcast.js";

/** Addressed delivery shared by scripting, runtime reporters, and future HTTP callers.
 * Callers own authorization; this module owns opening, native delivery and broadcast.
 */
export interface SessionMessageSource {
  sourceSessionId: string;
}

export class SessionMessages {
  constructor(
    private sessions: Map<string, ManagedSession>,
    private broadcast: Broadcast,
    private openSession?: (sessionId: string) => Promise<ManagedSession>,
  ) {}

  async start(sessionId: string, message: string, source?: SessionMessageSource): Promise<{ sessionId: string }> {
    return this.deliver(sessionId, message, "prompt", source);
  }

  async send(sessionId: string, message: string, source?: SessionMessageSource): Promise<{ sessionId: string }> {
    return this.deliver(sessionId, message, "steer", source);
  }

  private async deliver(
    sessionId: string,
    message: string,
    mode: "prompt" | "steer",
    source?: SessionMessageSource,
  ): Promise<{ sessionId: string }> {
    const row = getSession(sessionId);
    if (!row) throw new Error(`Session ${sessionId} not found`);
    const managed = this.sessions.get(sessionId) ?? await this.openSession?.(sessionId);
    if (!managed) throw new Error("Session reopening is unavailable");
    const content = [{ type: "text" as const, text: message }];
    const options = source ? { metadata: { sourceSessionId: source.sourceSessionId } } : undefined;
    managed.lastActivity = Date.now();
    if (mode === "prompt") await managed.runtime.prompt(content, options);
    else await managed.runtime.steer(content, options);
    this.broadcast({
      type: "user_message",
      sessionId,
      projectId: row.project_id,
      message: content,
      ...(options ? { metadata: options.metadata } : {}),
    });
    return { sessionId };
  }
}
