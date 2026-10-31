import { describe, expect, test } from "bun:test";
import type { ToolResult } from "@reins/sdk/server";
import { runScript } from "../../tools/execute.js";
import { searchScriptApi } from "../../tools/search.js";
import { Models } from "../../models/models.js";
import { buildRouter } from "../../routes/index.js";
import type { ApiContext } from "../../scripting/define-function.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { makeRequest } from "../helpers/request.js";
import { useTestDb } from "../helpers/test-db.js";
import { decrypt } from "../../crypto.js";
import { testExtension, testTool } from "../helpers/test-extension.js";

const router = buildRouter();
const fn = (name: string) => ({ name, description: "", parameters: { type: "object", properties: {} }, returns: {}, tags: [], execute: () => null });

function script(state: TestAppState, signal?: AbortSignal) {
  const models = new Models(state);
  const ctx: ApiContext = { projectId: 7, sessionId: "caller", taskId: 3, broadcast: models.broadcast, sourceId: 0, nodes: state.nodes, models, signal };
  return async (code: string) => {
    const result = await runScript(ctx, code);
    if (!result.ok) throw new Error(result.error);
    return result.text;
  };
}

describe("the server SDK's host", () => {
  useTestDb();

  describe("api.tools", () => {
    test("search asks every source with the query and the filters as they are, and documents the matches by source", async () => {
      const first = testExtension({ title: "Deploys", tools: [testTool("vercel__list_deployments", "Lists the deployments"), testTool("vercel__get_project")] });
      const second = testExtension({ title: "Issues", tools: [testTool("github__list_issues")] });
      const state = createAppState(undefined, { extensions: [{ name: "first", register: first.register }, { name: "second", register: second.register }] });

      const text = await script(state)(`return await api.tools.search("list deployments", { group: "vercel", other: [1] })`);

      expect(first.searches).toEqual([{ query: "list deployments", filters: { group: "vercel", other: [1] } }]);
      expect(second.searches).toEqual([{ query: "list deployments", filters: { group: "vercel", other: [1] } }]);
      expect(text).toContain("api.tools.call(id, args)");
      expect(text).toContain("Deploys: 1 tool matches \"list deployments\".");
      expect(text).toContain("/** Lists the deployments */\n  vercel__list_deployments(args: {\n    text: string;\n  }): Promise<ToolResult>;");
      expect(text).not.toContain("get_project");
      expect(text).not.toContain("Issues");
      expect(text).toContain("interface ToolResult {");
    });

    test("without filters a search gives the sources an empty object; a source that fails is reported in its place", async () => {
      const working = testExtension({ title: "Working", tools: [testTool("a__one")] });
      const state = createAppState(undefined, {
        extensions: [
          { name: "working", register: working.register },
          { name: "broken", register: reins => reins.tools.register({ title: "Broken", search: () => Promise.reject(new Error("server down")), call: async () => null }) },
        ],
      });

      const text = await script(state)(`return await api.tools.search("one")`);

      expect(working.searches).toEqual([{ query: "one", filters: {} }]);
      expect(text).toContain("Working: 1 tool matches \"one\".");
      expect(text).toContain("Broken: server down");
    });

    test("a call goes to the first source, in the order of registration, that claims the ID; no other source is asked after it", async () => {
      const first = testExtension({ title: "First", tools: [testTool("a__one")] });
      const second = testExtension({ title: "Second", tools: [testTool("a__one"), testTool("b__two")] });
      const state = createAppState(undefined, { extensions: [{ name: "first", register: first.register }, { name: "second", register: second.register }] });
      const run = script(state);

      const one: ToolResult = JSON.parse(await run(`return await api.tools.call("a__one", { text: "hi" }, 5000)`));
      const two: ToolResult = JSON.parse(await run(`return await api.tools.call("b__two")`));

      expect(one).toEqual({ content: [{ type: "text", text: "First: a__one {\"text\":\"hi\"}" }] });
      expect(two).toEqual({ content: [{ type: "text", text: "Second: b__two {}" }] });
      expect(first.calls).toEqual([{ id: "a__one", args: { text: "hi" }, timeoutMs: 5000 }]);
      expect(second.calls).toEqual([{ id: "b__two", args: {} }]);
    });

    test("an ID no source claims is an unknown tool", async () => {
      const state = createAppState(undefined, { extensions: [{ name: "only", register: testExtension({ tools: [testTool("a__one")] }).register }] });

      expect(script(state)(`return await api.tools.call("a__two", {})`)).rejects.toThrow("Unknown tool: a__two. Find tools with api.tools.search(query).");
    });

    test("search lists only the API functions, never tools", () => {
      const result = searchScriptApi("list deployments");
      expect(result.text).not.toContain("vercel__");
    });
  });

  describe("scripting", () => {
    test("an extension's functions join api, get the session, and search documents them with their types", async () => {
      const seen: unknown[] = [];
      const itemSchema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
      const state = createAppState(undefined, {
        extensions: [{
          name: "notes",
          register: reins => reins.scripting.register({
            functions: [{
              name: "notes.find",
              description: "Find a note by its label.",
              parameters: { type: "object", properties: { label: { type: "string" }, limit: { type: "number" } }, required: ["label"] },
              returns: itemSchema,
              async: true,
              tags: ["note", "find"],
              execute: async (params, context) => {
                seen.push({ params, context: { ...context, signal: context.signal instanceof AbortSignal } });
                return { label: `found ${String(params.label)}` };
              },
            }],
            types: [{ name: "Note", schema: itemSchema }],
          }),
        }],
      });
      const signal = new AbortController().signal;

      expect(JSON.parse(await script(state, signal)(`return await api.notes.find("x", 2)`))).toEqual({ label: "found x" });
      expect(seen).toEqual([{ params: { label: "x", limit: 2 }, context: { sessionId: "caller", projectId: 7, taskId: 3, signal: true } }]);
      const docs = searchScriptApi("notes find", state.extensions).text;
      expect(docs).toContain("find(label: string, limit?: number): Promise<Note>;");
      expect(docs).toContain("interface Note {");
    });

    test("a namespace already taken, by the core or another extension, refuses the registration", () => {
      const errors: unknown[] = [];
      createAppState(undefined, {
        extensions: [
          { name: "a", register: reins => reins.scripting.register({ functions: [fn("tasks.mine")] }) },
          { name: "b", register: reins => reins.scripting.register({ functions: [fn("shared.one")] }) },
          { name: "c", register: reins => { try { return reins.scripting.register({ functions: [fn("shared.two")] }); } catch (error) { errors.push(error); return () => {}; } } },
        ],
        onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
      });

      expect(errors).toEqual([
        "a: The api namespace tasks is taken",
        expect.objectContaining({ message: "The api namespace shared is taken" }),
      ]);
    });
  });

  describe("routes", () => {
    test("an extension's API and pages are mounted under its name, with the request's params and origin", async () => {
      const state = createAppState(undefined, {
        extensions: [{
          name: "notes",
          register: reins => {
            const api = reins.routes.api.post("/items/:id", async ({ req, params, origin }) => Response.json({ id: params.id, body: await req.json(), origin }));
            const page = reins.routes.pages.get("/callback", ({ url }) => new Response(`page ${url.searchParams.get("code")} at ${reins.routes.pagePath("/callback")}`));
            return () => { api(); page(); };
          },
        }],
      });

      const api = (await router.handle(makeRequest("POST", "/api/extensions/notes/items/a%20b", { x: 1 }), state))!;
      expect(await api.json()).toEqual({ id: "a b", body: { x: 1 }, origin: "http://localhost" });
      const page = (await router.handle(new Request("http://localhost/extensions/notes/callback?code=42"), state))!;
      expect(await page.text()).toBe("page 42 at /extensions/notes/callback");
      const missing = (await router.handle(makeRequest("GET", "/api/extensions/notes/nothing"), state))!;
      expect(missing.status).toBe(404);
      const otherExtension = (await router.handle(makeRequest("POST", "/api/extensions/other/items/1", {}), state))!;
      expect(otherExtension.status).toBe(404);
    });

    test("a handler's throw is a 500 with its message", async () => {
      const state = createAppState(undefined, {
        extensions: [{ name: "notes", register: reins => reins.routes.api.get("/fail", () => { throw new Error("broke"); }) }],
      });

      const response = (await router.handle(makeRequest("GET", "/api/extensions/notes/fail"), state))!;

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "broke" });
    });
  });

  describe("the system prompt", () => {
    test("sections come in the order of registration, from the session's context; none and failures are left out", async () => {
      const contexts: unknown[] = [];
      const state = createAppState(undefined, {
        extensions: [
          { name: "a", register: reins => reins.prompt.register(context => { contexts.push(context); return "Section A"; }) },
          { name: "b", register: reins => reins.prompt.register(() => null) },
          { name: "c", register: reins => reins.prompt.register(() => { throw new Error("no"); }) },
          { name: "d", register: reins => reins.prompt.register(async () => "Section D") },
        ],
        onExtensionError: () => {},
      });
      const context = { session: { id: "s1", projectId: 1, taskId: 2 }, task: { id: 2, title: "T", description: null }, tools: null };

      expect(await state.extensions.promptSections(context)).toEqual(["Section A", "Section D"]);
      expect(contexts).toEqual([context]);
    });
  });

  describe("what an extension uses", () => {
    test("the process's database, and a broadcast to browsers under the extension's name", () => {
      const frames: unknown[] = [];
      let count: unknown;
      createAppState({ clients: new Set([{ ws: { send: (frame: string) => { frames.push(JSON.parse(frame)); return 0; } } }]) }, {
        extensions: [{
          name: "notes",
          register: reins => {
            count = reins.db.query<{ count: number }, []>("SELECT count(*) AS count FROM projects").get()?.count;
            reins.broadcast({ type: "note_added", id: 1 });
            return () => {};
          },
        }],
      });

      expect(count).toBe(0);
      expect(frames).toEqual([{ type: "extension", extension: "notes", message: { type: "note_added", id: 1 } }]);
    });

    test("secrets encrypted with the server's key, as the core keeps its own", () => {
      let sealed = "";
      let opened = "";
      createAppState(undefined, {
        extensions: [{
          name: "notes",
          register: reins => {
            sealed = reins.secrets.encrypt("s3cret");
            opened = reins.secrets.decrypt(sealed);
            return () => {};
          },
        }],
      });

      expect(sealed).not.toContain("s3cret");
      expect(opened).toBe("s3cret");
      expect(decrypt(sealed)).toBe("s3cret");
    });
  });

  describe("lifecycle", () => {
    test("stopping the app disposes each extension and removes what it registered, even what its disposer forgot", async () => {
      const disposed: string[] = [];
      const kept = testExtension({ tools: [testTool("a__one")] });
      const state = createAppState(undefined, {
        extensions: [
          { name: "kept", register: kept.register },
          {
            name: "forgetful",
            register: reins => {
              reins.prompt.register(() => "Forgotten");
              reins.routes.api.get("/x", () => new Response("x"));
              return async () => { await Bun.sleep(1); disposed.push("forgetful"); };
            },
          },
        ],
      });

      await state.extensions.dispose();

      expect(kept.disposed).toBe(true);
      expect(disposed).toEqual(["forgetful"]);
      expect(await state.extensions.promptSections({ session: { id: "s", projectId: 1, taskId: null }, task: null, tools: null })).toEqual([]);
      expect((await router.handle(makeRequest("GET", "/api/extensions/forgetful/x"), state))!.status).toBe(404);
      expect(script(state)(`return await api.tools.call("a__one", {})`)).rejects.toThrow("Unknown tool");
    });

    test("an extension whose register function throws is logged, and what it registered before is removed", async () => {
      const errors: string[] = [];
      const state = createAppState(undefined, {
        extensions: [{
          name: "broken",
          register: reins => {
            reins.prompt.register(() => "Half registered");
            throw new Error("cannot start");
          },
        }],
        onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
      });

      expect(errors).toEqual(["broken: cannot start"]);
      expect(await state.extensions.promptSections({ session: { id: "s", projectId: 1, taskId: null }, task: null, tools: null })).toEqual([]);
    });

    test("a disposer removes only its own registration", async () => {
      let remove: (() => unknown) | undefined;
      const state = createAppState(undefined, {
        extensions: [{
          name: "two",
          register: reins => {
            const first = reins.prompt.register(() => "First");
            reins.prompt.register(() => "Second");
            remove = first;
            return () => {};
          },
        }],
      });

      await remove?.();

      expect(await state.extensions.promptSections({ session: { id: "s", projectId: 1, taskId: null }, task: null, tools: null })).toEqual(["Second"]);
    });
  });
});
