import type { SessionDetailView } from "@backend/models/sessions.js";
import type { SessionCompactRequest, SessionModelUpdate } from "@backend/routes/sessions.js";
import { ReinsHttpError, type ReinsClient } from "@reins/client";
import { api } from "./api.js";
import { createClientId, type ClientPromptContent } from "./chat-content.js";
import type { ConversationsStore, LiveConversationEntry } from "./stores/conversations-store.js";

export type SubmissionOp = "prompt" | "steer";

/** Input shown in its session's conversation, and its admission by Pi: it rejects with the server's
 * refusal, which the conversation shows as well. */
export interface Submission {
  entry: LiveConversationEntry;
  admitted: Promise<void>;
}

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 10_000;

/**
 * Sends sessions' operations to the server over HTTP. A session's submissions, model changes and compactions
 * go one at a time, each once the server answered the one before, so they reach it in the order they were
 * made, and the server applies them in the order they reach it. Abort goes at once.
 */
export class SessionOperations {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly conversations: ConversationsStore;
  private readonly client: ReinsClient;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(options: { conversations: ConversationsStore; client?: ReinsClient; wait?: (ms: number) => Promise<void> }) {
    this.conversations = options.conversations;
    this.client = options.client ?? api;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Shows `content` in the session's conversation at once and submits it under a new client ID. Pi converges
   * on a repeat of the ID, so the submission is sent again until the server answers it: a request lost on
   * the network, or one that came during a reload's gap, would otherwise lose the input.
   */
  submit(sessionId: string, op: SubmissionOp, content: ClientPromptContent): Submission | null {
    const clientId = createClientId();
    const entry = this.conversations.addOptimisticUserMessage(sessionId, content, clientId);
    if (!entry) return null;
    const admitted = this.inOrder(sessionId, () => this.untilAnswered(() => (
      this.client.sessions[op](sessionId, { clientId, message: content })
    ))).then(() => undefined, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.conversations.rejectSubmission(sessionId, clientId, `${op} failed: ${message}`);
      throw error;
    });
    return { entry, admitted };
  }

  setModel(sessionId: string, update: SessionModelUpdate): Promise<SessionDetailView> {
    return this.inOrder(sessionId, () => this.client.sessions.setModel(sessionId, update));
  }

  async compact(sessionId: string, input: SessionCompactRequest = {}): Promise<void> {
    await this.inOrder(sessionId, () => this.client.sessions.compact(sessionId, input));
  }

  abort(sessionId: string): Promise<{ aborted: boolean }> {
    return this.client.sessions.abort(sessionId);
  }

  private inOrder<T>(sessionId: string, send: () => Promise<T>): Promise<T> {
    const sent = (this.tails.get(sessionId) ?? Promise.resolve()).then(send);
    const tail = sent.then(() => undefined, () => undefined);
    this.tails.set(sessionId, tail);
    void tail.then(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId); });
    return sent;
  }

  private async untilAnswered<T>(send: () => Promise<T>): Promise<T> {
    for (let delay = FIRST_RETRY_MS; ; delay = Math.min(delay * 2, MAX_RETRY_MS)) {
      try {
        return await send();
      } catch (error) {
        if (!unanswered(error)) throw error;
      }
      await this.wait(delay);
    }
  }
}

/** The request failed on the network (fetch's `TypeError`), or the server was between apps (503). */
function unanswered(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ReinsHttpError && error.status === 503);
}
