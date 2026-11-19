import { afterEach, describe, expect, test } from "bun:test";
import type { DecisionModel, DecisionRequest, DecisionResult, DecisionsProvider, RegisterExtension, ServerSdk } from "@reins/sdk/server";
import { runScript } from "../../tools/execute.js";
import { searchScriptApi } from "../../tools/search.js";
import { setSetting } from "../../settings-store.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { scriptContext } from "../helpers/script-context.js";
import { fakeClassifier, type FakeClassifier } from "../helpers/fake-classifier.js";

const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

const risky = {
  risky: { type: "bool", instructions: "Is the command risky?", criteria: { true: "It changes or deletes data", false: "It only reads" } },
} as const;

/** A provider of `models` answering each classification as `answer` says, recording the requests. */
function provider(
  models: DecisionModel[],
  answer: (model: string, request: DecisionRequest, signal: AbortSignal) => Promise<DecisionResult> | DecisionResult = () => ({ answers: { risky: { type: "bool", probability: 0.9 } } }),
  calls: { model: string; request: DecisionRequest }[] = [],
): DecisionsProvider {
  return {
    list: async () => models,
    async classify(model, request, signal) {
      calls.push({ model, request });
      return answer(model, request, signal);
    },
  };
}

const extension = (decisions: DecisionsProvider): RegisterExtension => reins => reins.decisions.registerProvider(decisions);

const app = (extensions: { name: string; register: RegisterExtension }[] = [], errors: string[] = []): TestAppState => createAppState(undefined, {
  extensions,
  onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
});

async function run(state: TestAppState, code: string, signal?: AbortSignal) {
  const result = await runScript(scriptContext(state, { sessionId: "caller", ...(signal ? { signal } : {}) }), code);
  if (!result.ok) throw new Error(result.error);
  return result;
}
const value = async (state: TestAppState, code: string) => JSON.parse((await run(state, code)).text);
const listed = (state: TestAppState): Promise<DecisionModel[]> => value(state, "return await reins.decisions.list()");
const classify = (options: string) => `return await reins.decisions.classify(${options})`;

describe("reins.decisions", () => {
  useTestDb();
  let pi: FakeClassifier | undefined;
  afterEach(() => { pi?.dispose(); pi = undefined; });

  describe("Pi's catalog", () => {
    test("list gives the classifier models of signed-in providers only, as <provider>/<id>, with their input", async () => {
      pi = fakeClassifier([{ id: "judge" }, { id: "eyes", input: ["text", "image"] }]);
      const state = app();
      const ids = async () => (await listed(state)).map(model => model.id);

      expect(await ids()).not.toContain(`${pi.provider}/judge`);
      pi.signIn();
      const models = await listed(state);
      expect(models.filter(model => model.id.startsWith(pi!.provider))).toEqual([
        { id: `${pi.provider}/judge`, name: "Fake judge", input: ["text"] },
        { id: `${pi.provider}/eyes`, name: "Fake eyes", input: ["text", "image"] },
      ]);
    });

    test("classify asks the model through Pi with the state, images, questions and temperature", async () => {
      pi = fakeClassifier([{ id: "eyes", input: ["text", "image"] }]);
      pi.signIn();
      pi.answer = () => ({ answers: { risky: { type: "bool", probability: 0.25 } }, usage: { input: 12, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0.001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0011 } } });
      const state = app();

      const result = await value(state, classify(`{ model: "${pi.provider}/eyes", state: { command: "rm -rf /" }, images: [${JSON.stringify(image)}], questions: ${JSON.stringify(risky)}, temperature: 2 }`));

      expect(result).toEqual({ model: `${pi.provider}/eyes`, answers: { risky: { type: "bool", probability: 0.25 } }, usage: { input: 12, output: 1, cost: 0.0011 } });
      expect(pi.calls).toHaveLength(1);
      expect(pi.calls[0]!.model).toBe("eyes");
      expect(pi.calls[0]!.context).toEqual({ state: { command: "rm -rf /" }, images: [image], questions: risky });
      expect(pi.calls[0]!.options?.temperature).toBe(2);
    });

    test("an error result throws its message", async () => {
      pi = fakeClassifier();
      pi.signIn();
      pi.answer = () => ({ stopReason: "error", errorMessage: "401 bad key" });
      await expect(run(app(), classify(`{ model: "${pi.provider}/judge", state: {}, questions: ${JSON.stringify(risky)} }`))).rejects.toThrow("401 bad key");
    });

    test("an unknown model throws", async () => {
      await expect(run(app(), classify(`{ model: "nobody/judge", state: {}, questions: ${JSON.stringify(risky)} }`))).rejects.toThrow("Unknown decision model: nobody/judge");
    });

    test("the script's abort aborts the call", async () => {
      pi = fakeClassifier();
      pi.signIn();
      const asked = Promise.withResolvers<void>();
      pi.answer = ({ options }) => new Promise(resolve => {
        asked.resolve();
        options?.signal?.addEventListener("abort", () => resolve({ stopReason: "aborted", errorMessage: "Request was aborted" }), { once: true });
      });
      const controller = new AbortController();
      const running = run(app(), classify(`{ model: "${pi.provider}/judge", state: {}, questions: ${JSON.stringify(risky)} }`), controller.signal);
      await asked.promise;
      controller.abort();
      await expect(running).rejects.toThrow(/abort/i);
    });
  });

  describe("extensions' providers", () => {
    test("list gives every provider's models as <extension>__<model>, after Pi's", async () => {
      const state = app([
        { name: "clef", register: extension(provider([{ id: "clef-flash", name: "Clef Flash", input: ["text", "image"] }])) },
        { name: "ollama", register: extension(provider([{ id: "remote/qwen3:4b", name: "Qwen3 4B", input: ["text"] }])) },
      ]);
      const models = await listed(state);
      expect(models.slice(-2)).toEqual([
        { id: "clef__clef-flash", name: "Clef Flash", input: ["text", "image"] },
        { id: "ollama__remote/qwen3:4b", name: "Qwen3 4B", input: ["text"] },
      ]);
    });

    test("an extension classifies with another's model through reins.decisions, which gives the provider its own ID", async () => {
      const calls: { model: string; request: DecisionRequest }[] = [];
      let reins: ServerSdk | undefined;
      app([
        { name: "clef", register: extension(provider([{ id: "a/b", name: "B", input: ["text"] }], undefined, calls)) },
        { name: "user", register: sdk => { reins = sdk; return () => {}; } },
      ]);

      const result = await reins!.decisions.classify({ model: "clef__a/b", state: { n: 1 }, questions: risky });

      expect(result).toEqual({ model: "clef__a/b", answers: { risky: { type: "bool", probability: 0.9 } } });
      expect(calls).toEqual([{ model: "a/b", request: { state: { n: 1 }, questions: risky } }]);
    });

    test("each question type, answered as asked", async () => {
      const questions = {
        route: { type: "choice", instructions: "Who handles it?", criteria: { coder: "Code changes", writer: "Docs" } },
        urgent: { type: "bool", instructions: "Is it urgent?", criteria: { true: "Today", false: "Later" } },
        effort: { type: "score", instructions: "How much work?", criteria: ["Minutes", "Hours", "Days"] },
      };
      const answers = {
        route: { type: "choice", choice: "writer", probabilities: { coder: 0.2, writer: 0.8 }, confidence: 0.6 },
        urgent: { type: "bool", probability: 0.1 },
        effort: { type: "score", score: 1.4, confidence: 0.7 },
      } as const;
      const state = app([{ name: "x", register: extension(provider([{ id: "m", name: "M", input: ["text"] }], () => ({ answers }))) }]);

      expect(await value(state, classify(`{ model: "x__m", state: { item: "Fix the README" }, questions: ${JSON.stringify(questions)} }`))).toEqual({ model: "x__m", answers });
    });

    test("a provider's malformed answers are refused", async () => {
      const questions = {
        route: { type: "choice", instructions: "Who?", criteria: { coder: "Code", writer: "Docs" } },
        effort: { type: "score", instructions: "How much?", criteria: ["Small", "Large"] },
      };
      const good = {
        route: { type: "choice", choice: "coder", probabilities: { coder: 0.9, writer: 0.1 }, confidence: 0.8 },
        effort: { type: "score", score: 0.5, confidence: 0.5 },
      };
      const cases: [unknown, string][] = [
        [{ route: good.route }, "no answer to effort"],
        [{ ...good, extra: { type: "bool", probability: 1 } }, "an answer to extra, which was not asked"],
        [{ ...good, route: { ...good.route, choice: "manager" } }, "route: manager is not one of its choices"],
        [{ ...good, route: { ...good.route, choice: "toString" } }, "route: toString is not one of its choices"],
        [{ ...good, route: { ...good.route, probabilities: { coder: 0.9, boss: 0.1 } } }, "route: a probability for boss, which is not one of its choices"],
        [{ ...good, effort: { type: "bool", probability: 0.5 } }, "effort: a bool answer to a score question"],
        [{ ...good, effort: { type: "score", score: 2, confidence: 0.5 } }, "effort: score 2 is not from 0 to 1"],
        [{ ...good, route: { ...good.route, confidence: 1.5 } }, "route:"],
        [{ ...good, effort: { type: "score", score: "high" } }, "effort:"],
      ];
      for (const [answers, message] of cases) {
        const state = app([{ name: "bad", register: extension(provider([{ id: "m", name: "M", input: ["text"] }], () => JSON.parse(JSON.stringify({ answers })))) }]);
        await expect(run(state, classify(`{ model: "bad__m", state: {}, questions: ${JSON.stringify(questions)} }`))).rejects.toThrow(`bad__m gave malformed answers: ${message}`);
      }
    });

    test("questions are checked before a provider is asked", async () => {
      const calls: { model: string; request: DecisionRequest }[] = [];
      const state = app([{ name: "x", register: extension(provider([{ id: "m", name: "M", input: ["text"] }], undefined, calls)) }]);
      const invalid = [
        `{}`,
        `{ q: { type: "choice", instructions: "Which?", criteria: { only: "One" } } }`,
        `{ q: { type: "score", instructions: "How much?", criteria: ["One"] } }`,
        `{ q: { type: "bool", instructions: "Yes?", criteria: { true: "Yes" } } }`,
        `{ q: { type: "guess", instructions: "?", criteria: {} } }`,
      ];
      for (const questions of invalid) {
        await expect(run(state, classify(`{ model: "x__m", state: {}, questions: ${questions} }`))).rejects.toThrow("questions");
      }
      expect(calls).toEqual([]);
    });

    test("images go only to a model that takes them, as image() takes them", async () => {
      const calls: { model: string; request: DecisionRequest }[] = [];
      const state = app([{ name: "x", register: extension(provider([{ id: "text", name: "T", input: ["text"] }, { id: "eyes", name: "E", input: ["text", "image"] }], undefined, calls)) }]);

      await run(state, classify(`{ model: "x__eyes", state: {}, images: { images: [${JSON.stringify(image)}] }, questions: ${JSON.stringify(risky)} }`));
      expect(calls[0]!.request.images).toEqual([image]);
      await expect(run(state, classify(`{ model: "x__text", state: {}, images: [${JSON.stringify(image)}], questions: ${JSON.stringify(risky)} }`))).rejects.toThrow("x__text does not take images");
    });

    test("an unknown model throws", async () => {
      const state = app([{ name: "x", register: extension(provider([{ id: "m", name: "M", input: ["text"] }])) }]);
      await expect(run(state, classify(`{ model: "x__other", state: {}, questions: ${JSON.stringify(risky)} }`))).rejects.toThrow("Unknown decision model: x__other");
      await expect(run(state, classify(`{ model: "nobody__m", state: {}, questions: ${JSON.stringify(risky)} }`))).rejects.toThrow("Unknown decision model: nobody__m");
    });

    test("an extension's signal reaches its provider, and an abort rejects the call", async () => {
      let reins: ServerSdk | undefined;
      app([
        { name: "slow", register: extension(provider([{ id: "m", name: "M", input: ["text"] }], (_model, _request, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
        }))) },
        { name: "user", register: sdk => { reins = sdk; return () => {}; } },
      ]);
      const controller = new AbortController();
      const call = reins!.decisions.classify({ model: "slow__m", state: {}, questions: risky, signal: controller.signal });
      controller.abort();
      await expect(call).rejects.toThrow();
    });

    test("an extension has one decisions provider at a time, removed when it is turned off", async () => {
      const errors: string[] = [];
      app([{ name: "twice", register: reins => {
        void reins.decisions.registerProvider(provider([]))();
        reins.decisions.registerProvider(provider([]));
        reins.decisions.registerProvider(provider([]));
        return () => {};
      } }], errors);
      expect(errors).toEqual(["twice: An extension registers one decisions provider at a time"]);

      // Its disposer forgets the provider: the host removes it all the same.
      const state = app([{ name: "clef", register: reins => { reins.decisions.registerProvider(provider([{ id: "m", name: "M", input: ["text"] }])); return () => {}; } }]);
      const ids = async () => (await listed(state)).map(model => model.id).filter(id => id.startsWith("clef__"));
      expect(await ids()).toEqual(["clef__m"]);
      await state.extensions.setEnabled("clef", false);
      expect(await ids()).toEqual([]);
      await state.extensions.setEnabled("clef", true);
      expect(await ids()).toEqual(["clef__m"]);
    });
  });

  describe("the default decision model", () => {
    test("is used when no model is given", async () => {
      const calls: { model: string; request: DecisionRequest }[] = [];
      const state = app([{ name: "x", register: extension(provider([{ id: "a", name: "A", input: ["text"] }, { id: "b", name: "B", input: ["text"] }], undefined, calls)) }]);
      setSetting("decision_model", "x__b");

      expect((await value(state, classify(`{ state: {}, questions: ${JSON.stringify(risky)} }`))).model).toBe("x__b");
      expect(calls.map(call => call.model)).toEqual(["b"]);
    });

    test("unset, a call without a model says how to set one", async () => {
      const state = app([{ name: "x", register: extension(provider([{ id: "a", name: "A", input: ["text"] }])) }]);
      await expect(run(state, classify(`{ state: {}, questions: ${JSON.stringify(risky)} }`))).rejects.toThrow("No decision model: give one (reins.decisions.list()), or choose a default in Settings → Models → Decision model");
    });
  });

  test("search documents reins.decisions with examples", () => {
    const text = searchScriptApi("decisions classify", undefined).text;
    expect(text).toContain("classify(options:");
    expect(text).toContain("reins.decisions.classify({");
    expect(text).toContain("type DecisionQuestion = { type: \"choice\"");
  });
});
