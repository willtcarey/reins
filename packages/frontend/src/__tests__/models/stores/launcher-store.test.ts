import { describe, expect, test } from "bun:test";
import type { Command, LauncherContext, LauncherItem } from "@reins/sdk";
import { LauncherStore, type RecentStorage } from "../../../models/stores/launcher-store.js";
import { CommandRegistry } from "../../../sdk-host/commands.js";
import { LauncherSources } from "../../../sdk-host/launcher.js";
import { shownNewSession, shownSession, testSdk } from "../../helpers/reins-sdk.js";

const item = (id: string, extra: Partial<LauncherItem> = {}): LauncherItem => ({ id, icon: { mount() {} }, title: id, run() {}, ...extra });
const command = (name: string, extra: Partial<Command> = {}): Command => ({ name, description: `The ${name} command`, run() {}, ...extra });

function memoryStorage(initial: Record<string, string> = {}): RecentStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function launcherStore({ context = { current: null, session: null }, storage = memoryStorage(), timeoutMs = 50 }: {
  context?: LauncherContext;
  storage?: RecentStorage;
  timeoutMs?: number;
} = {}) {
  const sources = new LauncherSources();
  const commands = new CommandRegistry();
  const errors: string[] = [];
  const store = new LauncherStore({ sources, commands, context: async () => context, storage, timeoutMs, onError: (extension) => errors.push(extension) });
  return { store, sources, commands, errors };
}

const ids = (items: readonly LauncherItem[]) => items.map(({ id }) => id);

describe("gathering", () => {
  test("makes an item of each command that applies, then the extensions' items in their order", async () => {
    const { store, sources, commands } = launcherStore();
    commands.register(command("mcp", { title: "MCP servers" }));
    commands.register(command("new"));
    commands.register(command("hidden", { available: () => false }));
    commands.register(command("broken", { available: () => { throw new Error("no"); } }));
    sources.set("sessions", () => [item("session:s1")]);
    sources.set("processes", async () => [item("process:1")]);

    await store.gather();

    expect(ids(store.items)).toEqual(["command:mcp", "command:new", "session:s1", "process:1"]);
    expect(store.items[0]).toMatchObject({ title: "MCP servers", detail: "/mcp", detailStyle: "code" });
    expect(store.items[1]?.title).toBe("new");
  });

  test("runs a command's item as the composer would, with no text after its name; one that needs text rejects", async () => {
    const { store, commands } = launcherStore();
    const runs: string[] = [];
    commands.register(command("compact", { run: ({ args }) => { runs.push(args); } }));
    commands.register(command("remind", { run: ({ args }) => { if (!args) throw new Error("Say what to remind you of"); } }));
    await store.gather();

    await store.run(store.items[0]!);

    expect(runs).toEqual([""]);
    await expect(store.run(store.items[1]!)).rejects.toThrow("Say what to remind you of");
  });

  test("gives each extension where the user is", async () => {
    const context: LauncherContext = { current: shownSession("s1"), session: null };
    const { store, sources } = launcherStore({ context });
    const seen: LauncherContext[] = [];
    sources.set("test", (given) => { seen.push(given); return []; });

    await store.gather();

    expect(seen).toEqual([context]);
  });

  test("leaves out the items of an extension that throws, rejects or answers late, and keeps the others'", async () => {
    const { store, sources, errors } = launcherStore({ timeoutMs: 20 });
    sources.set("throws", () => { throw new Error("no"); });
    sources.set("rejects", async () => { throw new Error("no"); });
    sources.set("late", () => new Promise((resolve) => setTimeout(() => resolve([item("late")]), 100)));
    sources.set("fine", async () => [item("fine")]);

    await store.gather();

    expect(ids(store.items)).toEqual(["fine"]);
    expect(errors.toSorted()).toEqual(["late", "rejects", "throws"]);
  });

  test("shows the items it has while others are still coming, and is pending until they came", async () => {
    const { store, sources } = launcherStore();
    const answer = Promise.withResolvers<LauncherItem[]>();
    sources.set("slow", () => answer.promise);
    sources.set("quick", () => [item("quick")]);

    const opening = store.gather();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ids(store.items)).toEqual(["quick"]);
    expect(store.pending).toBe(true);

    answer.resolve([item("slow")]);
    await opening;
    expect(ids(store.items)).toEqual(["slow", "quick"]);
    expect(store.pending).toBe(false);
  });

  test("keeps the first item of an ID", async () => {
    const { store, sources } = launcherStore();
    sources.set("a", () => [item("same", { title: "First" })]);
    sources.set("b", () => [item("same", { title: "Second" })]);

    await store.gather();

    expect(store.items.map(({ title }) => title)).toEqual(["First"]);
  });
});

describe("the last answers", () => {
  test("shows the items an extension gave last at once while it asks again, and its new answer replaces them", async () => {
    const { store, sources } = launcherStore();
    let answer = Promise.resolve([item("session:s1")]);
    sources.set("sessions", () => answer);
    await store.gather();

    const next = Promise.withResolvers<LauncherItem[]>();
    answer = next.promise;
    const gathering = store.gather();
    expect(ids(store.items)).toEqual(["session:s1"]);

    next.resolve([item("session:s2"), item("session:s1")]);
    await gathering;
    expect(ids(store.items)).toEqual(["session:s2", "session:s1"]);
  });

  test("keeps an extension's last items when it fails or answers late", async () => {
    const { store, sources, errors } = launcherStore({ timeoutMs: 20 });
    let failing = false;
    sources.set("fails", async () => { if (failing) throw new Error("down"); return [item("a")]; });
    sources.set("late", () => failing ? new Promise<LauncherItem[]>(() => {}) : [item("b")]);
    await store.gather();

    failing = true;
    await store.gather();

    expect(ids(store.items)).toEqual(["a", "b"]);
    expect(errors.toSorted()).toEqual(["fails", "late"]);
  });

  test("drops the items of an extension that no longer gives any", async () => {
    const { store, sources } = launcherStore();
    const dispose = sources.set("gone", () => [item("a")]);
    await store.gather();

    dispose();
    await store.gather();

    expect(store.items).toEqual([]);
  });

  test("asks in the background when an extension gives its function, so the first opening has its items", async () => {
    const { store, sources } = launcherStore();
    const stop = store.followSources();
    let asked = 0;
    sources.set("sessions", () => { asked += 1; return [item("session:s1")]; });
    sources.set("processes", () => [item("process:1")]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(asked).toBe(1);
    expect(ids(store.items)).toEqual(["session:s1", "process:1"]);
    stop();
    sources.set("more", () => []);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toBe(1);
  });
});

describe("ranking", () => {
  const items = [
    item("session:s1", { title: "Build UI", detail: "Alpha · Start here" }),
    item("session:s2", { title: "Assistant", detail: "Beta · Fix the bug" }),
    item("command:compact", { title: "Compact", detail: "/compact" }),
  ];

  async function opened(storage = memoryStorage()) {
    const { store, sources } = launcherStore({ storage });
    sources.set("test", () => items);
    await store.gather();
    return store;
  }

  test("with no query, lists the items run lately first, then the rest in their order", async () => {
    const store = await opened();
    store.recordRun("command:compact");
    store.recordRun("unknown");
    store.recordRun("session:s2");

    expect(ids(store.filter(""))).toEqual(["session:s2", "command:compact", "session:s1"]);
    expect(ids(store.filter("  "))).toEqual(["session:s2", "command:compact", "session:s1"]);
  });

  test("fuzzy-matches the title and the detail, the tightest match first", async () => {
    const store = await opened();

    expect(ids(store.filter("bug"))).toEqual(["session:s2"]);
    expect(ids(store.filter("BUI"))[0]).toBe("session:s1");
    expect(ids(store.filter("alpha"))).toEqual(["session:s1"]);
    expect(ids(store.filter("/comp"))).toEqual(["command:compact"]);
    expect(store.filter("zzzz")).toEqual([]);
  });

  test("remembers what was run in its storage, and reads it again", async () => {
    const storage = memoryStorage();
    const store = await opened(storage);
    await store.run(items[2]!);

    expect(ids((await opened(storage)).filter(""))[0]).toBe("command:compact");
  });

  test("takes the sessions Quick Open remembered as the sessions' items, once", async () => {
    const storage = memoryStorage({ "reins:recent-sessions": JSON.stringify(["s2", "s1"]) });
    const store = await opened(storage);

    expect(ids(store.filter(""))).toEqual(["session:s2", "session:s1", "command:compact"]);
    expect(storage.values.has("reins:recent-sessions")).toBe(false);
  });
});

describe("followWorkspace", () => {
  test("counts each session the main area comes to be about as its item run, from any view of it", () => {
    const { reins, showMain } = testSdk();
    const { store } = launcherStore();
    const dispose = store.followWorkspace(reins.workspace);

    showMain(shownSession("s1"));
    showMain({ view: { view: "timeline", sessionId: "s2" }, subject: [{ type: "session", id: "s2" }] });
    showMain(shownNewSession(1));
    showMain(shownSession("s1"));

    expect(store.recentIds).toEqual(["session:s1", "session:s2"]);
    dispose();
    showMain(shownSession("s3"));
    expect(store.recentIds).toEqual(["session:s1", "session:s2"]);
  });

  test("does not count the shown session again while only what else the view is about changes", () => {
    const { reins, showMain, source } = testSdk();
    const { store } = launcherStore();
    store.followWorkspace(reins.workspace);
    showMain(shownSession("s1"));
    store.recordRun("command:compact");

    showMain({ view: { view: "session-changes", sessionId: "s1" }, subject: [{ type: "file", id: { source, path: "a.ts" } }, { type: "session", id: "s1" }] });

    expect(store.recentIds).toEqual(["command:compact", "session:s1"]);
  });
});
