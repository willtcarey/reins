import { getSession, type SessionRow } from "../session-store.js";
import type { Models } from "../models/models.js";

/** The `create_task` tool's start of a session in the task it made, in the calling session's project and checkout.
 * Scripts and extensions start sessions through the SDK's `sessions.start` (`sdk-host/sessions.ts`). */
export class SessionInstance {
  constructor(
    /** The calling tool call's models. */
    private readonly models: Models,
    /** The calling session. */
    private readonly sessionId: string,
  ) {}

  async startTaskSession(taskId: number, prompt: string): Promise<{ sessionId: string }> {
    const caller = this.session(this.sessionId);
    const managed = await this.models.sessions.create({ ...(caller.project_id === null ? {} : { projectId: caller.project_id }), taskId, source: caller.source_id });
    await this.models.sessions.submit(managed.id, { op: "prompt", content: [{ type: "text", text: prompt }], clientId: crypto.randomUUID() });
    return { sessionId: managed.id };
  }

  private session(sessionId: string): SessionRow {
    const row = getSession(sessionId);
    if (!row) throw new Error(`Session ${sessionId} not found`);
    return row;
  }
}
