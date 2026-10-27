import type { SessionCreateRequest } from "@backend/routes/project-sessions.js";
import type { SessionAttachmentInfo as AttachmentInfo } from "@backend/session-attachments-store.js";
import type { ModelSetting } from "@backend/settings-store.js";
import type { ClientPromptContent } from "./chat-content.js";
import type { SessionAttachmentUpload } from "./stores/active-session-store.js";

/** Where a new session goes: its project, and its task, or none for the project's assistant. */
export interface NewSessionPlace {
  projectId: number;
  taskId: number | null;
}

/** What a draft does its work with: the app's stores in the app, fakes in tests. */
export interface NewSessionDraftBacking {
  /** Resolves with the new session's ID; rejects with a message that can be shown. */
  createSession(projectId: number, input: Pick<SessionCreateRequest, "taskId" | "model">): Promise<string>;
  setModel(sessionId: string, model: ModelSetting): Promise<void>;
  uploadAttachments(sessionId: string, attachments: readonly SessionAttachmentUpload[]): Promise<AttachmentInfo[]>;
  /** Submits the prompt, shown in the session's conversation at once; null when it was not submitted. */
  submitPrompt(sessionId: string, content: ClientPromptContent): { localId: string } | null;
}

function sameModel(a: ModelSetting | null, b: ModelSetting | null): boolean {
  return a?.runtimeType === b?.runtimeType && a?.provider === b?.provider && a?.modelId === b?.modelId && a?.thinkingLevel === b?.thinkingLevel;
}

/**
 * A session not created yet: the new session page's. It is created when it is first needed, when its
 * first message is sent or that message's attachments are uploaded, with the model chosen by then, as
 * the SDK's `sessions.create` creates one. A session it created is kept for the same place, so trying
 * again after a later step failed does not create another; a model chosen after that is set on it.
 */
export class NewSessionDraft {
  /** The model chosen for it; null for the default model setting's. */
  model: ModelSetting | null = null;

  private created: (NewSessionPlace & { sessionId: string; model: ModelSetting | null }) | null = null;

  constructor(private readonly backing: NewSessionDraftBacking) {}

  async upload(place: NewSessionPlace, attachments: readonly SessionAttachmentUpload[]): Promise<AttachmentInfo[]> {
    return this.backing.uploadAttachments(await this.session(place), attachments);
  }

  /** Sends the first message; resolves once it is shown in the session's conversation, with its key there. */
  async send(place: NewSessionPlace, content: ClientPromptContent): Promise<{ sessionId: string; messageKey: string }> {
    const sessionId = await this.session(place);
    const entry = this.backing.submitPrompt(sessionId, content);
    if (!entry) throw new Error("The message could not be sent");
    return { sessionId, messageKey: entry.localId };
  }

  private async session(place: NewSessionPlace): Promise<string> {
    if (this.created?.projectId !== place.projectId || this.created.taskId !== place.taskId) {
      const model = this.model;
      const sessionId = await this.backing.createSession(place.projectId, {
        ...(place.taskId == null ? {} : { taskId: place.taskId }),
        // No runtime: creating makes a Pi session, the only runtime a session can have (`Sessions.setModel`).
        ...(model ? { model: { provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevel } } : {}),
      });
      this.created = { ...place, sessionId, model };
    }
    const created = this.created;
    if (this.model && !sameModel(created.model, this.model)) {
      const model = this.model;
      await this.backing.setModel(created.sessionId, model);
      created.model = model;
    }
    return created.sessionId;
  }
}
