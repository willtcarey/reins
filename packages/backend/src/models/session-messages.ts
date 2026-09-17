import { getSession } from "../session-store.js";
import type { ManagedSession } from "../state.js";
import type { Broadcast } from "./broadcast.js";

/** Addressed delivery shared by scripting, runtime reporters, and future HTTP callers.
 * Callers own authorization; this module owns opening, native delivery and broadcast.
 */
export class SessionMessages {
  constructor(
    private sessions: Map<string, ManagedSession>,
    private broadcast: Broadcast,
    private openSession?: (sessionId: string) => Promise<ManagedSession>,
  ) {}

  async start(sessionId: string, message: string): Promise<{ sessionId: string }> {
    return this.deliver(sessionId, message, "prompt");
  }

  async send(sessionId: string, message: string): Promise<{ sessionId: string }> {
    return this.deliver(sessionId, message, "steer");
  }

  private async deliver(sessionId: string, message: string, mode: "prompt" | "steer"): Promise<{ sessionId: string }> {
    const row = getSession(sessionId);
    if (!row) throw new Error(`Session ${sessionId} not found`);
    const managed = this.sessions.get(sessionId) ?? await this.openSession?.(sessionId);
    if (!managed) throw new Error("Session reopening is unavailable");
    const content = [{ type: "text" as const, text: message }];
    managed.lastActivity = Date.now();
    if (mode === "prompt") await managed.runtime.prompt(content);
    else await managed.runtime.steer(content);
    this.broadcast({ type: "user_message", sessionId, projectId: row.project_id, message: content });
    return { sessionId };
  }
}
