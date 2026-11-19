/**
 * Fake classifier: TEST UTILITY ONLY. A Pi provider of classifier models registered with the server's model
 * runtimes (`registerPiProvider`), signed in only once `signIn` stores its API key, whose answers the test
 * gives and whose requests it records.
 */
import type { ClassifierContext, ClassifierModel, ClassifierOptions, ClassifierResult, Provider } from "@earendil-works/pi-ai";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { registerPiProvider, unregisterPiProvider } from "../../pi/factory.js";

export interface FakeClassifierCall {
  model: string;
  context: ClassifierContext;
  options?: ClassifierOptions;
}

export type FakeClassifierAnswer = (call: FakeClassifierCall) => Promise<Partial<ClassifierResult>> | Partial<ClassifierResult>;

export interface FakeClassifier {
  readonly provider: string;
  readonly calls: FakeClassifierCall[];
  /** What the next calls get: answers, or an error result (`stopReason: "error"`). */
  answer: FakeClassifierAnswer;
  signIn(): void;
  dispose(): void;
}

let classifiers = 0;

export function fakeClassifier(models: { id: string; input?: ("text" | "image")[] }[] = [{ id: "judge" }]): FakeClassifier {
  const providerId = `fake-classifier-${++classifiers}`;
  const classifierModels: ClassifierModel<string>[] = models.map(({ id, input = ["text"] }) => ({
    type: "classifier", id, name: `Fake ${id}`, api: "fake-classify", provider: providerId, baseUrl: "http://127.0.0.1:9",
    input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000,
  }));
  const fake: FakeClassifier = {
    provider: providerId,
    calls: [],
    answer: () => ({ answers: {} }),
    signIn: () => setApiKeyCredential(providerId, "sk-fake"),
    dispose: () => unregisterPiProvider(providerId),
  };
  const provider: Provider = {
    id: providerId,
    name: "Fake classifier",
    auth: {
      apiKey: {
        name: "Fake key",
        resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined,
      },
    },
    getModels: () => [],
    getAllModels: () => classifierModels,
    stream: () => { throw new Error("A classifier does not chat"); },
    streamSimple: () => { throw new Error("A classifier does not chat"); },
    async classify(model, context, options) {
      const call = { model: model.id, context, options };
      fake.calls.push(call);
      const result = await fake.answer(call);
      return { api: model.api, provider: providerId, model: model.id, answers: {}, stopReason: "stop", timestamp: Date.now(), ...result };
    },
  };
  registerPiProvider(provider);
  return fake;
}
