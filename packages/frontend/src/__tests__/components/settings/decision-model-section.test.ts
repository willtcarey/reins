import { afterEach, describe, expect, test } from "bun:test";
import { SettingsDecisionModelSection } from "../../../components/settings/decision-model-section.js";
import { DecisionModelStore } from "../../../models/stores/decision-model-store.js";
import { templateToString } from "../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

const models = [
  { id: "openrouter/~liquid/d1-latest", name: "Liquid D1", input: ["text"] },
  { id: "clef__clef-flash", name: "Clef Flash", input: ["text", "image"] },
];

/** A server with `models` and the stored `decision_model` (null: none), recording its writes. */
function server(stored: string | null) {
  const writes: string[] = [];
  mockFetch(async (url, init) => {
    if (url === "/api/decisions/models") return Response.json(models);
    if (url === "/api/settings?key=decision_model") return Response.json(stored === null ? [] : [{ key: "decision_model", value: stored }]);
    if (url === "/api/settings/decision_model") {
      writes.push(`${init?.method} ${init?.body ?? ""}`);
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  });
  return writes;
}

const render = (store: DecisionModelStore) => {
  const el = new SettingsDecisionModelSection();
  el.store = store;
  return templateToString(el.render());
};

describe("the Decision model setting", () => {
  afterEach(restoreFetch);

  test("offers the decision models, with the stored one chosen", async () => {
    server("clef__clef-flash");
    const store = new DecisionModelStore();
    expect(await store.load()).toEqual({ ok: true });

    expect(store.selected).toBe("clef__clef-flash");
    const output = render(store);
    expect(output).toContain("Liquid D1");
    expect(output).toContain("openrouter/~liquid/d1-latest");
    expect(output).toContain("Clef Flash");
    expect(output).toContain("None");
  });

  test("choosing a model stores it, and None clears it", async () => {
    const writes = server(null);
    const store = new DecisionModelStore();
    await store.load();
    expect(store.selected).toBeNull();

    expect(await store.select("openrouter/~liquid/d1-latest")).toEqual({ ok: true });
    expect(store.selected).toBe("openrouter/~liquid/d1-latest");
    expect(await store.select(null)).toEqual({ ok: true });
    expect(store.selected).toBeNull();
    expect(writes).toEqual(["PUT \"openrouter/~liquid/d1-latest\"", "DELETE "]);
  });

  test("a stored model no longer listed stays shown, as unavailable", async () => {
    server("ollama__gone");
    const store = new DecisionModelStore();
    await store.load();
    expect(render(store)).toContain("ollama__gone (unavailable)");
  });

  test("without decision models, it says where they come from", async () => {
    mockFetch(async url => url === "/api/decisions/models" ? Response.json([]) : Response.json([]));
    const store = new DecisionModelStore();
    await store.load();
    expect(render(store)).toContain("No decision models");
  });
});
