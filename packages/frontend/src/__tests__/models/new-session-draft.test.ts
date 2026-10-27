import { describe, expect, test } from "bun:test";
import { NewSessionDraft, type NewSessionDraftBacking } from "../../models/new-session-draft.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";

const text = (value: string) => [{ type: "text" as const, text: value }];
const opus = { runtimeType: "pi", provider: "anthropic", modelId: "claude-opus-4", thinkingLevel: "high" } as const;
const opusCreated = { provider: "anthropic", modelId: "claude-opus-4", thinkingLevel: "high" };

/** A draft whose backing records what reaches it; a session created is `new-1`, `new-2`, …, and `overrides` replace an operation. */
function draftWith(overrides: Partial<NewSessionDraftBacking> = {}) {
  const calls: unknown[] = [];
  const conversations = new ConversationsStore();
  let created = 0;
  const backing: NewSessionDraftBacking = {
    createSession: async (projectId, input) => { calls.push({ create: projectId, ...input }); return `new-${++created}`; },
    setModel: async (sessionId, model) => { calls.push({ setModel: sessionId, ...model }); },
    uploadAttachments: async (sessionId, attachments) => { calls.push({ upload: sessionId, count: attachments.length }); return []; },
    submitPrompt: (sessionId, content) => {
      calls.push({ prompt: sessionId, content });
      return conversations.addOptimisticUserMessage(sessionId, content, `client-${calls.length}`);
    },
    ...overrides,
  };
  return { draft: new NewSessionDraft(backing), calls, conversations };
}

describe("NewSessionDraft", () => {
  test("creates the session in its project and task when its first message is sent, and submits the message there", async () => {
    const { draft, calls, conversations } = draftWith();

    const sent = await draft.send({ projectId: 7, taskId: 3 }, text("Plan the migration"));

    expect(sent.sessionId).toBe("new-1");
    expect(calls).toEqual([{ create: 7, taskId: 3 }, { prompt: "new-1", content: text("Plan the migration") }]);
    expect(conversations.get("new-1").messages.map((message) => message.renderKey)).toEqual([sent.messageKey]);
  });

  test("creates an assistant conversation without a task, with the model chosen in the same request, or the default without one", async () => {
    const chosen = draftWith();
    const unchosen = draftWith();
    chosen.draft.model = opus;

    await chosen.draft.send({ projectId: 7, taskId: null }, text("Hello"));
    await unchosen.draft.send({ projectId: 7, taskId: null }, text("Hello"));

    expect(chosen.calls).toEqual([{ create: 7, model: opusCreated }, { prompt: "new-1", content: text("Hello") }]);
    expect(unchosen.calls).toEqual([{ create: 7 }, { prompt: "new-1", content: text("Hello") }]);
  });

  test("uploads attachments to the session it creates for them, then sends the message there", async () => {
    const { draft, calls } = draftWith();
    const place = { projectId: 7, taskId: null };

    await draft.upload(place, [{ file: new File([""], "a.png"), mimeType: "image/png", filename: "a.png" }]);
    await draft.send(place, text("What is in this image?"));

    expect(calls).toEqual([{ create: 7 }, { upload: "new-1", count: 1 }, { prompt: "new-1", content: text("What is in this image?") }]);
  });

  test("keeps a session it created when a later step fails, so trying again does not create another, unless the place changed", async () => {
    let failUpload = true;
    const { draft, calls } = draftWith({
      uploadAttachments: async (sessionId) => {
        calls.push({ upload: sessionId });
        if (failUpload) throw new Error("The upload failed");
        return [];
      },
    });
    const attachment = { file: new File([""], "a.png"), mimeType: "image/png", filename: "a.png" };

    await expect(draft.upload({ projectId: 7, taskId: null }, [attachment])).rejects.toThrow("The upload failed");
    failUpload = false;
    await draft.upload({ projectId: 7, taskId: null }, [attachment]);
    await draft.upload({ projectId: 7, taskId: 3 }, [attachment]);

    expect(calls).toEqual([{ create: 7 }, { upload: "new-1" }, { upload: "new-1" }, { create: 7, taskId: 3 }, { upload: "new-2" }]);
  });

  test("sets a model chosen after the session was created when it is sent again, and not one it was created with", async () => {
    const sonnet = { ...opus, modelId: "claude-sonnet-4" };
    let failPrompt = true;
    const { draft, calls } = draftWith({
      submitPrompt: (sessionId) => {
        calls.push({ prompt: sessionId });
        if (failPrompt) return null;
        return { localId: "submission-1" };
      },
    });
    draft.model = opus;

    await expect(draft.send({ projectId: 7, taskId: null }, text("Hello"))).rejects.toThrow("The message could not be sent");
    await expect(draft.send({ projectId: 7, taskId: null }, text("Hello"))).rejects.toThrow("The message could not be sent");
    failPrompt = false;
    draft.model = sonnet;
    await draft.send({ projectId: 7, taskId: null }, text("Hello"));

    expect(calls).toEqual([
      { create: 7, model: opusCreated },
      { prompt: "new-1" },
      { prompt: "new-1" },
      { setModel: "new-1", ...sonnet },
      { prompt: "new-1" },
    ]);
  });

  test("rejects with what failed, sending nothing more", async () => {
    const { draft, calls } = draftWith({ createSession: () => Promise.reject(new Error("Task 3 is not a task of this project")) });

    await expect(draft.send({ projectId: 7, taskId: 3 }, text("Hello"))).rejects.toThrow("Task 3 is not a task of this project");
    expect(calls).toEqual([]);
  });
});
