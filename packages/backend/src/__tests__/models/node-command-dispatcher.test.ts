import { describe, test, expect, spyOn } from "bun:test";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../migrations.js";
import { getDb, setDb } from "../../db.js";
import { setNodeDb, closeNodeDb, initializeNodeStorage, nodeSessionBinding } from "@reins/node/storage";
import { createProject } from "../../project-store.js";
import { internalSource, createSource } from "../../node-store.js";
import { createSession, getSession } from "../../session-store.js";
import { claimCommand, enqueueInput as enqueue, enqueueSetModel, recoverInterruptedCommands } from "../../node-command-store.js";
import { registerExecutionTarget, type SessionExecutionTarget } from "../../runtimes/execution-target.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { createServerState } from "../helpers/server-state.js";
import { Sessions } from "../../models/sessions.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { scheduleWork, getWork } from "../../models/node-command-projection.js";
import { NodeCommandDispatcher, waitUntilProvisioned } from "../../models/node-command-dispatcher.js";
import { provisionForSession, sendInternal } from "../../runtimes/internal-node.js";
import { internalNodeFor, stopInternalNode } from "../helpers/loopback-node.js";
import { DeliveryDeferred } from "../../models/node-command-transport.js";
import { NODE_COMMAND_TIMEOUTS } from "../../node-transport/commands.js";

const scratch = { model: null, thinkingLevel: null, task: null };
const provisionOf = (sessionId: string) => ({ op: "session.provision" as const, sessionId, sourceId: provisionForSession("s").binding.sourceId, configuration: scratch });

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
  const nodeDb = new Database(":memory:");
  initializeNodeStorage(nodeDb);
  setNodeDb(nodeDb);
  const project = createProject("outbox integration", repo.dir);
  try {
    const state = createServerState();
    const created = createNewSession(state, project.id, repo.dir, { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    expect(placement(created.id)).toEqual({ status: "provisioning", error: null });
    const row = db.query<{ id: string }, []>("SELECT id FROM node_command_outbox").get();
    expect(row?.id).toBe(created.provisionCommandId);
    expect(getWork(row!.id)).toMatchObject({ sessionId: created.id, state: "queued", command: { op: "session.provision",
      configuration: { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } } } });
    const dispatcher = new NodeCommandDispatcher(state);
    await dispatcher.drain();
    // The outbox is a queue: the admitted provision is deleted as it settles the session's placement.
    expect(db.query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect(placement(created.id)).toEqual({ status: "provisioned", error: null });
    expect(nodeSessionBinding(nodeDb, created.id)).toEqual(provisionForSession(created.id).binding);
  } finally { closeNodeDb(); setDb(new Database(":memory:")); db.close(); }
});

const nodeOwned = () => {
  const { db, project, source } = setup();
  const nodeDb = new Database(":memory:");
  initializeNodeStorage(nodeDb);
  setNodeDb(nodeDb);
  scheduleWork("p", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, () =>
    createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioning" }));
  const state = createServerState();
  return { db, nodeDb, state, dispose: () => { stopInternalNode(state); closeNodeDb(); setDb(new Database(":memory:")); db.close(); } };
};

test("node-owned provision crosses the JSON-RPC wire and replays idempotently by its binding", async () => {
  const { db, nodeDb, state, dispose } = nodeOwned();
  try {
    const { binding } = provisionForSession("s");
    // Admitted on the node but the server never recorded it: the replay finds the equal binding.
    await sendInternal(state, provisionOf("s"), binding, "p");
    const stored = nodeDb.query("SELECT * FROM sessions").all();
    await new NodeCommandDispatcher(state).drain();
    expect(getWork("p")).toBeNull();
    expect(nodeSessionBinding(nodeDb, "s")).toEqual(binding);
    expect(nodeDb.query("SELECT * FROM sessions").all()).toEqual(stored);
    expect(db.query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect(placement("s")).toEqual({ status: "provisioned", error: null });
    // A thrown node error crosses the wire as a non-retryable `internal` NodeResult.
    expect(await sendInternal(state, provisionOf("s"), { ...binding, cwd: "/elsewhere" }, "p"))
      .toEqual({ ok: false, error: { code: "internal", message: expect.stringContaining("mismatch"), retryable: false } });
    // In-process values that do not survive JSON fail at the wire schema instead of leaking through.
    const leaky = { ...binding };
    Object.defineProperty(leaky, "cwd", { value: () => binding.cwd, enumerable: true });
    await expect(sendInternal(state, provisionOf("s"), leaky, "p"))
      .rejects.toMatchObject({ code: -32602 });
  } finally { dispose(); }
});

test("a node's explicit provision rejection keeps its NodeResult error code", async () => {
  const { db, state, dispose } = nodeOwned();
  try {
    // Failed rows are deleted after notification; capture the settled result as it is written.
    db.exec(`CREATE TABLE settled (result_json TEXT);
      CREATE TRIGGER capture AFTER UPDATE OF state ON node_command_outbox WHEN NEW.state = 'failed'
      BEGIN INSERT INTO settled VALUES (NEW.result_json); END;`);
    const error = { code: "invalid_request" as const, message: "bad binding", retryable: false };
    spyOn(internalNodeFor(state), "send").mockResolvedValue({ ok: false, error });
    await new NodeCommandDispatcher(state).drain();
    expect(getWork("p")).toBeNull();
    const settled = db.query<{ result_json: string }, []>("SELECT result_json FROM settled").all();
    expect(settled.map(row => JSON.parse(row.result_json))).toEqual([{ ok: false, error }]);
    expect(placement("s")).toEqual({ status: "provision_failed", error: "bad binding" });
    await expect(waitUntilProvisioned(state, "s")).rejects.toThrow("Session provisioning failed: bad binding");
  } finally { dispose(); }
});

test("a timed-out provision has an unknown outcome and requeues", async () => {
  const { state, dispose } = nodeOwned();
  try {
    spyOn(internalNodeFor(state), "send").mockReturnValue(new Promise(() => {}));
    const { binding } = provisionForSession("s");
    await expect(sendInternal(state, provisionOf("s"), binding, "p", { ...NODE_COMMAND_TIMEOUTS, provision: 5 })).rejects.toBeInstanceOf(DeliveryDeferred);
  } finally { dispose(); }
});

test("a closed or unnegotiated node connection requeues provision instead of failing it", async () => {
  const { nodeDb, state, dispose } = nodeOwned();
  try {
    const dispatcher = new NodeCommandDispatcher(state);
    const unnegotiated = dispatcher.drain();
    expect(getWork("p")?.state).toBe("dispatching");
    stopInternalNode(state); // hot-reload uninstall closes the loopback before hello completes
    await unnegotiated;
    expect(getWork("p")?.state).toBe("queued");
    expect(placement("s")?.status).toBe("provisioning");
    expect(nodeSessionBinding(nodeDb, "s")).toBeNull();

    await sendInternal(state, provisionOf("other"), provisionForSession("s").binding, "warm").catch(() => undefined);
    const negotiated = dispatcher.drain();
    stopInternalNode(state); // negotiated, but the provision frame cannot be sent: outcome unknown
    await negotiated;
    expect(getWork("p")?.state).toBe("queued");

    await dispatcher.drain();
    expect(getWork("p")).toBeNull();
    expect(nodeSessionBinding(nodeDb, "s")).toEqual(provisionForSession("s").binding);
  } finally { dispose(); }
});

test("a wake that arrives while a delivery is in flight retries it once that delivery is deferred", async () => {
  const { state, dispose } = nodeOwned();
  try {
    let sent!: () => void;
    const sending = new Promise<void>(resolve => { sent = resolve; });
    spyOn(internalNodeFor(state), "send").mockImplementation(() => { sent(); return new Promise(() => {}); });
    const dispatcher = new NodeCommandDispatcher(state);
    dispatcher.wake();
    await sending;
    stopInternalNode(state); // the link drops: the in-flight provision's outcome is unknown (requeued)
    dispatcher.wake(); // meanwhile a new link negotiated (the node redialed): not lost to the busy chain
    for (let i = 0; i < 200 && getWork("p") !== null; i++) await Bun.sleep(5);
    expect(getWork("p")).toBeNull();
    dispatcher.stop();
  } finally { dispose(); }
});

const setup = () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  runMigrations(db);
  const project = createProject("a", "/tmp/a");
  return { db, project, source: internalSource(project.id) };
};

test("creation on unavailable source persists queued without constructing runtime", async () => {
  const { db, project } = setup();
  try {
    db.query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    const remote = createSource(project.id, "remote", "/tmp/remote");
    const state = createServerState();
    const created = createNewSession(state, project.id, project.path, { sourceId: remote.id });
    const dispatcher = new NodeCommandDispatcher(state);
    await dispatcher.drain();
    expect(getWork(created.provisionCommandId)?.state).toBe("queued");
    expect(new Sessions().get(created.id)?.placement).toEqual({ status: "provisioning", error: null, available: false });
    await expect(waitUntilProvisioned(state, created.id)).rejects.toThrow("Execution source unavailable; session provisioning queued");
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("dispatcher resolves the session's current source at delivery", async () => {
  const { db, project, source } = setup();
  try {
    scheduleWork("x", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioning" }));
    const alternate = createSource(project.id, "internal", "/tmp/alternate");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(alternate.id);
    expect(getWork("x")).toMatchObject({ state: "queued", command: { sourceId: alternate.id } });
    expect(db.query("SELECT * FROM node_command_outbox WHERE id = 'x'").get()).not.toHaveProperty("source_id");
    const state = createServerState();
    const sent: NodeCommand[] = [];
    registerExecutionTarget(state, { send: async (command, id) => { sent.push(command); return resultFor(command, id!); } });
    const dispatcher = new NodeCommandDispatcher(state);
    await dispatcher.drain();
    expect(getWork("x")).toBeNull();
    expect(sent).toEqual([expect.objectContaining({ op: "session.provision", sourceId: alternate.id })]);
    expect(placement("s")?.status).toBe("provisioned");
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("startup scan recovers a missed wake and unavailable work stays queued", async () => {
  const { db, project, source } = setup();
  try {
    scheduleWork("x", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    db.query("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')").run();
    const alternate = createSource(project.id, "remote", "/tmp/remote");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(alternate.id);
    const dispatcher = new NodeCommandDispatcher(createServerState());
    await dispatcher.drain();
    expect(getWork("x")?.state).toBe("queued");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(source.id);
    // A restarted dispatcher discovers the row even though nobody signalled it.
    dispatcher.start();
    await dispatcher.wait("x");
    expect(getWork("x")?.state).not.toBe("queued");
    dispatcher.stop();
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("startup fails interrupted provisions, returns interrupted moves to their resting state, deletes interrupted and failed commands, and keeps queued work", async () => {
  const { db, project, source } = setup();
  try {
    const create = (id: string) => () => createSession(id, project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioning" });
    scheduleWork("x", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: scratch }, create("s"));
    const input = enqueueInput("s", "prompt", [{ type: "text", text: "after" }], "after");
    const other = createSource(project.id, "internal", "/tmp/other-source");
    createSession("moved", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "moving" });
    createSession("moved-node", project.id, { agentRuntimeType: "pi", sourceId: other.id, placementStatus: "moving" });
    db.query(`INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES ('m', 'moved', ?, 'dispatching'), ('f', 'moved', '{"op":"session.setModel","provider":"a","modelId":"b"}', 'failed'), ('n', 'moved-node', ?, 'dispatching')`)
      .run(JSON.stringify({ op: "session.hydrate", targetSourceId: source.id, revertTo: { status: "server", sourceId: source.id } }),
        JSON.stringify({ op: "session.hydrate", targetSourceId: other.id, revertTo: { status: "provisioned", sourceId: source.id } }));
    db.query("UPDATE node_command_outbox SET state = 'dispatching' WHERE id = 'x'").run();
    recoverInterruptedCommands();
    expect(db.query("SELECT id, state FROM node_command_outbox").all()).toEqual([{ id: input, state: "queued" }]);
    expect(placement("s")).toEqual({ status: "provision_failed", error: "Provisioning was interrupted by a server restart" });
    // An interrupted move returns the session to where it rested: at rest on the server, or provisioned
    // on the source it left, with the reason.
    expect(placement("moved")).toEqual({ status: "server", error: "Move was interrupted by a server restart" });
    expect(placement("moved-node")).toEqual({ status: "provisioned", error: "Move was interrupted by a server restart" });
    expect(getSession("moved-node")?.source_id).toBe(source.id);
    const state = createServerState();
    expect(new Sessions().get("s")?.placement).toMatchObject({ status: "provision_failed" });
    await expect(waitUntilProvisioned(state, "s")).rejects.toThrow("Session provisioning failed: Provisioning was interrupted by a server restart");
    // A reverted move does not block commands: the next one hydrates the session.
    await waitUntilProvisioned(state, "moved");
    await waitUntilProvisioned(state, "moved-node");
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("a queued command that no longer parses fails cleanly and is never delivered", async () => {
  const { db, project, source } = setup();
  try {
    createSession("queued", project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioning" });
    db.query(`INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES ('old-queued', 'queued', '{"op":"session.provision"}', 'queued')`).run();
    const state = createServerState();
    const sessions = new Sessions();
    expect(getWork("old-queued")).toMatchObject({ state: "failed", command: null, result: { ok: false, error: { message: "Stored node command is invalid" } } });
    const sent: string[] = [];
    const target: SessionExecutionTarget = { send: async (command, id) => { sent.push(id!); return resultFor(command, id!); } };
    registerExecutionTarget(state, target);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try { await expect(waitUntilProvisioned(state, "queued")).rejects.toThrow("Session provisioning failed: Stored node command is invalid"); }
    finally { errors.mockRestore(); }
    expect(sent).toEqual([]);
    expect(getWork("old-queued")).toBeNull();
    expect(sessions.get("queued")?.placement).toEqual({ status: "provision_failed", error: "Stored node command is invalid", available: true });
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("scheduling rolls back creation and rejects duplicate submission IDs", () => {
  const { db, project, source } = setup();
  try {
    const command = { op: "session.provision" as const, sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } };
    expect(() => scheduleWork("x", command, () => { createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }); throw new Error("fail"); })).toThrow("fail");
    expect(db.query("SELECT 1 FROM sessions WHERE id = 's'").get()).toBeNull();
    scheduleWork("x", command, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    expect(() => scheduleWork("x", command, () => createSession("s2", project.id, { agentRuntimeType: "pi", sourceId: source.id }))).toThrow();
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
  /** A target whose sends can be held, deferred or rejected by command ID; records per-session overlap. */
  const scriptedTarget = () => {
    const sent: Array<[string, string]> = [];
    const inFlight = new Map<string, number>();
    const holds = new Map<string, ReturnType<typeof gate>>();
    const plans = new Map<string, "defer" | "fail">();
    const stats = { overlap: false, active: 0, peak: 0 };
    const target: SessionExecutionTarget = {
      async send(command, id) {
        sent.push([command.sessionId, id!]);
        const count = (inFlight.get(command.sessionId) ?? 0) + 1;
        inFlight.set(command.sessionId, count);
        if (count > 1) stats.overlap = true;
        stats.peak = Math.max(stats.peak, ++stats.active);
        try {
          await holds.get(id!)?.promise;
          if (plans.get(id!) === "defer") throw new DeliveryDeferred("node offline");
          if (plans.get(id!) === "fail") return { ok: false, error: { code: "invalid_request", message: "rejected", retryable: false } };
          return resultFor(command, id!);
        } finally { inFlight.set(command.sessionId, inFlight.get(command.sessionId)! - 1); stats.active--; }
      },
    };
    const hold = (id: string) => { const held = gate(); holds.set(id, held); return held; };
    const sentFor = (sessionId: string) => sent.filter(([session]) => session === sessionId).map(([, id]) => id);
    return { target, sent, sentFor, hold, plans, stats };
  };

  const withSessions = (ids: string[], run: (ctx: { state: ReturnType<typeof createServerState>; script: ReturnType<typeof scriptedTarget> }) => Promise<void>) => async () => {
    const { db, project, source } = setup();
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const id of ids) scheduleWork(`${id}-provision`, { op: "session.provision", sessionId: id, sourceId: source.id, configuration: scratch }, () =>
        createSession(id, project.id, { agentRuntimeType: "pi", sourceId: source.id, placementStatus: "provisioning" }));
      const state = createServerState();
      const script = scriptedTarget();
      registerExecutionTarget(state, script.target);
      await run({ state, script });
    } finally { warnings.mockRestore(); setDb(new Database(":memory:")); db.close(); }
  };
  const text = [{ type: "text" as const, text: "hi" }];

  test("a stalled session does not delay another session's delivery", withSessions(["a", "b"], async ({ state, script }) => {
    const stalled = script.hold("a-provision");
    const prompt = enqueueInput("b", "prompt", text, "b-p");
    const dispatcher = new NodeCommandDispatcher(state);
    dispatcher.wake();
    await dispatcher.wait(prompt);
    expect(getWork("b-provision")).toBeNull();
    expect(getWork(prompt)).toBeNull();
    expect(getWork("a-provision")?.state).toBe("dispatching");
    stalled.release();
    await dispatcher.drain();
    expect(getWork("a-provision")).toBeNull();
  }));

  test("each session delivers in outbox order, one command at a time, across overlapping wakes and dispatchers", withSessions(["a", "b"], async ({ state, script }) => {
    const a = ["a-provision", enqueueInput("a", "prompt", text, "a-p"), enqueueSetModel("a", { provider: "anthropic", modelId: "m" }), enqueueInput("a", "steer", text, "a-s")];
    const b = ["b-provision", enqueueInput("b", "prompt", text, "b-p")];
    const holds = [...a, ...b].map(id => script.hold(id));
    script.plans.set(b[1]!, "fail");
    // The claim itself refuses a command behind undelivered work in its session.
    expect(claimCommand(a[1]!)).toBe(false);
    const dispatcher = new NodeCommandDispatcher(state);
    // A handler reload briefly runs a second dispatcher against the same outbox.
    const reloaded = new NodeCommandDispatcher(state);
    const failed = reloaded.wait(b[1]!);
    dispatcher.wake();
    for (const hold of holds) {
      dispatcher.wake();
      reloaded.wake();
      void reloaded.drain();
      await Bun.sleep(1);
      hold.release();
      await Bun.sleep(1);
    }
    await Promise.all([dispatcher.drain(), reloaded.drain()]);
    expect(script.stats.overlap).toBe(false);
    expect(script.sentFor("a")).toEqual(a);
    expect(script.sentFor("b")).toEqual(b);
    for (const id of a) expect(getWork(id)).toBeNull();
    // The failed input is removed after delivery, and a waiter on the other dispatcher resolves.
    await failed;
    expect(getWork(b[1]!)).toBeNull();
    expect(getDb().query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
    expect([placement("a")?.status, placement("b")?.status]).toEqual(["provisioned", "provisioned"]);
  }));

  test("a deferred command waits for the next wake instead of spinning, without blocking other sessions", withSessions(["a", "b"], async ({ state, script }) => {
    script.plans.set("a-provision", "defer");
    const held = script.hold("b-provision");
    const dispatcher = new NodeCommandDispatcher(state);
    dispatcher.wake();
    await until(() => script.sentFor("a").length === 1 && getWork("a-provision")?.state === "queued");
    enqueueInput("a", "prompt", text, "a-p");
    held.release();
    await dispatcher.drain(); // drain is a wake: the deferred provision is retried exactly once
    expect(script.sentFor("a")).toEqual(["a-provision", "a-provision"]);
    await Bun.sleep(20);
    expect(script.sentFor("a")).toEqual(["a-provision", "a-provision"]);
    expect(getWork("b-provision")).toBeNull();
    script.plans.delete("a-provision");
    await dispatcher.drain();
    expect(script.sentFor("a")).toEqual(["a-provision", "a-provision", "a-provision", expect.any(String)]);
  }));

  test("concurrent sessions are capped", withSessions(["a", "b", "c", "d"], async ({ state, script }) => {
    const holds = ["a", "b", "c", "d"].map(id => script.hold(`${id}-provision`));
    const dispatcher = new NodeCommandDispatcher(state, { maxConcurrentSessions: 2 });
    const drained = dispatcher.drain();
    await Bun.sleep(5);
    expect(script.sent.map(([, id]) => id)).toEqual(["a-provision", "b-provision"]);
    holds[1]!.release();
    await until(() => script.sent.length === 3);
    expect(script.sent[2]![1]).toBe("c-provision");
    for (const hold of holds) hold.release();
    await drained;
    expect(script.stats.peak).toBe(2);
    for (const id of ["a", "b", "c", "d"]) expect(getWork(`${id}-provision`)).toBeNull();
  }));

  test("a stopped dispatcher finishes in-flight delivery but starts no new delivery", withSessions(["a", "b"], async ({ state, script }) => {
    const held = script.hold("a-provision");
    script.hold("b-provision").release();
    const prompt = enqueueInput("a", "prompt", text, "a-p");
    const dispatcher = new NodeCommandDispatcher(state, { maxConcurrentSessions: 1 });
    dispatcher.start();
    await until(() => script.sent.length === 1);
    dispatcher.stop();
    held.release();
    await dispatcher.drain();
    dispatcher.wake();
    await Bun.sleep(10);
    expect(getWork("a-provision")).toBeNull();
    expect(getWork(prompt)?.state).toBe("queued");
    expect(getWork("b-provision")?.state).toBe("queued");
    await new NodeCommandDispatcher(state).drain();
    expect(getWork(prompt)).toBeNull();
  }));
});
