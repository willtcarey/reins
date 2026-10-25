import type { SessionCreation, SessionInfo, Sessions } from "@reins/sdk";
import type { AppStore } from "../models/stores/app-store.js";

/** The SDK's `sessions`, over the app's stores; `show` is the app's navigation to a session. */
export class SessionActions implements Sessions {
  constructor(
    private readonly app: Pick<AppStore, "sessionOperations" | "sessionCache" | "projectsStore">,
    private readonly show: (sessionId: string) => void,
  ) {}

  get(sessionId: string): SessionInfo | null {
    const session = this.app.sessionCache.get(sessionId);
    if (session?.projectId == null) return null;
    const placement = session.placement;
    return {
      id: session.id,
      projectId: session.projectId,
      taskId: session.taskId,
      source: placement ? { nodeId: placement.nodeId, path: placement.path } : null,
    };
  }

  async create({ projectId, prompt, ...input }: SessionCreation): Promise<string> {
    const created = await this.app.projectsStore.createSession(projectId, input);
    if ("error" in created) throw new Error(created.error);
    if (prompt) await this.app.sessionOperations.submit(created.sessionId, "prompt", [{ type: "text", text: prompt }])?.admitted;
    return created.sessionId;
  }

  open(sessionId: string): void {
    this.show(sessionId);
  }

  async compact(sessionId: string, { instructions }: { instructions?: string } = {}): Promise<void> {
    await this.app.sessionOperations.compact(sessionId, instructions ? { instructions } : {});
  }
}
