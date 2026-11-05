import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { Database } from "bun:sqlite";
import { statSync } from "fs";
import { join } from "path";
import type { HttpApi, ScriptNamespace, ServerSdk, ToolResult } from "@reins/sdk/server";
import { runScript } from "../../tools/execute.js";
import { searchScriptApi } from "../../tools/search.js";
import { buildRouter } from "../../routes/index.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { makeRequest } from "../helpers/request.js";
import { testExtensionsDir, useTestDb } from "../helpers/test-db.js";
import { decrypt } from "../../crypto.js";
import { getDb } from "../../app-globals.js";
import { testExtension, testTool } from "../helpers/test-extension.js";
import { scriptContext, type ScriptCaller } from "../helpers/script-context.js";
import { createProject } from "../project-fixture.js";
import { createTask } from "../../task-store.js";

const router = buildRouter();
/** The first tool a search's answer documents. */
const firstId = (text: string) => /^ {2}(\w+)\(/m.exec(text)?.[1];
/** A value of any type, as an extension without TypeScript can give one. */
const untyped = (value: unknown) => JSON.parse(JSON.stringify({ value })).value;
/** A namespace of one method, `one`, that takes nothing and gives null. */
const namespace = (name: string): ScriptNamespace => ({ namespace: name, methods: { one: { description: "", params: [], returns: {}, tags: [], run: async () => null } } });

function script(state: TestAppState, signal?: AbortSignal, caller: ScriptCaller = {}) {
  return async (code: string) => {
    const result = await runScript(scriptContext(state, { sessionId: "caller", ...caller, ...(signal ? { signal } : {}) }), code);
    if (!result.ok) throw new Error(result.error);
    return result.text;
  };
}

describe("the server SDK's host", () => {
  useTestDb();

  describe("reins.tools", () => {
    test("search asks every provider with the query and the filters as they are, and documents the matches by their final IDs, <extension>__<local ID>", async () => {
      const first = testExtension({ title: "Deploys", tools: [testTool("vercel__list_deployments", "Lists the deployments"), testTool("vercel__get_project")] });
      const second = testExtension({ title: "Issues", tools: [testTool("github__list_issues")] });
      const state = createAppState(undefined, { extensions: [{ name: "first", register: first.register }, { name: "second", register: second.register }] });

      const text = await script(state)(`return await reins.tools.search("list deployments", { filters: { group: "vercel", other: [1] } })`);

      expect(first.searches).toEqual([{ query: "list deployments", filters: { group: "vercel", other: [1] } }]);
      expect(second.searches).toEqual([{ query: "list deployments", filters: { group: "vercel", other: [1] } }]);
      expect(text).toContain("reins.tools.call(id, args)");
      expect(text).toContain("Deploys: 1 tool matches \"list deployments\".");
      expect(text).toContain("/** Lists the deployments */\n  first__vercel__list_deployments(args: {\n    text: string;\n  }): Promise<ToolResult>;");
      expect(text).not.toContain("get_project");
      expect(text).not.toContain("Issues");
      expect(text).toContain("interface ToolResult {");
    });

    test("without filters a search gives the providers an empty object; a provider that fails is reported in its place", async () => {
      const working = testExtension({ title: "Working", tools: [testTool("a__one")] });
      const state = createAppState(undefined, {
        extensions: [
          { name: "working", register: working.register },
          { name: "broken", register: reins => reins.tools.register({ title: "Broken", search: () => Promise.reject(new Error("server down")), call: () => Promise.reject(new Error("never")) }) },
        ],
      });

      const text = await script(state)(`return await reins.tools.search("one")`);

      expect(working.searches).toEqual([{ query: "one", filters: {} }]);
      expect(text).toContain("Working: 1 tool matches \"one\".");
      expect(text).toContain("Broken: server down");
    });

    test("a query that is a tool's final ID, its local ID or its name finds that tool first; only its own extension gets the query without its prefix", async () => {
      const first = testExtension({ title: "First", tools: [testTool("vercel__list_deployments_all", "Like list_deployments, for all"), { ...testTool("vercel__list_deployments"), name: "list_deployments" }] });
      const second = testExtension({ title: "Second", tools: [] });
      const state = createAppState(undefined, { extensions: [{ name: "first", register: first.register }, { name: "second", register: second.register }] });
      const run = script(state);

      expect(firstId(await run(`return await reins.tools.search("first__vercel__list_deployments")`))).toBe("first__vercel__list_deployments");
      expect(firstId(await run(`return await reins.tools.search("vercel__list_deployments")`))).toBe("first__vercel__list_deployments");
      expect(firstId(await run(`return await reins.tools.search("list_deployments")`))).toBe("first__vercel__list_deployments");
      expect(first.searches[0]!.query).toBe("vercel__list_deployments");
      expect(second.searches[0]!.query).toBe("first__vercel__list_deployments");
    });

    test("a call goes by its prefix to that extension's provider, with the local ID; no other extension is asked", async () => {
      const first = testExtension({ title: "First", tools: [testTool("a__one")] });
      const second = testExtension({ title: "Second", tools: [testTool("a__one"), testTool("b__two")] });
      const state = createAppState(undefined, { extensions: [{ name: "first", register: first.register }, { name: "second", register: second.register }] });
      const run = script(state);

      const one: ToolResult = JSON.parse(await run(`return await reins.tools.call("second__a__one", { text: "hi" }, { timeoutMs: 5000 })`));
      const two: ToolResult = JSON.parse(await run(`return await reins.tools.call("second__b__two")`));

      expect(one).toEqual({ content: [{ type: "text", text: "Second: a__one {\"text\":\"hi\"}" }] });
      expect(two).toEqual({ content: [{ type: "text", text: "Second: b__two {}" }] });
      expect(first.calls).toEqual([]);
      expect(second.calls).toEqual([{ id: "a__one", args: { text: "hi" }, timeoutMs: 5000 }, { id: "b__two", args: {} }]);
    });

    test("an ID without a prefix, of no extension, of an extension without tools or with an invalid local ID is an unknown tool; the provider's own refusal reaches the script", async () => {
      const only = testExtension({ tools: [testTool("a__one")] });
      const state = createAppState(undefined, {
        extensions: [{ name: "only", register: only.register }, { name: "quiet", register: () => () => {} }],
      });
      const run = script(state);

      for (const id of ["a__one", "nope__a__one", "quiet__a__one", "only__", "only__a.one", "__only"]) {
        expect(run(`return await reins.tools.call(${JSON.stringify(id)}, {})`)).rejects.toThrow(`Unknown tool: ${id}. Find tools with reins.tools.search(query).`);
      }
      expect(run(`return await reins.tools.call("only__a__two", {})`)).rejects.toThrow("No such tool: a__two");
      expect(only.calls).toEqual([]);
    });

    test("a script's arguments are checked against the declared schemas before the call: a field a method does not have, a wrong type, a missing or an extra argument", async () => {
      const only = testExtension({ tools: [testTool("a__one")] });
      const run = script(createAppState(undefined, { extensions: [{ name: "only", register: only.register }] }));

      await expect(run(`return await reins.tools.search("one", { server: "x" })`)).rejects.toThrow(`reins.tools.search: options has no field "server" (its fields: filters)`);
      await expect(run(`return await reins.tools.call("only__a__one", {}, 5000)`)).rejects.toThrow("reins.tools.call: options: Expected object");
      await expect(run(`return await reins.tools.call()`)).rejects.toThrow("reins.tools.call: id is required");
      await expect(run(`return await reins.tools.call("only__a__one", {}, {}, 1)`)).rejects.toThrow("reins.tools.call takes at most 3 arguments (id, args, options)");
      await expect(run(`return await reins.tools.call("only__a__one", {}, { signal: null })`)).rejects.toThrow(`reins.tools.call: options has no field "signal" (its fields: timeoutMs)`);
      expect(only.calls).toEqual([]);
      expect(only.searches).toEqual([]);
    });

    test("an extension searches and calls every extension's tools, its own too, as scripts do", async () => {
      let reins: ServerSdk | undefined;
      const first = testExtension({ title: "First", tools: [testTool("a__one")], setup: sdk => { reins = sdk; } });
      const second = testExtension({ title: "Second", tools: [testTool("b__two"), testTool("b__three")] });
      createAppState(undefined, { extensions: [{ name: "first", register: first.register }, { name: "second", register: second.register }] });

      const groups = await reins!.tools.search("two", { filters: { group: "b" } });
      const result = await reins!.tools.call("second__b__two", { text: "hi" }, { timeoutMs: 100 });
      const own = await reins!.tools.call("first__a__one");

      expect(groups).toEqual([{ title: "First", tools: [] }, { title: "Second", tools: [{ ...testTool("b__two"), id: "second__b__two" }] }]);
      expect(second.searches).toEqual([{ query: "two", filters: { group: "b" } }]);
      expect(result).toEqual({ content: [{ type: "text", text: "Second: b__two {\"text\":\"hi\"}" }] });
      expect(own).toEqual({ content: [{ type: "text", text: "First: a__one {}" }] });
      expect(second.calls).toEqual([{ id: "b__two", args: { text: "hi" }, timeoutMs: 100 }]);
      await expect(reins!.tools.call("nope__x")).rejects.toThrow("Unknown tool: nope__x");
    });

    test("an extension has one tool provider at a time, and is told how long its local IDs may be", () => {
      const errors: string[] = [];
      let budget = 0;
      createAppState(undefined, {
        extensions: [{
          name: "twice",
          register: reins => {
            budget = reins.tools.maxLocalIdLength;
            const provider = { title: "T", search: async () => [], call: () => Promise.reject(new Error("no")) };
            const remove = reins.tools.register(provider);
            void remove();
            reins.tools.register(provider);
            reins.tools.register(provider);
            return () => {};
          },
        }],
        onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
      });

      expect(budget).toBe(64 - "twice__".length);
      expect(errors).toEqual(["twice: An extension registers one tool provider: remove the one it has first"]);
    });

    test("a tool whose local ID is not [a-zA-Z0-9_-]+, or whose final ID is longer than 64, is left out of a search and reported, never changed", async () => {
      const errors: string[] = [];
      const long = `x${"y".repeat(64 - "ext__".length)}`;
      const ext = testExtension({ title: "Ext", tools: [testTool("good_one"), testTool("bad.one"), testTool(long), testTool("x".repeat(64 - "ext__".length))] });
      const state = createAppState(undefined, {
        extensions: [{ name: "ext", register: ext.register }],
        onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
      });

      const text = await script(state)(`return await reins.tools.search("")`);

      expect(text).toContain("ext__good_one(");
      expect(text).toContain(`ext__${"x".repeat(59)}(`);
      expect(text).not.toContain("bad");
      expect(text).not.toContain(long);
      expect(errors).toEqual([
        "ext: Tool ID bad.one is left out: a local ID is [a-zA-Z0-9_-]+",
        `ext: Tool ID ${long} is left out: ext__${long} is longer than 64 characters`,
      ]);
    });

    test("search lists only the API functions, never tools", () => {
      const result = searchScriptApi("list deployments");
      expect(result.text).not.toContain("vercel__");
    });
  });

  describe("scripting", () => {
    test("an extension's namespace joins api: its methods get the script's checked arguments and session, and search documents them with their types", async () => {
      const seen: unknown[] = [];
      const NoteSchema = Type.Object({ label: Type.String() });
      const state = createAppState(undefined, {
        extensions: [{
          name: "notes",
          register: reins => reins.scripting.register({
            namespace: "notes",
            methods: {
              find: {
                description: "Find a note by its label.",
                params: [{ name: "label", schema: Type.String() }, { name: "limit", schema: Type.Number(), optional: true }],
                returns: NoteSchema,
                tags: ["note", "find"],
                run: async (context, label, limit) => {
                  seen.push({ args: [label, limit], context: { ...context, signal: context.signal instanceof AbortSignal } });
                  return { label: `found ${String(label)}` };
                },
              },
            },
            types: { Note: NoteSchema },
          }),
        }],
      });
      const signal = new AbortController().signal;
      const project = createProject("Notes", "/tmp/notes");
      const task = createTask(project.id, "Notes", null, "task/notes");
      const run = script(state, signal, { projectId: project.id, taskId: task.id });

      expect(JSON.parse(await run(`return await reins.notes.find("x", 2)`))).toEqual({ label: "found x" });
      await expect(run(`return await reins.notes.find(7)`)).rejects.toThrow("reins.notes.find: label: Expected string");
      expect(seen).toEqual([{ args: ["x", 2], context: { sessionId: "caller", projectId: project.id, taskId: task.id, signal: true } }]);
      const docs = searchScriptApi("notes find", state.extensions).text;
      expect(docs).toContain("find(label: string, limit?: number): Promise<Note>;");
      expect(docs).toContain("interface Note {");
    });

    test("a namespace already taken, by the core or another extension, refuses the registration", () => {
      const errors: unknown[] = [];
      createAppState(undefined, {
        extensions: [
          { name: "a", register: reins => reins.scripting.register(namespace("tasks")) },
          { name: "b", register: reins => reins.scripting.register(namespace("shared")) },
          { name: "c", register: reins => { try { return reins.scripting.register(namespace("shared")); } catch (error) { errors.push(error); return () => {}; } } },
        ],
        onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
      });

      expect(errors).toEqual([
        "a: The script namespace tasks is taken",
        expect.objectContaining({ message: "The script namespace shared is taken" }),
      ]);
    });

    test("a method whose param is not a TypeBox schema, or whose result or type is not a schema, or a name that is not one, refuses the registration", () => {
      const errors: string[] = [];
      const method = namespace("x").methods.one!;
      createAppState(undefined, {
        extensions: [
          { name: "a", register: reins => reins.scripting.register({ namespace: "a", methods: { one: { ...method, params: [{ name: "text", schema: { type: "string" } }] } } }) },
          { name: "b", register: reins => reins.scripting.register({ namespace: "b", methods: { one: { ...method, returns: untyped("string") } } }) },
          { name: "c", register: reins => reins.scripting.register({ ...namespace("c"), types: { Bad: untyped(null) } }) },
          { name: "d", register: reins => reins.scripting.register({ namespace: "d", methods: { "two words": method } }) },
        ],
        onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
      });

      expect(errors).toEqual([
        "a: a.one: text must be a TypeBox schema, which the host checks",
        "b: b.one: not a JSON Schema object",
        "c: Bad: not a JSON Schema object",
        "d: Not a script method name: d.two words",
      ]);
    });
  });

  describe("http", () => {
    const notesApi = {
      add: { input: Type.Object({ title: Type.String() }), output: Type.Object({ title: Type.String(), origin: Type.Union([Type.String(), Type.Null()]) }) },
      clear: {},
      fail: {},
      refuse: {},
    } satisfies HttpApi;

    /** The extension `notes` handling `notesApi`; `fail` throws an Error, `refuse` one with a status. */
    function notesState() {
      return createAppState(undefined, {
        extensions: [{
          name: "notes",
          register: reins => reins.http.handle(notesApi, {
            add: ({ input, origin }) => ({ title: input.title, origin }),
            clear: () => {},
            fail: () => { throw new Error("broke"); },
            refuse: () => { throw Object.assign(new Error("No such note"), { status: 404 }); },
          }),
        }],
      });
    }

    const callNotes = async (state: TestAppState, method: string, input?: unknown) => (await router.handle(makeRequest("POST", `/api/extensions/notes/${method}`, input), state))!;

    test("a method is called by its name under the extension's API, with its input, and answers its output", async () => {
      const state = notesState();

      const added = await callNotes(state, "add", { title: "Groceries" });
      const cleared = await callNotes(state, "clear");

      expect(added.status).toBe(200);
      expect(await added.json()).toEqual({ title: "Groceries", origin: "http://localhost" });
      expect(cleared.status).toBe(204);
    });

    test("input that its schema refuses is a 400 naming the first wrong field, and the handler is not called", async () => {
      const state = notesState();

      const response = await callNotes(state, "add", { title: 42 });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid input: /title: Expected string" });
    });

    test("a thrown error with a status is answered with it; any other is a 500 with its message", async () => {
      const state = notesState();

      const refused = await callNotes(state, "refuse");
      const failed = await callNotes(state, "fail");

      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ error: "No such note" });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "broke" });
    });

    test("a method no extension handles, or not called with POST, is a 404", async () => {
      const state = notesState();

      expect((await callNotes(state, "rename", {})).status).toBe(404);
      expect((await router.handle(makeRequest("POST", "/api/extensions/other/add", { title: "x" }), state))!.status).toBe(404);
      expect((await router.handle(makeRequest("GET", "/api/extensions/notes/clear"), state))!.status).toBe(404);
    });

    test("a method name is the extension's once: a second handler for it refuses the registration", () => {
      const errors: string[] = [];
      createAppState(undefined, {
        extensions: [{
          name: "notes",
          register: reins => {
            reins.http.handle({ clear: {} }, { clear: () => {} });
            return reins.http.handle({ clear: {} }, { clear: () => {} });
          },
        }],
        onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
      });

      expect(errors).toEqual(["notes: The notes extension already handles clear"]);
    });

    test("a page is mounted under the extension's pages, with the request's query and its own path", async () => {
      const state = createAppState(undefined, {
        extensions: [{
          name: "notes",
          register: reins => reins.http.page("/callback", ({ url }) => new Response(`page ${url.searchParams.get("code")} at ${reins.http.pagePath("/callback")}`)),
        }],
      });

      const page = (await router.handle(new Request("http://localhost/extensions/notes/callback?code=42"), state))!;
      const missing = (await router.handle(new Request("http://localhost/extensions/notes/nothing"), state))!;

      expect(await page.text()).toBe("page 42 at /extensions/notes/callback");
      expect(missing.status).toBe(404);
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
    test("a directory of its own and a database there, with the main database's settings, and not the main database", () => {
      let dataDir = "";
      let seen: { filename: string; journal: unknown; foreignKeys: unknown; tables: unknown } | undefined;
      createAppState(undefined, {
        extensions: [{
          name: "notes",
          register: reins => {
            dataDir = reins.dataDir;
            seen = {
              filename: reins.db.filename,
              journal: reins.db.query("PRAGMA journal_mode").get(),
              foreignKeys: reins.db.query("PRAGMA foreign_keys").get(),
              tables: reins.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'").all(),
            };
            return () => {};
          },
        }],
      });

      expect(dataDir).toBe(join(testExtensionsDir(), "notes"));
      expect(statSync(dataDir).isDirectory()).toBe(true);
      expect(seen).toEqual({ filename: join(dataDir, "db.sqlite"), journal: { journal_mode: "wal" }, foreignKeys: { foreign_keys: 1 }, tables: [] });
    });

    test("its migrations apply once each, in order, before it registers; the next app applies only the new ones, on the same data", () => {
      const applied: string[] = [];
      const first = [
        { id: "001_notes", up: (db: Database) => { applied.push("001"); db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)"); } },
        { id: "002_seed", up: (db: Database) => { applied.push("002"); db.exec("INSERT INTO notes (text) VALUES ('first')"); } },
      ];
      const notes = (migrations: typeof first, seen: unknown[]) => ({
        name: "notes",
        migrations,
        register: (reins: ServerSdk) => { seen.push(reins.db.query("SELECT text FROM notes").all()); return () => {}; },
      });
      const firstSeen: unknown[] = [];
      const secondSeen: unknown[] = [];

      createAppState(undefined, { extensions: [notes(first, firstSeen)] });
      createAppState(undefined, {
        extensions: [notes([...first, { id: "003_more", up: db => { applied.push("003"); db.exec("INSERT INTO notes (text) VALUES ('second')"); } }], secondSeen)],
      });

      expect(applied).toEqual(["001", "002", "003"]);
      expect(firstSeen).toEqual([[{ text: "first" }]]);
      expect(secondSeen).toEqual([[{ text: "first" }, { text: "second" }]]);
    });

    test("a failing migration is rolled back and reported, and that extension does not load; the others do", async () => {
      const errors: string[] = [];
      let registered = false;
      let tables: unknown;
      const state = createAppState(undefined, {
        extensions: [
          {
            name: "broken",
            migrations: [
              { id: "001_ok", up: db => db.exec("CREATE TABLE kept (id INTEGER)") },
              { id: "002_fails", up: db => { db.exec("CREATE TABLE half (id INTEGER)"); throw new Error("bad migration"); } },
            ],
            register: reins => {
              registered = true;
              reins.prompt.register(() => "Broken");
              return () => {};
            },
          },
          { name: "working", register: reins => reins.prompt.register(() => "Working") },
        ],
        onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
      });
      createAppState(undefined, {
        extensions: [{
          name: "broken",
          register: reins => {
            tables = reins.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('kept', 'half') ORDER BY name").all();
            return () => {};
          },
        }],
      });

      expect(errors).toEqual(["broken: bad migration"]);
      expect(registered).toBe(false);
      expect(await state.extensions.promptSections({ session: { id: "s", projectId: 1, taskId: null }, task: null, tools: null })).toEqual(["Working"]);
      expect(tables).toEqual([{ name: "kept" }]);
    });

    test("a broadcast to browsers under the extension's name", () => {
      const frames: unknown[] = [];
      createAppState({ clients: new Set([{ ws: { send: (frame: string) => { frames.push(JSON.parse(frame)); return 0; } } }]) }, {
        extensions: [{
          name: "notes",
          register: reins => {
            reins.broadcast({ type: "note_added", id: 1 });
            return () => {};
          },
        }],
      });

      expect(frames).toEqual([{ type: "extension", extension: "notes", message: { type: "note_added", id: 1 } }]);
    });

    test("secrets by key, of the extension only, encrypted with the server's key in the main database, kept across apps", async () => {
      const sdks: Record<string, ServerSdk> = {};
      const capture = (name: string) => ({ name, register: (reins: ServerSdk) => { sdks[name] = reins; return () => {}; } });
      const first = createAppState(undefined, { extensions: [capture("notes"), capture("other")] });
      const notes = sdks.notes!.secrets;

      await notes.set("servers/1/token", "s3cret");
      await notes.set("servers/1/token", "n3w");
      await notes.set("servers/10/token", "ten");
      await notes.set("servers/2/token", "two");
      await sdks.other!.secrets.set("servers/1/token", "theirs");

      expect(await notes.get("servers/1/token")).toBe("n3w");
      expect(await notes.get("servers/3/token")).toBeUndefined();
      expect(await notes.keys()).toEqual(["servers/1/token", "servers/10/token", "servers/2/token"]);
      expect(await notes.keys("servers/1/")).toEqual(["servers/1/token"]);
      expect(await notes.keys("servers/%")).toEqual([]);
      await notes.delete("servers/2/token");
      await notes.delete("servers/9/token");
      expect(await notes.keys()).toEqual(["servers/1/token", "servers/10/token"]);
      expect(await sdks.other!.secrets.get("servers/1/token")).toBe("theirs");
      await expect(notes.set("", "x")).rejects.toThrow("key");
      await expect(notes.get("k".repeat(257))).rejects.toThrow("key");

      const stored = getDb().query<{ extension: string; key: string; value: string }, []>("SELECT extension, key, value FROM extension_secrets ORDER BY extension, key").all();
      expect(stored.map(({ extension, key }) => `${extension}:${key}`)).toEqual(["notes:servers/1/token", "notes:servers/10/token", "other:servers/1/token"]);
      expect(stored.map(row => row.value).join()).not.toContain("n3w");
      expect(decrypt(stored[0]!.value)).toBe("n3w");
      expect(sdks.notes!.db.query("SELECT name FROM sqlite_master WHERE name = 'extension_secrets'").all()).toEqual([]);

      await first.extensions.dispose();
      createAppState({ process: first.process }, { extensions: [capture("notes")] });
      expect(await sdks.notes!.secrets.get("servers/1/token")).toBe("n3w");
    });
  });

  describe("GET /api/extensions: each extension, its health, what it registered and what it stores", () => {
    const list = async (state: TestAppState) => {
      const response = (await router.handle(makeRequest("GET", "/api/extensions"), state))!;
      expect(response.status).toBe(200);
      return response.json();
    };
    const fileSize = (path: string) => { try { return statSync(path).size; } catch { return 0; } };

    test("a loaded extension, in the order of registration, with what it registered and its storage", async () => {
      const notes = testExtension({
        title: "Notes tools",
        setup: reins => {
          reins.prompt.register(() => "Notes");
          reins.prompt.register(() => null);
          reins.scripting.register({ namespace: "notes", methods: { list: namespace("x").methods.one!, add: namespace("x").methods.one! } });
          reins.http.handle({ list: {}, add: {} }, { list: () => {}, add: () => {} });
          reins.http.page("/callback", () => new Response("ok"));
          return () => {};
        },
      });
      const state = createAppState(undefined, {
        extensions: [
          { name: "notes", migrations: [{ id: "001_notes", up: db => db.exec("CREATE TABLE notes (id INTEGER)") }], register: notes.register },
          { name: "quiet", register: () => () => {} },
        ],
      });

      const [first, second] = await list(state);

      const dataDir = join(testExtensionsDir(), "notes");
      expect(first).toEqual({
        name: "notes",
        status: "loaded",
        failure: null,
        errors: [],
        registrations: {
          tools: { title: "Notes tools" },
          promptSections: 2,
          settlementListeners: 0,
          scriptFunctions: ["notes.add", "notes.list"],
          httpMethods: ["add", "list"],
          pages: ["/extensions/notes/callback"],
        },
        services: [],
        storage: {
          dataDir,
          databaseBytes: fileSize(join(dataDir, "db.sqlite")) + fileSize(join(dataDir, "db.sqlite-wal")),
          migrations: { applied: [{ id: "001_notes", appliedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }], pending: [] },
          secrets: 0,
        },
      });
      expect(first.storage.databaseBytes).toBeGreaterThan(0);
      expect(second).toMatchObject({
        name: "quiet",
        status: "loaded",
        registrations: { tools: null, promptSections: 0, settlementListeners: 0, scriptFunctions: [], httpMethods: [], pages: [] },
      });
    });

    test("an extension whose migration failed is failed, with the migration's error, the migrations kept and those still pending", async () => {
      const state = createAppState(undefined, {
        extensions: [{
          name: "broken",
          migrations: [
            { id: "001_ok", up: db => db.exec("CREATE TABLE kept (id INTEGER)") },
            { id: "002_fails", up: () => { throw new Error("bad migration"); } },
            { id: "003_later", up: () => {} },
          ],
          register: reins => reins.prompt.register(() => "Broken"),
        }],
        onExtensionError: () => {},
      });

      const [broken] = await list(state);

      expect(broken.status).toBe("failed");
      expect(broken.failure).toEqual({ stage: "migration", message: "bad migration" });
      expect(broken.registrations.promptSections).toBe(0);
      expect(broken.storage.migrations.applied.map((migration: { id: string }) => migration.id)).toEqual(["001_ok"]);
      expect(broken.storage.migrations.pending).toEqual(["002_fails", "003_later"]);
    });

    test("a register function that threw is failed with its error, and nothing it registered is listed", async () => {
      const state = createAppState(undefined, {
        extensions: [{
          name: "broken",
          register: reins => {
            reins.prompt.register(() => "Half registered");
            throw new Error("cannot start");
          },
        }],
        onExtensionError: () => {},
      });

      const [broken] = await list(state);

      expect(broken).toMatchObject({ status: "failed", failure: { stage: "register", message: "cannot start" }, registrations: { promptSections: 0 } });
    });

    test("secrets are counted, neither their keys nor their values given", async () => {
      let sdk: ServerSdk | undefined;
      const state = createAppState(undefined, { extensions: [{ name: "notes", register: reins => { sdk = reins; return () => {}; } }] });
      await sdk!.secrets.set("servers/1/token", "s3cret-value");
      await sdk!.secrets.set("api-key", "other-value");

      const response = (await router.handle(makeRequest("GET", "/api/extensions"), state))!;
      const text = await response.text();

      expect(JSON.parse(text)[0].storage.secrets).toBe(2);
      expect(text).not.toContain("servers/1/token");
      expect(text).not.toContain("s3cret-value");
      expect(text).not.toContain("other-value");
    });

    test("a disposed registration is no longer listed; errors reported after loading are, the latest last", async () => {
      let removeSection: (() => unknown) | undefined;
      const state = createAppState(undefined, {
        extensions: [{
          name: "notes",
          register: reins => {
            removeSection = reins.prompt.register(() => "Notes");
            reins.prompt.register(() => { throw new Error("no section today"); });
            return () => {};
          },
        }],
        onExtensionError: () => {},
      });

      await removeSection?.();
      await state.extensions.promptSections({ session: { id: "s", projectId: 1, taskId: null }, task: null, tools: null });
      const [notes] = await list(state);

      expect(notes.status).toBe("loaded");
      expect(notes.registrations.promptSections).toBe(1);
      expect(notes.errors).toEqual([{ message: "no section today", at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }]);
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
              reins.http.handle({ x: {} }, { x: () => {} });
              return async () => { await Bun.sleep(1); disposed.push("forgetful"); };
            },
          },
        ],
      });

      await state.extensions.dispose();

      expect(kept.disposed).toBe(true);
      expect(disposed).toEqual(["forgetful"]);
      expect(await state.extensions.promptSections({ session: { id: "s", projectId: 1, taskId: null }, task: null, tools: null })).toEqual([]);
      expect((await router.handle(makeRequest("POST", "/api/extensions/forgetful/x"), state))!.status).toBe(404);
      expect(script(state)(`return await reins.tools.call("kept__a__one", {})`)).rejects.toThrow("Unknown tool");
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
