import type { Sessions } from "@reins/sdk";
import { api } from "../models/api.js";
import { createClientId, type ClientPromptContent } from "../models/chat-content.js";
import type { AppStore } from "../models/stores/app-store.js";

/** The SDK's `sessions`, over the app's stores; `show` is the app's navigation to a session. */
export class SessionActions implements Sessions {
  constructor(
    private readonly app: Pick<AppStore, "client" | "sessionCache" | "projectsStore" | "activeConversationsStore">,
    private readonly show: (sessionId: string) => void,
  ) {}

  async createBeside(sessionId: string, { prompt }: { prompt?: string } = {}): Promise<string> {
    const session = this.app.sessionCache.get(sessionId);
    if (session?.projectId == null) throw new Error("The session is not loaded yet");
    const created = session.taskId === null
      ? await this.app.projectsStore.createSession(session.projectId)
      : await this.app.projectsStore.createTaskSession(session.taskId, session.projectId);
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
