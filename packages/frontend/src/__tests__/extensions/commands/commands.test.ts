import { describe, expect, test } from "bun:test";
import { registerCommands } from "../../../extensions/commands/commands.js";
import { testSdk } from "../../helpers/reins-sdk.js";

const idle = { sessionId: "s1", running: false };

describe("/compact", () => {
  test("compacts the session, the text after it focusing the summary", async () => {
    const { reins, commands, sessionCalls } = testSdk();
    registerCommands(reins);

    await commands.invocation("/compact")?.command.run({ ...idle, args: "" });
    await commands.invocation("/compact keep the API names")?.command.run({ ...idle, args: "keep the API names" });

    expect(sessionCalls).toEqual([
      { compact: "s1", options: {} },
      { compact: "s1", options: { instructions: "keep the API names" } },
    ]);
  });

  test("cannot run while the session is running", () => {
    const { reins, commands } = testSdk();
    registerCommands(reins);
    const compact = commands.invocation("/compact")?.command;

    expect(compact?.unavailable?.({ sessionId: "s1", running: true })).toBe("The session is running; compact it once it is idle");
    expect(compact?.unavailable?.(idle)).toBeNull();
  });
});

describe("/new", () => {
  const source = { nodeId: "laptop", path: "/work/api" };

  test("starts a session where the current one is, on its task and source, and opens it, the text after it as its first message", async () => {
    const { reins, commands, sessionCalls } = testSdk({ sessions: { get: (id) => ({ id, projectId: 7, taskId: 3, source }) } });
    registerCommands(reins);
    const run = commands.invocation("/new")?.command.run;

    await run?.({ ...idle, args: "" });
    await run?.({ ...idle, args: "Plan the migration" });

    expect(sessionCalls).toEqual([
      { create: { projectId: 7, taskId: 3, source } },
      { open: "new-1" },
      { create: { projectId: 7, taskId: 3, source, prompt: "Plan the migration" } },
      { open: "new-2" },
    ]);
  });

  test("starts a new assistant conversation beside one whose source is not known yet, on the project's default source", async () => {
    const { reins, commands, sessionCalls } = testSdk({ sessions: { get: (id) => ({ id, projectId: 7, taskId: null, source: null }) } });
    registerCommands(reins);

    await commands.invocation("/new")?.command.run({ ...idle, args: "" });

    expect(sessionCalls).toEqual([{ create: { projectId: 7, taskId: null } }, { open: "new-1" }]);
  });

  test("leaves the session it was typed in when creating fails or the session is not known", async () => {
    const failing = testSdk({ sessions: { get: (id) => ({ id, projectId: 7, taskId: 3, source }), create: () => Promise.reject(new Error("Task 3 is not a task of this project")) } });
    const unknown = testSdk();
    registerCommands(failing.reins);
    registerCommands(unknown.reins);

    await expect(Promise.resolve(failing.commands.invocation("/new")?.command.run({ ...idle, args: "" }))).rejects.toThrow("Task 3 is not a task of this project");
    await expect(Promise.resolve(unknown.commands.invocation("/new")?.command.run({ ...idle, args: "" }))).rejects.toThrow("The session is not loaded yet");
    expect([...failing.sessionCalls, ...unknown.sessionCalls]).toEqual([]);
  });
});

test("unregisters both commands with its disposer", () => {
  const { reins, commands } = testSdk();

  registerCommands(reins)();

  expect(commands.list()).toEqual([]);
});
