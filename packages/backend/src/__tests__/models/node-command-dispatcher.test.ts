import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../migrations.js";
import { setDb } from "../../db.js";
import { setNodeDb, closeNodeDb, initializeNodeStorage, nodeAdmissionReceipt } from "@reins/node/storage";
import { createProject } from "../../project-store.js";
import { internalSource, createSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { createServerState } from "../helpers/server-state.js";
import { Sessions } from "../../models/sessions.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { scheduleWork, getWork } from "../../models/node-command-projection.js";
import { blockInterruptedDispatches, NodeCommandDispatcher } from "../../models/node-command-dispatcher.js";

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
    expect(getWork(row!.id)?.command.op).toBe("session.provision");
    expect(nodeAdmissionReceipt(nodeDb, row!.id)).toMatchObject({ sessionId: created.id, operation: "session.provision" });
    expect(state.sessions.has(created.id)).toBe(false);
  } finally { closeNodeDb(); setDb(new Database(":memory:")); db.close(); }
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
    scheduleWork("x", { op: "session.provision", sessionId: "s", sourceId: source.id }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
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
    scheduleWork("x", { op: "session.provision", sessionId: "s", sourceId: source.id }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
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

test("interrupted dispatch remains blocked after restart reconciliation", () => {
  const { db, project, source } = setup();
  try {
    scheduleWork("x", { op: "session.provision", sessionId: "s", sourceId: source.id }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    db.query("UPDATE node_command_outbox SET state = 'dispatching' WHERE id = 'x'").run();
    blockInterruptedDispatches();
    expect(getWork("x")?.state).toBe("unknown");
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("scheduling rolls back creation and rejects duplicate submission IDs", () => {
  const { db, project, source } = setup();
  try {
    const command = { op: "session.provision" as const, sessionId: "s", sourceId: source.id };
    expect(() => scheduleWork("x", command, () => { createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }); throw new Error("fail"); })).toThrow("fail");
    expect(db.query("SELECT 1 FROM sessions WHERE id = 's'").get()).toBeNull();
    scheduleWork("x", command, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    expect(() => scheduleWork("x", command, () => createSession("s2", project.id, { agentRuntimeType: "pi", sourceId: source.id }))).toThrow();
  } finally { setDb(new Database(":memory:")); db.close(); }
});
