import { describe, test, expect, spyOn } from "bun:test";
import { type NodeCommand, type NodeResult, type NodeSessionBinding } from "@reins/node-protocol";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../migrations.js";
import { getDb, setDb } from "../../db.js";
import { createProject } from "../project-fixture.js";
import { defaultSource, createSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { claimCommand, enqueueInput as enqueue, enqueueSetModel, getCommand, insertCommand, getNodeCommand } from "../../nodes/node-command-store.js";
import { sessionRoute } from "../../nodes/commands.js";
import { Sessions } from "../../models/sessions.js";
import { createServerState } from "../helpers/server-state.js";
import { DeliveryDeferred, MAX_CONCURRENT_SESSIONS, NodeCommandDispatcher } from "../../nodes/node-command-dispatcher.js";
import { connectScriptedNode, drainCommands, loopbackLink, loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";
import { useFakeNode } from "../helpers/fake-node.js";
import { deliverNow } from "../helpers/node-session.js";

/** Queues input that is not yet admitted (so it has a command ID). */
const enqueueInput = (...args: Parameters<typeof enqueue>): string => enqueue(...args)!;
const text = [{ type: "text" as const, text: "hi" }];
const promptOf = (sessionId: string, clientId = "c"): Extract<NodeCommand, { op: "session.prompt" }> => ({ op: "session.prompt", sessionId, clientId, content: text, sourceSessionId: null });

const setup = () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  runMigrations(db);
  const project = createProject("a", "/tmp/a");
  return { db, project, source: defaultSource(project.id)! };
};
const closeDb = (db: Database) => { setDb(new Database(":memory:")); db.close(); };

/** Session "s" on the seeded node with prompt "p" queued, and a real in-process node on its loopback link. */
const nodeOwned = () => {
  const { db, project, source } = setup();
  createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id });
  const queued = enqueueInput("s", "prompt", text, "p");
  const state = createServerState(undefined, { loopbackNode: true });
  return { db, state, queued, dispose: async () => { await stopLoopbackNode(state); closeDb(db); } };
};
const admitted = (input: { clientId: string }) => Promise.resolve({ inputId: input.clientId });

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const resultFor = (command: NodeCommand, id: string): NodeResult =>
  command.op === "session.setModel" ? { ok: true, value: { modelSet: true } } : { ok: true, value: { inputId: id } };

test("work for a node that is not connected stays queued and is not sent; a connection closed mid-delivery requeues it", async () => {
  const { state, queued, dispose } = nodeOwned();
  try {
    let sent!: () => void;
    const sending = new Promise<void>(resolve => { sent = resolve; });
    const prompts = spyOn(loopbackNodeFor(state), "prompt").mockImplementation(() => { sent(); return new Promise(() => {}); });
    // The node's connection has not negotiated yet: nothing is sent, and an immediate send is deferred.
    const early = state.nodes.wake();
    const deferred = deliverNow(state, promptOf("s"));
    expect(getCommand(queued)?.state).toBe("queued");
    await early;
    await expect(deferred).rejects.toBeInstanceOf(DeliveryDeferred);

    // Once it negotiates, the queued prompt is sent.
    await sending;
    expect(getCommand(queued)?.state).toBe("dispatching");
    prompts.mockImplementation(admitted);
    loopbackLink(state).drop(); // the in-flight frame's outcome is unknown: requeued, then delivered after the redial
    for (let i = 0; i < 200 && getNodeCommand(queued) !== null; i++) await Bun.sleep(5);
    expect(getNodeCommand(queued)).toBeNull();
  } finally { await dispose(); }
});

test("a wake that arrives while a delivery is in flight retries it once that delivery is deferred", async () => {
  const { state, queued, dispose } = nodeOwned();
  try {
    let sent!: () => void;
    const sending = new Promise<void>(resolve => { sent = resolve; });
    const prompts = spyOn(loopbackNodeFor(state), "prompt").mockImplementation(() => { sent(); return new Promise(() => {}); });
    await loopbackLink(state).ready();
    void state.nodes.wake();
    await sending;
    prompts.mockImplementation(admitted);
    // A wake during the in-flight delivery (e.g. another link negotiated) is not lost to the busy chain.
    void state.nodes.wake();
    loopbackLink(state).drop(); // the in-flight prompt's outcome is unknown (requeued); the node redials
    for (let i = 0; i < 200 && getNodeCommand(queued) !== null; i++) await Bun.sleep(5);
    expect(getNodeCommand(queued)).toBeNull();
  } finally { await dispose(); }
});

test("dispatcher resolves the session's current source at delivery", async () => {
  const { db, project, source } = setup();
  try {
    createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    const queued = enqueueInput("s", "prompt", text, "c");
    const alternate = createSource(project.id, "internal", "/tmp/alternate");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(alternate.id);
    expect(db.query("SELECT * FROM node_command_outbox WHERE id = ?").get(queued)).not.toHaveProperty("source_id");
    const state = createServerState();
    const bindings: NodeSessionBinding[] = [];
    connectScriptedNode(state, "internal", { async prompt(input) { bindings.push(input.binding); return { inputId: input.clientId }; } });
    await drainCommands(state);
    expect(getNodeCommand(queued)).toBeNull();
    expect(bindings).toEqual([expect.objectContaining({ sourceId: alternate.id, cwd: "/tmp/alternate" })]);
  } finally { closeDb(db); }
});

test("startup scan recovers a missed wake and unavailable work stays queued", async () => {
  const { db, project, source } = setup();
  try {
    createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    const queued = enqueueInput("s", "prompt", text, "c");
    db.query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    const alternate = createSource(project.id, "remote", "/tmp/remote");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(alternate.id);
    const state = createServerState();
    await useFakeNode(state).link.ready();
    const dispatcher = new NodeCommandDispatcher({ route: sessionId => {
      const route = sessionRoute(new Sessions(state.nodes), sessionId);
      return route && state.nodes.get(route.nodeId).connected ? command => deliverNow(state, command) : null;
    }, delivered: () => {} });
    await dispatcher.wake();
    expect(getCommand(queued)?.state).toBe("queued");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(source.id);
    // A restarted dispatcher discovers the row even though nobody signalled it.
    dispatcher.start();
    for (let i = 0; i < 200 && getCommand(queued); i++) await Bun.sleep(5);
    expect(getCommand(queued)).toBeNull();
    dispatcher.stop();
  } finally { closeDb(db); }
});

test("a stored command that does not parse fails its delivery and is never sent", async () => {
  const { db, project, source } = setup();
  try {
    createSession("queued", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    db.query(`INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES ('invalid', 'queued', '{"op":"session.prompt"}', 'queued')`).run();
    const state = createServerState();
    const node = useFakeNode(state);
    await node.link.ready();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try { await drainCommands(state); }
    finally { errors.mockRestore(); }
    expect(node.sent).toEqual([]);
    expect(getCommand("invalid")).toBeNull();
  } finally { closeDb(db); }
});

describe("per-session concurrent delivery", () => {
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(2);
    expect(condition()).toBe(true);
  };
  /** The outbox row a send delivers: a session has at most one command dispatching. */
  const dispatching = (sessionId: string) => getDb().query<{ id: string }, [string]>("SELECT id FROM node_command_outbox WHERE session_id = ? AND state = 'dispatching'").get(sessionId)!.id;
  /** A target whose sends can be held, deferred or rejected by command ID; records per-session overlap. */
  const scriptedTarget = () => {
    const sent: Array<[string, string]> = [];
    const inFlight = new Map<string, number>();
    const holds = new Map<string, ReturnType<typeof gate>>();
    const plans = new Map<string, "defer" | "fail">();
    const stats = { overlap: false, active: 0, peak: 0 };
    const target = {
      async send(command: NodeCommand): Promise<NodeResult> {
        const id = dispatching(command.sessionId);
        sent.push([command.sessionId, id]);
        const count = (inFlight.get(command.sessionId) ?? 0) + 1;
        inFlight.set(command.sessionId, count);
        if (count > 1) stats.overlap = true;
        stats.peak = Math.max(stats.peak, ++stats.active);
        try {
          await holds.get(id)?.promise;
          if (plans.get(id) === "defer") throw new DeliveryDeferred("node offline");
          if (plans.get(id) === "fail") return { ok: false, error: { code: "invalid_request", message: "rejected", retryable: false } };
          return resultFor(command, id);
        } finally { inFlight.set(command.sessionId, inFlight.get(command.sessionId)! - 1); stats.active--; }
      },
    };
    const hold = (id: string) => { const held = gate(); holds.set(id, held); return held; };
    const sentFor = (sessionId: string) => sent.filter(([session]) => session === sessionId).map(([, id]) => id);
    /** A dispatcher delivering to this target, every node connected. */
    const dispatcher = (maxConcurrentSessions = MAX_CONCURRENT_SESSIONS) =>
      new NodeCommandDispatcher({ route: () => command => target.send(command), delivered: () => {} }, { maxConcurrentSessions });
    return { target, sent, sentFor, hold, plans, stats, dispatcher };
  };

  const withSessions = (ids: string[], run: (ctx: { script: ReturnType<typeof scriptedTarget> }) => Promise<void>) => async () => {
    const { db, project, source } = setup();
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Each session's first command is a model change (`<id>-first`).
      for (const id of ids) {
        createSession(id, project.id, { agentRuntimeType: "pi", sourceId: source.id });
        insertCommand(`${id}-first`, id, JSON.stringify({ op: "session.setModel", provider: "anthropic", modelId: "m" }));
      }
      await run({ script: scriptedTarget() });
    } finally { warnings.mockRestore(); closeDb(db); }
  };

  test("a stalled session does not delay another session's delivery", withSessions(["a", "b"], async ({ script }) => {
    const stalled = script.hold("a-first");
    const prompt = enqueueInput("b", "prompt", text, "b-p");
    const dispatcher = script.dispatcher();
    dispatcher.wake();
    await until(() => getCommand(prompt) === null);
    expect(getNodeCommand("b-first")).toBeNull();
    expect(getNodeCommand(prompt)).toBeNull();
    expect(getCommand("a-first")?.state).toBe("dispatching");
    stalled.release();
    await dispatcher.wake();
    expect(getNodeCommand("a-first")).toBeNull();
  }));

  test("each session delivers in outbox order, one command at a time, across overlapping wakes and dispatchers", withSessions(["a", "b"], async ({ script }) => {
    const a = ["a-first", enqueueInput("a", "prompt", text, "a-p"), enqueueSetModel("a", { provider: "anthropic", modelId: "m" }), enqueueInput("a", "steer", text, "a-s")];
    const b = ["b-first", enqueueInput("b", "prompt", text, "b-p")];
    const holds = [...a, ...b].map(id => script.hold(id));
    script.plans.set(b[1]!, "fail");
    // The claim itself refuses a command behind undelivered work in its session.
    expect(claimCommand(a[1]!)).toBe(false);
    const dispatcher = script.dispatcher();
    // Atomic claims protect ordering even if two dispatchers are accidentally started.
    const reloaded = script.dispatcher();
    dispatcher.wake();
    for (const hold of holds) {
      dispatcher.wake();
      reloaded.wake();
      void reloaded.wake();
      await Bun.sleep(1);
      hold.release();
      await Bun.sleep(1);
    }
    await Promise.all([dispatcher.wake(), reloaded.wake()]);
    expect(script.stats.overlap).toBe(false);
    expect(script.sentFor("a")).toEqual(a);
    expect(script.sentFor("b")).toEqual(b);
    for (const id of a) expect(getNodeCommand(id)).toBeNull();
    // Failed input is removed after notification, just like admitted work.
    expect(getNodeCommand(b[1]!)).toBeNull();
    expect(getDb().query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
  }));

  test("a deferred command waits for the next wake instead of spinning, without blocking other sessions", withSessions(["a", "b"], async ({ script }) => {
    script.plans.set("a-first", "defer");
    const held = script.hold("b-first");
    const dispatcher = script.dispatcher();
    dispatcher.wake();
    await until(() => script.sentFor("a").length === 1 && getCommand("a-first")?.state === "queued");
    enqueueInput("a", "prompt", text, "a-p");
    held.release();
    await dispatcher.wake(); // drain is a wake: the deferred command is retried exactly once
    expect(script.sentFor("a")).toEqual(["a-first", "a-first"]);
    await Bun.sleep(20);
    expect(script.sentFor("a")).toEqual(["a-first", "a-first"]);
    expect(getNodeCommand("b-first")).toBeNull();
    script.plans.delete("a-first");
    await dispatcher.wake();
    expect(script.sentFor("a")).toEqual(["a-first", "a-first", "a-first", expect.any(String)]);
  }));

  test("concurrent sessions are capped", withSessions(["a", "b", "c", "d"], async ({ script }) => {
    const holds = ["a", "b", "c", "d"].map(id => script.hold(`${id}-first`));
    const dispatcher = script.dispatcher(2);
    const drained = dispatcher.wake();
    await Bun.sleep(5);
    expect(script.sent.map(([, id]) => id)).toEqual(["a-first", "b-first"]);
    holds[1]!.release();
    await until(() => script.sent.length === 3);
    expect(script.sent[2]![1]).toBe("c-first");
    for (const hold of holds) hold.release();
    await drained;
    expect(script.stats.peak).toBe(2);
    for (const id of ["a", "b", "c", "d"]) expect(getNodeCommand(`${id}-first`)).toBeNull();
  }));

  test("a stopped dispatcher finishes in-flight delivery but starts no new delivery", withSessions(["a", "b"], async ({ script }) => {
    const held = script.hold("a-first");
    script.hold("b-first").release();
    const prompt = enqueueInput("a", "prompt", text, "a-p");
    const dispatcher = script.dispatcher(1);
    dispatcher.start();
    await until(() => script.sent.length === 1);
    dispatcher.stop();
    held.release();
    await dispatcher.wake();
    dispatcher.wake();
    await Bun.sleep(10);
    expect(getNodeCommand("a-first")).toBeNull();
    expect(getCommand(prompt)?.state).toBe("queued");
    expect(getCommand("b-first")?.state).toBe("queued");
    await script.dispatcher().wake();
    expect(getNodeCommand(prompt)).toBeNull();
  }));
});
