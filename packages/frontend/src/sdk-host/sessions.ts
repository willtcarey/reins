import type { Session, SessionCreation, Sessions } from "@reins/sdk";
import type { AppStore } from "../models/stores/app-store.js";

/** The SDK's `sessions`, over the app's stores. */
export class SdkSessions implements Sessions {
  constructor(private readonly app: Pick<AppStore, "sessionOperations" | "sessionCache" | "projectsStore">) {}

  async get(sessionId: string): Promise<Session> {
    const session = await this.app.sessionCache.loadDetail(sessionId);
    const { placement } = session;
    return {
      id: session.id,
      projectId: session.projectId,
      taskId: session.taskId,
      parentSessionId: session.parentSessionId,
      name: session.name,
      source: { nodeId: placement.nodeId, path: placement.path },
    };
  }

  async create({ projectId, prompt, ...input }: SessionCreation): Promise<string> {
    const created = await this.app.projectsStore.createSession(projectId, input);
    if ("error" in created) throw new Error(created.error);
    if (prompt) await this.app.sessionOperations.submit(created.sessionId, "prompt", [{ type: "text", text: prompt }])?.admitted;
    return created.sessionId;
  }

  async send(sessionId: string, message: string): Promise<void> {
    const submission = this.app.sessionOperations.submit(sessionId, "steer", [{ type: "text", text: message }]);
    if (!submission) throw new Error("There is no session to send to");
    await submission.admitted;
  }

  async compact(sessionId: string, instructions?: string): Promise<void> {
    await this.app.sessionOperations.compact(sessionId, instructions ? { instructions } : {});
  }
}
