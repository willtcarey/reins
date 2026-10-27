import { describe, expect, test } from "bun:test";
import { registerCompactCommand } from "../../../extensions/compact-command/compact-command.js";
import { shownNewSession, shownSession, testSdk } from "../../helpers/reins-sdk.js";

/** Runs `text` as the command it starts with. */
function run(commands: ReturnType<typeof testSdk>["commands"], text: string) {
  const invocation = commands.invocation(text);
  if (!invocation) throw new Error(`Expected ${text} to be a command`);
  return commands.run(invocation);
}

describe("/compact", () => {
  test("compacts the session the main area shows, the text after it focusing the summary", async () => {
    const { reins, commands, sessionCalls } = testSdk({ current: shownSession("s1") });
    registerCompactCommand(reins);

    await run(commands, "/compact");
    await run(commands, "/compact keep the API names");

    expect(sessionCalls).toEqual([
      { compact: "s1" },
      { compact: "s1", instructions: "keep the API names" },
    ]);
  });

  test("rejects where no session is shown, as on the new session page", async () => {
    const nowhere = testSdk();
    const draft = testSdk({ current: shownNewSession(7) });
    registerCompactCommand(nowhere.reins);
    registerCompactCommand(draft.reins);

    await expect(run(nowhere.commands, "/compact")).rejects.toThrow("There is no session here to compact");
    await expect(run(draft.commands, "/compact")).rejects.toThrow("There is no session here to compact");
    expect([...nowhere.sessionCalls, ...draft.sessionCalls]).toEqual([]);
  });

  test("unregisters with its disposer", () => {
    const { reins, commands } = testSdk();

    registerCompactCommand(reins)();

    expect(commands.list()).toEqual([]);
  });
});
