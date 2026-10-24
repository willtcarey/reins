import type { SessionCreation, SessionInfo, Sessions } from "@reins/sdk";
import { api } from "../models/api.js";
import { createClientId, type ClientPromptContent } from "../models/chat-content.js";
import type { AppStore } from "../models/stores/app-store.js";

/** The SDK's `sessions`, over the app's stores; `show` is the app's navigation to a session. */
export class SessionActions implements Sessions {
  constructor(
    private readonly app: Pick<AppStore, "client" | "sessionCache" | "projectsStore" | "activeConversationsStore">,
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
    if (prompt) {
      const content: ClientPromptContent = [{ type: "text", text: prompt }];
      const clientId = createClientId();
      this.app.activeConversationsStore.addOptimisticUserMessage(created.sessionId, content, clientId);
      this.app.client.prompt(created.sessionId, content, clientId);
    }
    return created.sessionId;
  }

  open(sessionId: string): void {
    this.show(sessionId);
  }

  async compact(sessionId: string, { instructions }: { instructions?: string } = {}): Promise<void> {
    await api.sessions.compact(sessionId, instructions ? { instructions } : {});
  }
}
