import { describe, expect, test } from "bun:test";
import type { CurrentView, Session, Sessions } from "@reins/sdk";
import { registerNewSessionCommand } from "../../../extensions/new-session-command/new-session-command.js";
import { shownNewSession, shownSession, testSdk } from "../../helpers/reins-sdk.js";

const source = { nodeId: "laptop", path: "/work/api" };

/** Sessions whose `get` knows `s1`, on task 3 of project 7 on a laptop's checkout. */
const knowingS1: Partial<Sessions> = {
  get: async (id): Promise<Session> => {
    if (id !== "s1") throw new Error(`Session ${id} not found`);
    return { id, projectId: 7, taskId: 3, parentSessionId: null, name: null, source };
  },
};

/** `/new` registered where the main area shows `current`, session `s1` with its details by default. */
function newCommandIn(sessions: Partial<Sessions>, current: CurrentView | null = shownSession("s1", { projectId: 7, taskId: 3 })) {
  const sdk = testSdk({ current, sessions });
  registerNewSessionCommand(sdk.reins);
  const run = (text: string) => {
    const invocation = sdk.commands.invocation(text);
    if (!invocation) throw new Error(`Expected ${text} to be a command`);
    return sdk.commands.run(invocation);
  };
  return { ...sdk, run };
}

describe("/new", () => {
  test("opens the new session page in the shown session's project and task", async () => {
    const onTask = newCommandIn({});
    const nowhere = newCommandIn({}, null);

    await onTask.run("/new");
    await nowhere.run("/new");

    expect(onTask.shownViews).toEqual([{ view: "new-session", projectId: 7, taskId: 3 }]);
    expect(nowhere.shownViews).toEqual([{ view: "new-session", projectId: null, taskId: null }]);
    expect([...onTask.sessionCalls, ...nowhere.sessionCalls]).toEqual([]);
  });

  test("with text after it, starts a session where the shown one is, on its task and source as the server tells, with the text as its first message, and shows it", async () => {
    const { run, sessionCalls, shownViews } = newCommandIn(knowingS1, shownSession("s1"));

    await run("/new Plan the migration");

    expect(sessionCalls).toEqual([{ create: { projectId: 7, taskId: 3, source, prompt: "Plan the migration" } }]);
    expect(shownViews).toEqual([{ view: "session", sessionId: "new-1" }]);
  });

  test("with text after it, starts a session in the project and task chosen on the new session page", async () => {
    const { run, sessionCalls } = newCommandIn({}, shownNewSession(7, 3));

    await run("/new Plan the migration");

    expect(sessionCalls).toEqual([{ create: { projectId: 7, taskId: 3, prompt: "Plan the migration" } }]);
  });

  test("starts the session in the place it was run from, even when another session is shown before it is created", async () => {
    const created = Promise.withResolvers<string>();
    const { reins, run, sessionCalls, shownViews } = newCommandIn({
      ...knowingS1,
      create: (options) => {
        sessionCalls.push({ create: options });
        return created.promise;
      },
    });

    const running = run("/new Plan the migration");
    reins.workspace.open({ view: "session", sessionId: "elsewhere" }, { in: "main" });
    created.resolve("new-1");
    await running;

    expect(sessionCalls).toEqual([{ create: { projectId: 7, taskId: 3, source, prompt: "Plan the migration" } }]);
    expect(shownViews).toEqual([{ view: "session", sessionId: "elsewhere" }, { view: "session", sessionId: "new-1" }]);
  });

  test("with text after it, rejects, showing nothing, when creating fails, the shown session is gone or no project is chosen", async () => {
    const failing = newCommandIn({ ...knowingS1, create: () => Promise.reject(new Error("Task 3 is not a task of this project")) });
    const gone = newCommandIn(knowingS1, shownSession("deleted"));
    const unchosen = newCommandIn({}, shownNewSession(null));

    await expect(failing.run("/new Plan the migration")).rejects.toThrow("Task 3 is not a task of this project");
    await expect(gone.run("/new Plan the migration")).rejects.toThrow("Session deleted not found");
    await expect(unchosen.run("/new Plan the migration")).rejects.toThrow("Choose a project to start a session in");
    expect([...failing.shownViews, ...gone.sessionCalls, ...gone.shownViews, ...unchosen.sessionCalls, ...unchosen.shownViews]).toEqual([]);
  });

  test("unregisters with its disposer", () => {
    const { reins, commands } = testSdk();

    registerNewSessionCommand(reins)();

    expect(commands.list()).toEqual([]);
  });
});
