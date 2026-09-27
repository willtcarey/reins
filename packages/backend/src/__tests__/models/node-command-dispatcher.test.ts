import { describe, test, expect, spyOn } from "bun:test";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../migrations.js";
import { getDb, setDb } from "../../db.js";
import { nodeSessionBinding, openNodeDb } from "@reins/node/storage";
import { NodeRejection } from "@reins/node/protocol";
import { createProject } from "../../project-store.js";
import { defaultSource, createSource } from "../../node-store.js";
import { createSession, getSession } from "../../session-store.js";
import { claimCommand, enqueueInput as enqueue, enqueueSetModel, getCommand } from "../../node-command-store.js";
import { recoverInterruptedDispatches } from "../../node-command-recovery.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { createServerState } from "../helpers/server-state.js";
import { Sessions } from "../../models/sessions.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { createSessionWithProvision, getNodeCommand } from "../../node-command-store.js";
import { MAX_CONCURRENT_SESSIONS, NodeCommandDispatcher } from "../../models/node-command-dispatcher.js";
import { commitPlacement } from "../../models/session-ownership.js";
import { sessionBinding } from "../../runtimes/node-source.js";
import { waitUntilProvisioned } from "../../runtimes/node-execution.js";
import { directLink, drainCommands, loopbackLink, loopbackNodeFor, stopLoopbackNode } from "../helpers/loopback-node.js";
import { useFakeNode } from "../helpers/fake-node.js";
import { closeTestNodeDb, setTestNodeDb } from "../helpers/test-db.js";
import { DeliveryDeferred } from "../../models/node-command-delivery.js";
import { NODE_COMMAND_TIMEOUTS, sendNodeCommand } from "../../node-transport/commands.js";
import type { NodeHubOptions } from "../../runtimes/node-hub.js";

const scratch = { model: null, thinkingLevel: null, task: null };
const provisionOf = (sessionId: string) => ({ op: "session.provision" as const, sessionId, sourceId: sessionBinding("s").binding.sourceId, configuration: scratch });

const repo = useTestRepo();
/** Queues input that is not yet admitted (so it has a command ID). */
const enqueueInput = (...args: Parameters<typeof enqueue>): string => enqueue(...args)!;
const placement = (sessionId: string) => {
  const row = getSession(sessionId);
  return row && { status: row.placement_status, error: row.status_error };
};

test("normal session creation dispatches through the durable outbox", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  runMigrations(db);
  const nodeDb = openNodeDb(":memory:");
  setTestNodeDb(nodeDb);
  const project = createProject("outbox integration", repo.dir);
  const state = createServerState(undefined, { loopbackNode: true });
  try {
    const created = createNewSession(state, project.id, { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    expect(placement(created.id)).toEqual({ status: "provisioning", error: null });
    const row = db.query<{ id: string }, []>("SELECT id FROM node_command_outbox").get();
    expect(row?.id).toBe(created.provisionCommandId);
    expect(getCommand(row!.id)?.state).toBe("queued");
    expect(getNodeCommand(row!.id)).toMatchObject({ sessionId: created.id, command: { op: "session.provision",
      configuration: { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } } } });
    await drainCommands(state);
    // The outbox is a queue: the admitted provision is deleted as it settles the session's placement.
    expect(db.query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect(placement(created.id)).toEqual({ status: "provisioned", error: null });
    expect(nodeSessionBinding(nodeDb, created.id)).toEqual(sessionBinding(created.id).binding);
  } finally { await stopLoopbackNode(state); closeTestNodeDb(); setDb(new Database(":memory:")); db.close(); }
});

const nodeOwned = (hub?: NodeHubOptions) => {
  const { db, project, source } = setup();
  const nodeDb = openNodeDb(":memory:");
  setTestNodeDb(nodeDb);
  createSessionWithProvision("p", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, () =>
    createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioning" }));
  const state = createServerState(undefined, { loopbackNode: true, hub });
  return { db, nodeDb, state, dispose: async () => { await stopLoopbackNode(state); closeTestNodeDb(); setDb(new Database(":memory:")); db.close(); } };
};

test("node-owned provision crosses the JSON-RPC wire and replays idempotently by its binding", async () => {
  const { db, nodeDb, state, dispose } = nodeOwned();
  try {
    const { binding } = sessionBinding("s");
    const link = await directLink(state, loopbackNodeFor(state));
    const send = (command: NodeCommand, sent = binding) => sendNodeCommand(link, command, sent, NODE_COMMAND_TIMEOUTS);
    // Admitted on the node but the server never recorded it: the replay finds the equal binding.
    await send(provisionOf("s"));
    const stored = nodeDb.query("SELECT * FROM sessions").all();
    await drainCommands(state);
    expect(getNodeCommand("p")).toBeNull();
    expect(nodeSessionBinding(nodeDb, "s")).toEqual(binding);
    expect(nodeDb.query("SELECT * FROM sessions").all()).toEqual(stored);
    expect(db.query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect(placement("s")).toEqual({ status: "provisioned", error: null });
    // A thrown node error crosses the wire as a non-retryable `internal` NodeResult.
    expect(await send(provisionOf("s"), { ...binding, cwd: "/elsewhere" }))
      .toEqual({ ok: false, error: { code: "internal", message: expect.stringContaining("mismatch"), retryable: false } });
    // In-process values that do not survive JSON fail at the wire schema instead of leaking through.
    const leaky = { ...binding };
    Object.defineProperty(leaky, "cwd", { value: () => binding.cwd, enumerable: true });
    await expect(send(provisionOf("s"), leaky))
      .rejects.toMatchObject({ code: -32602 });
  } finally { await dispose(); }
});

test("a node's explicit provision rejection keeps its NodeResult error code", async () => {
  const { db, state, dispose } = nodeOwned();
  try {
    // Failed rows are deleted after notification; capture the settled result as it is written.
    db.exec(`CREATE TABLE settled (result_json TEXT);
      CREATE TRIGGER capture AFTER UPDATE OF state ON node_command_outbox WHEN NEW.state = 'failed'
      BEGIN INSERT INTO settled VALUES (NEW.result_json); END;`);
    const error = { code: "invalid_request" as const, message: "bad binding", retryable: false };
    spyOn(loopbackNodeFor(state), "provision").mockRejectedValue(new NodeRejection(error.code, error.message));
    await drainCommands(state);
    expect(getNodeCommand("p")).toBeNull();
    const settled = db.query<{ result_json: string }, []>("SELECT result_json FROM settled").all();
    expect(settled.map(row => JSON.parse(row.result_json))).toEqual([{ ok: false, error }]);
    expect(placement("s")).toEqual({ status: "provision_failed", error: "bad binding" });
    await expect(waitUntilProvisioned(state.nodes, "s")).rejects.toThrow("Session provisioning failed: bad binding");
  } finally { await dispose(); }
});

test("a timed-out provision has an unknown outcome and requeues", async () => {
  const { state, dispose } = nodeOwned({ timeouts: { ...NODE_COMMAND_TIMEOUTS, provision: 5 } });
  try {
    spyOn(loopbackNodeFor(state), "provision").mockReturnValue(new Promise(() => {}));
    await loopbackLink(state).ready();
    await expect(state.nodes.send(provisionOf("s"))).rejects.toBeInstanceOf(DeliveryDeferred);
  } finally { await dispose(); }
});

test("work for a node that is not connected stays queued and is not sent; a connection closed mid-delivery requeues it", async () => {
  const { nodeDb, state, dispose } = nodeOwned();
  try {
    let sent!: () => void;
    const sending = new Promise<void>(resolve => { sent = resolve; });
    const hang = spyOn(loopbackNodeFor(state), "provision").mockImplementation(() => { sent(); return new Promise(() => {}); });
    // The node's connection has not negotiated yet: nothing is sent, and an immediate send is deferred.
    const early = state.nodes.wake();
    const deferred = state.nodes.send(provisionOf("s"));
    expect(getCommand("p")?.state).toBe("queued");
    await early;
    await expect(deferred).rejects.toBeInstanceOf(DeliveryDeferred);

    // Once it negotiates, the queued provision is sent.
    await sending;
    expect(getCommand("p")?.state).toBe("dispatching");
    hang.mockRestore();
    loopbackLink(state).drop(); // the in-flight frame's outcome is unknown: requeued, then delivered after the redial
    for (let i = 0; i < 200 && getNodeCommand("p") !== null; i++) await Bun.sleep(5);
    expect(getNodeCommand("p")).toBeNull();
    expect(placement("s")?.status).toBe("provisioned");
    expect(nodeSessionBinding(nodeDb, "s")).toEqual(sessionBinding("s").binding);
  } finally { await dispose(); }
});

test("a wake that arrives while a delivery is in flight retries it once that delivery is deferred", async () => {
  const { state, dispose } = nodeOwned();
  try {
    let sent!: () => void;
    const sending = new Promise<void>(resolve => { sent = resolve; });
    const hang = spyOn(loopbackNodeFor(state), "provision").mockImplementation(() => { sent(); return new Promise(() => {}); });
    await loopbackLink(state).ready();
    void state.nodes.wake();
    await sending;
    hang.mockRestore();
    // A wake during the in-flight delivery (e.g. another link negotiated) is not lost to the busy chain.
    void state.nodes.wake();
    loopbackLink(state).drop(); // the in-flight provision's outcome is unknown (requeued); the node redials
    for (let i = 0; i < 200 && getNodeCommand("p") !== null; i++) await Bun.sleep(5);
    expect(getNodeCommand("p")).toBeNull();
  } finally { await dispose(); }
});

const setup = () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  runMigrations(db);
  const project = createProject("a", "/tmp/a");
  return { db, project, source: defaultSource(project.id)! };
};

test("creation on unavailable source persists queued without constructing runtime", async () => {
  const { db, project } = setup();
  try {
    db.query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    const remote = createSource(project.id, "remote", "/tmp/remote");
    const state = createServerState();
    useFakeNode(state);
    const created = createNewSession(state, project.id, { sourceId: remote.id });
    await drainCommands(state);
    expect(getCommand(created.provisionCommandId)?.state).toBe("queued");
    expect(new Sessions(state.nodes).get(created.id)?.placement).toEqual({ status: "provisioning", error: null, available: false, nodeId: "remote", nodeName: "Remote" });
    await expect(waitUntilProvisioned(state.nodes, created.id)).rejects.toThrow("Execution source unavailable; session provisioning queued");
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("dispatcher resolves the session's current source at delivery", async () => {
  const { db, project, source } = setup();
  try {
    createSessionWithProvision("x", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioning" }));
    const alternate = createSource(project.id, "internal", "/tmp/alternate");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(alternate.id);
    expect(getNodeCommand("x")).toMatchObject({ command: { sourceId: alternate.id } });
    expect(db.query("SELECT * FROM node_command_outbox WHERE id = 'x'").get()).not.toHaveProperty("source_id");
    const state = createServerState();
    const node = useFakeNode(state);
    await drainCommands(state);
    expect(getNodeCommand("x")).toBeNull();
    expect(node.sent).toEqual([expect.objectContaining({ op: "session.provision", sourceId: alternate.id })]);
    expect(placement("s")?.status).toBe("provisioned");
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("startup scan recovers a missed wake and unavailable work stays queued", async () => {
  const { db, project, source } = setup();
  try {
    createSessionWithProvision("x", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    db.query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    const alternate = createSource(project.id, "remote", "/tmp/remote");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(alternate.id);
    const state = createServerState();
    await useFakeNode(state).link.ready();
    const dispatcher = new NodeCommandDispatcher({ connected: nodeId => state.nodes.connected(nodeId), send: command => state.nodes.send(command), delivered: () => {} });
    await dispatcher.wake();
    expect(getCommand("x")?.state).toBe("queued");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(source.id);
    // A restarted dispatcher discovers the row even though nobody signalled it.
    dispatcher.start();
    await dispatcher.wait("x");
    expect(getCommand("x")?.state).not.toBe("queued");
    dispatcher.stop();
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("startup fails interrupted provisions, returns interrupted moves to their resting state, deletes interrupted and failed commands, and keeps queued work", async () => {
  const { db, project, source } = setup();
  try {
    const create = (id: string) => () => createSession(id, project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioning" });
    createSessionWithProvision("x", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: scratch }, create("s"));
    const input = enqueueInput("s", "prompt", [{ type: "text", text: "after" }], "after");
    const other = createSource(project.id, "internal", "/tmp/other-source");
    createSession("moved", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "moving" });
    createSession("moved-node", project.id, { agentRuntimeType: "pi", sourceId: other.id, placementStatus: "moving" });
    db.query(`INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES ('m', 'moved', ?, 'dispatching'), ('f', 'moved', '{"op":"session.setModel","provider":"a","modelId":"b"}', 'failed'), ('n', 'moved-node', ?, 'dispatching')`)
      .run(JSON.stringify({ op: "session.hydrate", targetSourceId: source.id, revertTo: { status: "server", sourceId: source.id } }),
        JSON.stringify({ op: "session.hydrate", targetSourceId: other.id, revertTo: { status: "provisioned", sourceId: source.id } }));
    db.query("UPDATE node_command_outbox SET state = 'dispatching' WHERE id = 'x'").run();
    expect(recoverInterruptedDispatches(db)).toBe(3);
    expect(db.query("SELECT id, state FROM node_command_outbox").all()).toEqual([{ id: input, state: "queued" }]);
    expect(placement("s")).toEqual({ status: "provision_failed", error: "Provisioning was interrupted by a server restart" });
    // An interrupted move returns the session to where it rested: at rest on the server, or provisioned
    // on the source it left, with the reason.
    expect(placement("moved")).toEqual({ status: "server", error: "Move was interrupted by a server restart" });
    expect(placement("moved-node")).toEqual({ status: "provisioned", error: "Move was interrupted by a server restart" });
    expect(getSession("moved-node")?.source_id).toBe(source.id);
    const state = createServerState();
    expect(new Sessions(state.nodes).get("s")?.placement).toMatchObject({ status: "provision_failed" });
    await expect(waitUntilProvisioned(state.nodes, "s")).rejects.toThrow("Session provisioning failed: Provisioning was interrupted by a server restart");
    // A reverted move does not block commands: the next one hydrates the session.
    await waitUntilProvisioned(state.nodes, "moved");
    await waitUntilProvisioned(state.nodes, "moved-node");
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("a stored command that does not parse fails its delivery like any other failure and is never sent", async () => {
  const { db, project, source } = setup();
  try {
    createSession("queued", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioning" });
    db.query(`INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES ('invalid', 'queued', '{"op":"session.provision"}', 'queued')`).run();
    const state = createServerState();
    expect(() => getNodeCommand("invalid")).toThrow("Stored node command is invalid");
    const node = useFakeNode(state);
    await node.link.ready();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try { await expect(waitUntilProvisioned(state.nodes, "queued")).rejects.toThrow("Session provisioning failed: Stored node command is invalid"); }
    finally { errors.mockRestore(); }
    expect(node.sent).toEqual([]);
    expect(getCommand("invalid")).toBeNull();
    expect(new Sessions(state.nodes).get("queued")?.placement).toMatchObject({ status: "provision_failed", error: expect.stringContaining("Stored node command is invalid") });
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("a hydrate is stored with the resting state a failed move returns to, and cannot settle without it", async () => {
  const { db, project, source } = setup();
  try {
    createSession("moving", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "moving" });
    const failure: NodeResult = { ok: false, error: { code: "internal", message: "no", retryable: false } };
    const hydrate = JSON.stringify({ op: "session.hydrate", targetSourceId: source.id });
    expect(() => commitPlacement("moving", hydrate, failure)).toThrow();
    expect(() => commitPlacement("moving", hydrate, { ok: true, value: { kind: "hydrated" } })).toThrow();
    // Startup recovery requires it too: the interrupted move has nowhere to return to.
    db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES ('h', 'moving', ?, 'dispatching')").run(hydrate);
    expect(() => recoverInterruptedDispatches(db)).toThrow();
    expect(getCommand("h")?.state).toBe("dispatching");
    expect(placement("moving")).toEqual({ status: "moving", error: null });
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("scheduling rolls back creation and rejects duplicate submission IDs", () => {
  const { db, project, source } = setup();
  try {
    const command = { op: "session.provision" as const, sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } };
    expect(() => createSessionWithProvision("x", command, () => { createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }); throw new Error("fail"); })).toThrow("fail");
    expect(db.query("SELECT 1 FROM sessions WHERE id = 's'").get()).toBeNull();
    createSessionWithProvision("x", command, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    expect(() => createSessionWithProvision("x", command, () => createSession("s2", project.id, { agentRuntimeType: "pi", sourceId: source.id }))).toThrow();
  } finally { setDb(new Database(":memory:")); db.close(); }
});

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const resultFor = (command: NodeCommand, id: string): NodeResult =>
  command.op === "session.provision" ? { ok: true, value: { kind: "provisioned" } }
    : command.op === "session.setModel" ? { ok: true, value: { kind: "modelSet" } }
      : { ok: true, value: { kind: "admitted", inputId: id } };

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
      new NodeCommandDispatcher({ connected: () => true, send: command => target.send(command), delivered: () => {} }, { maxConcurrentSessions });
    return { target, sent, sentFor, hold, plans, stats, dispatcher };
  };

  const withSessions = (ids: string[], run: (ctx: { script: ReturnType<typeof scriptedTarget> }) => Promise<void>) => async () => {
    const { db, project, source } = setup();
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const id of ids) createSessionWithProvision(`${id}-provision`, { op: "session.provision", sessionId: id, sourceId: source.id, configuration: scratch }, () =>
        createSession(id, project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioning" }));
      await run({ script: scriptedTarget() });
    } finally { warnings.mockRestore(); setDb(new Database(":memory:")); db.close(); }
  };
  const text = [{ type: "text" as const, text: "hi" }];

  test("a stalled session does not delay another session's delivery", withSessions(["a", "b"], async ({ script }) => {
    const stalled = script.hold("a-provision");
    const prompt = enqueueInput("b", "prompt", text, "b-p");
    const dispatcher = script.dispatcher();
    dispatcher.wake();
    await dispatcher.wait(prompt);
    expect(getNodeCommand("b-provision")).toBeNull();
    expect(getNodeCommand(prompt)).toBeNull();
    expect(getCommand("a-provision")?.state).toBe("dispatching");
    stalled.release();
    await dispatcher.wake();
    expect(getNodeCommand("a-provision")).toBeNull();
  }));

  test("each session delivers in outbox order, one command at a time, across overlapping wakes and dispatchers", withSessions(["a", "b"], async ({ script }) => {
    const a = ["a-provision", enqueueInput("a", "prompt", text, "a-p"), enqueueSetModel("a", { provider: "anthropic", modelId: "m" }), enqueueInput("a", "steer", text, "a-s")];
    const b = ["b-provision", enqueueInput("b", "prompt", text, "b-p")];
    const holds = [...a, ...b].map(id => script.hold(id));
    script.plans.set(b[1]!, "fail");
    // The claim itself refuses a command behind undelivered work in its session.
    expect(claimCommand(a[1]!)).toBe(false);
    const dispatcher = script.dispatcher();
    // A handler reload briefly runs a second dispatcher against the same outbox.
    const reloaded = script.dispatcher();
    const failed = reloaded.wait(b[1]!);
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
    // The failed input is removed after delivery, and a waiter on the other dispatcher resolves.
    await failed;
    expect(getNodeCommand(b[1]!)).toBeNull();
    expect(getDb().query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect([placement("a")?.status, placement("b")?.status]).toEqual(["provisioned", "provisioned"]);
  }));

  test("a deferred command waits for the next wake instead of spinning, without blocking other sessions", withSessions(["a", "b"], async ({ script }) => {
    script.plans.set("a-provision", "defer");
    const held = script.hold("b-provision");
    const dispatcher = script.dispatcher();
    dispatcher.wake();
    await until(() => script.sentFor("a").length === 1 && getCommand("a-provision")?.state === "queued");
    enqueueInput("a", "prompt", text, "a-p");
    held.release();
    await dispatcher.wake(); // drain is a wake: the deferred provision is retried exactly once
    expect(script.sentFor("a")).toEqual(["a-provision", "a-provision"]);
    await Bun.sleep(20);
    expect(script.sentFor("a")).toEqual(["a-provision", "a-provision"]);
    expect(getNodeCommand("b-provision")).toBeNull();
    script.plans.delete("a-provision");
    await dispatcher.wake();
    expect(script.sentFor("a")).toEqual(["a-provision", "a-provision", "a-provision", expect.any(String)]);
  }));

  test("concurrent sessions are capped", withSessions(["a", "b", "c", "d"], async ({ script }) => {
    const holds = ["a", "b", "c", "d"].map(id => script.hold(`${id}-provision`));
    const dispatcher = script.dispatcher(2);
    const drained = dispatcher.wake();
    await Bun.sleep(5);
    expect(script.sent.map(([, id]) => id)).toEqual(["a-provision", "b-provision"]);
    holds[1]!.release();
    await until(() => script.sent.length === 3);
    expect(script.sent[2]![1]).toBe("c-provision");
    for (const hold of holds) hold.release();
    await drained;
    expect(script.stats.peak).toBe(2);
    for (const id of ["a", "b", "c", "d"]) expect(getNodeCommand(`${id}-provision`)).toBeNull();
  }));

  test("a stopped dispatcher finishes in-flight delivery but starts no new delivery", withSessions(["a", "b"], async ({ script }) => {
    const held = script.hold("a-provision");
    script.hold("b-provision").release();
    const prompt = enqueueInput("a", "prompt", text, "a-p");
    const dispatcher = script.dispatcher(1);
    dispatcher.start();
    await until(() => script.sent.length === 1);
    dispatcher.stop();
    held.release();
    await dispatcher.wake();
    dispatcher.wake();
    await Bun.sleep(10);
    expect(getNodeCommand("a-provision")).toBeNull();
    expect(getCommand(prompt)?.state).toBe("queued");
    expect(getCommand("b-provision")?.state).toBe("queued");
    await script.dispatcher().wake();
    expect(getNodeCommand(prompt)).toBeNull();
  }));
});
