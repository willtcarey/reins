/**
 * Fake model: TEST UTILITY ONLY.
 *
 * A faux provider registered with the server's model runtime, for tests of the server logic above the
 * session runtimes (submission, waits, child reports, scripting, WS) that need runs whose replies the test
 * controls. Each model request is a turn the test finishes explicitly, so a run stays in progress until
 * then; an abort ends the turn on its own. Sessions run on the server's real runtimes (ADR-029).
 */
import { afterEach, beforeEach } from "bun:test";
import { fauxAssistantMessage, fauxProvider, type AssistantMessage, type Context, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { registerPiProvider, unregisterPiProvider } from "../../pi/factory.js";

export interface FakeTurn {
  /** The session the request is for. */
  sessionId: string;
  /** The model asked (`fake` or `other`). */
  modelId: string;
  /** What the model was asked. */
  context: Context;
  /** The text of the request's last user message. */
  input: string;
  /** Answers the request: `reply` as the assistant's final message, or a failure. */
  finish(outcome?: { reply?: string; status?: "completed" | "failed"; error?: string }): void;
}

export interface FakeModel {
  /** The provider and model to create sessions with; the provider also has a model `other`. */
  readonly model: { provider: string; modelId: string };
  /** Requests made, in order. */
  readonly turns: FakeTurn[];
  /** Resolves with the next turn of `sessionId` not yet finished (waiting for it, up to `timeoutMs`). */
  nextTurn(sessionId: string, timeoutMs?: number): Promise<FakeTurn>;
  /** Resolves with the next standalone request not yet finished, such as a compaction summary, which Pi
   * sends under a session ID of its own rather than `<sessionId>:<lane>`. */
  nextSummary(timeoutMs?: number): Promise<FakeTurn>;
  dispose(): void;
}

let models = 0;

const lastUserText = (context: Context) => {
  const user = context.messages.filter(message => message.role === "user").at(-1);
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
};

/** Registers a fake model with the server's model runtime, with a stored API key. */
export function fakeModel(): FakeModel {
  const provider = fauxProvider({ provider: `fake-model-${++models}`, models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }, { id: "other", contextWindow: 200_000, maxTokens: 1_000 }] });
  const turns: FakeTurn[] = [];
  const finished = new WeakSet<FakeTurn>();
  const standalone = new WeakSet<FakeTurn>();
  const respond: FauxResponseFactory = (context, options, _state, model) => {
    provider.appendResponses([respond]);
    return new Promise<AssistantMessage>(resolve => {
      const signal = options?.signal;
      const turn: FakeTurn = {
        // Pi names the request's session `<sessionId>:<lane>`.
        sessionId: String(options?.sessionId ?? "").replace(/:[^:]*$/, ""),
        modelId: model.id,
        context, input: lastUserText(context),
        finish({ reply = `response ${turns.indexOf(turn) + 1}`, status = "completed", error } = {}) {
          if (finished.has(turn)) return;
          finished.add(turn);
          resolve(status === "completed" ? fauxAssistantMessage(reply) : fauxAssistantMessage("", { stopReason: "error", errorMessage: error ?? "failed" }));
        },
      };
      // An abort ends the request (the provider reports it aborted).
      signal?.addEventListener("abort", () => { finished.add(turn); resolve(fauxAssistantMessage("")); }, { once: true });
      if (!String(options?.sessionId ?? "").includes(":")) standalone.add(turn);
      turns.push(turn);
    });
  };
  provider.setResponses([respond]);
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
  const next = async (matches: (turn: FakeTurn) => boolean, what: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const turn = turns.find(candidate => matches(candidate) && !finished.has(candidate));
      if (turn) return turn;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await Bun.sleep(5);
    }
  };
  return {
    model: { provider: provider.provider.id, modelId: "fake" },
    turns,
    nextTurn: (sessionId, timeoutMs = 10_000) => next(turn => turn.sessionId === sessionId, `a model request of session ${sessionId}`, timeoutMs),
    nextSummary: (timeoutMs = 10_000) => next(turn => standalone.has(turn), "a standalone model request", timeoutMs),
    dispose() {
      for (const turn of turns) turn.finish();
      unregisterPiProvider(provider.provider.id);
    },
  };
}

/** Registers hooks giving each test a fresh fake model (after `useTestDb()`: its API key is stored). */
export function useFakeModel(): FakeModel {
  let current: FakeModel | undefined;
  beforeEach(() => { current = fakeModel(); });
  afterEach(() => { current?.dispose(); current = undefined; });
  const get = () => { if (!current) throw new Error("useFakeModel: no test is running"); return current; };
  return {
    get model() { return get().model; },
    get turns() { return get().turns; },
    nextTurn: (sessionId, timeoutMs) => get().nextTurn(sessionId, timeoutMs),
    nextSummary: timeoutMs => get().nextSummary(timeoutMs),
    dispose: () => get().dispose(),
  };
}
