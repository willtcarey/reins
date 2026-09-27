import { describe, test, expect, spyOn } from "bun:test";
import type { NodeCommand, NodeResult } from "@reins/node/contract";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../migrations.js";
import { setDb } from "../../db.js";
import { setNodeDb, closeNodeDb, initializeNodeStorage, nodeAdmissionReceipt, nodeSessionBinding } from "@reins/node/storage";
import { createProject } from "../../project-store.js";
import { internalSource, createSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { claimCommand, enqueueInput, enqueueSetModel } from "../../node-command-store.js";
import { registerExecutionTargets, type SessionExecutionTarget } from "../../runtimes/execution-target.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { createServerState } from "../helpers/server-state.js";
import { Sessions } from "../../models/sessions.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { scheduleWork, getWork } from "../../models/node-command-projection.js";
import { blockInterruptedDispatches, NodeCommandDispatcher, waitForAdmission } from "../../models/node-command-dispatcher.js";
import { internalNodeFor, provisionForSession, sendInternal, stopInternalNode } from "../../runtimes/internal-node.js";
import { DeliveryDeferred } from "../../models/node-command-transport.js";
import { NODE_COMMAND_TIMEOUTS } from "../../node-transport/commands.js";

const scratch = { model: null, thinkingLevel: null, task: null };
const provisionOf = (sessionId: string) => ({ op: "session.provision" as const, sessionId, sourceId: provisionForSession("s").binding.sourceId, configuration: scratch });

const repo = useTestRepo();

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
    expect(created.scheduling.state).toBe("queued");
    expect(state.sessions.has(created.id)).toBe(false);
    const row = db.query<{ id: string }, []>("SELECT id FROM node_command_outbox").get();
    expect(row).not.toBeNull();
    expect(getWork(row!.id)).toMatchObject({ sessionId: created.id });
    const dispatcher = new NodeCommandDispatcher(state);
    await dispatcher.drain();
    expect(getWork(row!.id)?.state).toBe("admitted");
    expect(getWork(row!.id)?.command?.op).toBe("session.provision");
    // The node rebuilds the wire command in the stored command's shape: its receipt is the same bytes.
    expect(nodeAdmissionReceipt(nodeDb, row!.id)).toEqual({ sessionId: created.id, operation: "session.provision", payload: JSON.stringify(getWork(row!.id)!.command) });
    expect(getWork(row!.id)?.command).toMatchObject({ configuration: { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } } });
    expect(state.sessions.has(created.id)).toBe(false);
  } finally { closeNodeDb(); setDb(new Database(":memory:")); db.close(); }
});

const nodeOwned = () => {
  const { db, project, source } = setup();
  const nodeDb = new Database(":memory:");
  initializeNodeStorage(nodeDb);
  setNodeDb(nodeDb);
  scheduleWork("p", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, () =>
    createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" }));
  const state = createServerState();
  return { db, nodeDb, state, dispose: () => { stopInternalNode(state); closeNodeDb(); setDb(new Database(":memory:")); db.close(); } };
};

test("node-owned provision crosses the JSON-RPC wire and replays idempotently by command ID", async () => {
  const { db, nodeDb, state, dispose } = nodeOwned();
  try {
    const { binding } = provisionForSession("s");
    // Admitted on the node but the server never recorded it: replay must reuse the receipt.
    await sendInternal(state, provisionOf("s"), binding, "p");
    const receipt = nodeAdmissionReceipt(nodeDb, "p");
    await new NodeCommandDispatcher(state).drain();
    expect(getWork("p")?.state).toBe("admitted");
    expect(nodeSessionBinding(nodeDb, "s")).toEqual(binding);
    expect(nodeAdmissionReceipt(nodeDb, "p")).toEqual(receipt!);
    expect(db.query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 1 });
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
    expect(nodeAdmissionReceipt(nodeDb, "p")).toBeNull();

    await sendInternal(state, provisionOf("other"), provisionForSession("s").binding, "warm").catch(() => undefined);
    const negotiated = dispatcher.drain();
    stopInternalNode(state); // negotiated, but the provision frame cannot be sent: outcome unknown
    await negotiated;
    expect(getWork("p")?.state).toBe("queued");

    await dispatcher.drain();
    expect(getWork("p")?.state).toBe("admitted");
    expect(nodeAdmissionReceipt(nodeDb, "p")).toMatchObject({ sessionId: "s", operation: "session.provision" });
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
    expect(created.scheduling.state).toBe("queued");
    const dispatcher = new NodeCommandDispatcher(state);
    await dispatcher.drain();
    expect(getWork(created.scheduling.id)?.state).toBe("queued");
    expect(state.sessions.has(created.id)).toBe(false);
    expect(new Sessions(state.sessions).get(created.id)?.scheduling).toMatchObject({ state: "queued", available: false });
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("production dispatcher resolves reassignment and settles explicit rejection once", async () => {
  const { db, project, source } = setup();
  try {
    scheduleWork("x", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    const alternate = createSource(project.id, "internal", "/tmp/alternate");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(alternate.id);
    const dispatcher = new NodeCommandDispatcher(createServerState());
    await dispatcher.drain();
    expect(getWork("x")).toMatchObject({ state: "admitted", command: { sourceId: alternate.id } });
    expect(db.query("SELECT * FROM node_command_outbox WHERE id = 'x'").get()).not.toHaveProperty("source_id");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(source.id);
    await dispatcher.drain();
    expect(getWork("x")?.state).toBe("admitted");
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

test("existing startup handling retains interrupted dispatch outcome", () => {
  const { db, project, source } = setup();
  try {
    scheduleWork("x", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    db.query("UPDATE node_command_outbox SET state = 'dispatching' WHERE id = 'x'").run();
    blockInterruptedDispatches();
    expect(getWork("x")?.state).toBe("unknown");
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("a removed failed provision never looks like a successful node open", async () => {
  const { db, project, source } = setup();
  try {
    scheduleWork("failed-open", { op: "session.provision", sessionId: "s", sourceId: source.id, configuration: { model: null, thinkingLevel: null, task: null } }, () =>
      createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" }));
    db.query("DELETE FROM node_command_outbox WHERE id = 'failed-open'").run();
    const state = createServerState();
    expect(new Sessions(state.sessions).get("s")?.scheduling).toMatchObject({ state: "failed" });
    await expect(waitForAdmission(state, "s")).rejects.toThrow("Session open failed");
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("a stored command that no longer parses reads as failed and is never delivered", async () => {
  const { db, project, source } = setup();
  try {
    createSession("admitted", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" });
    createSession("queued", project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" });
    // Provisions stored before the command carried its configuration.
    db.query(`INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES
      ('old-admitted', 'admitted', '{"op":"session.provision"}', 'admitted'), ('old-queued', 'queued', '{"op":"session.provision"}', 'queued')`).run();
    const state = createServerState();
    const sessions = new Sessions(state.sessions);
    expect(sessions.get("admitted")?.scheduling).toMatchObject({ state: "failed", error: "Stored node command is invalid" });
    await expect(waitForAdmission(state, "admitted")).rejects.toThrow("Session open failed: Stored node command is invalid");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try { await new NodeCommandDispatcher(state).drain(); } finally { errors.mockRestore(); }
    expect(getWork("old-queued")).toBeNull();
    expect(sessions.get("queued")?.scheduling).toMatchObject({ state: "failed", error: "Session open failed" });
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
        createSession(id, project.id, { agentRuntimeType: "pi", sourceId: source.id, storageOwner: "internal-node" }));
      const state = createServerState();
      const script = scriptedTarget();
      registerExecutionTargets(state, { "internal-node": script.target, server: script.target });
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
    expect(getWork("b-provision")?.state).toBe("admitted");
    expect(getWork(prompt)?.state).toBe("admitted");
    expect(getWork("a-provision")?.state).toBe("dispatching");
    stalled.release();
    await dispatcher.drain();
    expect(getWork("a-provision")?.state).toBe("admitted");
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
    for (const id of a) expect(getWork(id)?.state).toBe("admitted");
    // The failed input is removed after delivery, and a waiter on the other dispatcher resolves.
    await failed;
    expect(getWork(b[1]!)).toBeNull();
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
    expect(getWork("b-provision")?.state).toBe("admitted");
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
    for (const id of ["a", "b", "c", "d"]) expect(getWork(`${id}-provision`)?.state).toBe("admitted");
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
    expect(getWork("a-provision")?.state).toBe("admitted");
    expect(getWork(prompt)?.state).toBe("queued");
    expect(getWork("b-provision")?.state).toBe("queued");
    await new NodeCommandDispatcher(state).drain();
    expect(getWork(prompt)?.state).toBe("admitted");
  }));
});
