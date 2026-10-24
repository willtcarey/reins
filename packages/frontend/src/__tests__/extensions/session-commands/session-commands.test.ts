import { describe, expect, test } from "bun:test";
import { registerSessionCommands } from "../../../extensions/session-commands/session-commands.js";
import { testSdk } from "../../helpers/reins-sdk.js";

const idle = { sessionId: "s1", running: false };

describe("/compact", () => {
  test("compacts the session, the text after it focusing the summary", async () => {
    const { reins, commands, sessionCalls } = testSdk();
    registerSessionCommands(reins);

    await commands.invocation("/compact")?.command.run({ ...idle, args: "" });
    await commands.invocation("/compact keep the API names")?.command.run({ ...idle, args: "keep the API names" });

    expect(sessionCalls).toEqual([
      { compact: "s1", options: {} },
      { compact: "s1", options: { instructions: "keep the API names" } },
    ]);
  });

  test("cannot run while the session is running", () => {
    const { reins, commands } = testSdk();
    registerSessionCommands(reins);
    const compact = commands.invocation("/compact")?.command;

    expect(compact?.unavailable?.({ sessionId: "s1", running: true })).toBe("The session is running; compact it once it is idle");
    expect(compact?.unavailable?.(idle)).toBeNull();
  });
});

describe("/new", () => {
  test("starts a session beside the current one and opens it, the text after it as its first message", async () => {
    const { reins, commands, sessionCalls } = testSdk();
    registerSessionCommands(reins);
    const run = commands.invocation("/new")?.command.run;

    await run?.({ ...idle, args: "" });
    await run?.({ ...idle, args: "Plan the migration" });

    expect(sessionCalls).toEqual([
      { createBeside: "s1", options: {} },
      { open: "new-1" },
      { createBeside: "s1", options: { prompt: "Plan the migration" } },
      { open: "new-2" },
    ]);
  });

  test("leaves the session it was typed in when creating fails", async () => {
    const { reins, commands, sessionCalls } = testSdk({ sessions: { createBeside: () => Promise.reject(new Error("Task not found")) } });
    registerSessionCommands(reins);

    await expect(Promise.resolve(commands.invocation("/new")?.command.run({ ...idle, args: "" }))).rejects.toThrow("Task not found");
    expect(sessionCalls).toEqual([]);
  });
});

test("unregisters both commands with its disposer", () => {
  const { reins, commands } = testSdk();

  registerSessionCommands(reins)();

  expect(commands.list()).toEqual([]);
});
