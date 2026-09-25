import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../migrations.js";
import { setDb } from "../../db.js";
import { createProject } from "../../project-store.js";
import { internalSource, createSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { createNewSession } from "../../runtimes/session-manager.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestRepo } from "../helpers/test-repo.js";
import { scheduleWork, dispatchWork, getWork, blockInterruptedDispatches, NodeCommandDispatcher } from "../../models/node-command-dispatcher.js";

const repo = useTestRepo();

test("normal session creation dispatches through the durable outbox", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  runMigrations(db);
  const project = createProject("outbox integration", repo.dir);
  try {
    const managed = await createNewSession(createServerState(), project.id, repo.dir, { model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } });
    const row = db.query<{ id: string }, []>("SELECT id FROM node_command_outbox").get();
    expect(row).not.toBeNull();
    expect(getWork(row!.id)).toMatchObject({ sessionId: managed.id, state: "admitted" });
    await managed.runtime.close();
  } finally { setDb(new Database(":memory:")); db.close(); }
});

const setup = () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  runMigrations(db);
  const project = createProject("a", "/tmp/a");
  return { db, project, source: internalSource(project.id) };
};

test("offline work follows session placement until actual dispatch", async () => {
  const { db, project, source } = setup();
  try {
    const command = { op: "session.open" as const, mode: "create" as const, sessionId: "s", sourceId: source.id };
    const work = scheduleWork("submission", command, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    expect(work).toMatchObject({ id: "submission", state: "queued", sourceId: source.id, command });
    expect(await dispatchWork("submission", async () => { throw new Error("offline"); }, false)).toMatchObject({ state: "queued" });
    expect(await dispatchWork("submission", async () => { throw new Error("lost ack"); })).toMatchObject({ state: "unknown" });
    expect(await dispatchWork("submission", async () => ({ ok: true, value: { kind: "opened", pendingOperation: false } }))).toMatchObject({ state: "unknown" });
    expect(getWork("submission")?.sourceId).toBe(source.id);
    expect(db.query("SELECT * FROM node_command_outbox WHERE id = 'submission'").get()).not.toHaveProperty("source_id");
    expect(db.query<{ session_id: string }, []>("SELECT session_id FROM node_command_outbox WHERE id = 'submission'").get()?.session_id).toBe("s");
    const alternate = createSource(project.id, "internal", "/tmp/alternate");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(alternate.id);
    expect(getWork("submission")?.command).toMatchObject({ sourceId: alternate.id });
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("dispatch reads current source after queued placement changes", async () => {
  const { db, project, source } = setup();
  try {
    scheduleWork("x", { op: "session.open", mode: "create", sessionId: "s", sourceId: source.id }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    const alternate = createSource(project.id, "internal", "/tmp/alternate");
    db.query("UPDATE sessions SET source_id = ? WHERE id = 's'").run(alternate.id);
    let sentSource: number | undefined;
    await dispatchWork("x", async (command) => { if (command.op === "session.open") sentSource = command.sourceId; return { ok: true, value: { kind: "opened", pendingOperation: false } }; });
    expect(sentSource).toBe(alternate.id);
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("startup scan recovers a missed wake and unavailable work stays queued", async () => {
  const { db, project, source } = setup();
  try {
    scheduleWork("x", { op: "session.open", mode: "create", sessionId: "s", sourceId: source.id }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
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
    scheduleWork("x", { op: "session.open", mode: "create", sessionId: "s", sourceId: source.id }, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    db.query("UPDATE node_command_outbox SET state = 'dispatching' WHERE id = 'x'").run();
    blockInterruptedDispatches();
    expect(getWork("x")?.state).toBe("unknown");
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("scheduling rolls back creation and rejects duplicate submission IDs", () => {
  const { db, project, source } = setup();
  try {
    const command = { op: "session.open" as const, mode: "create" as const, sessionId: "s", sourceId: source.id };
    expect(() => scheduleWork("x", command, () => { createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }); throw new Error("fail"); })).toThrow("fail");
    expect(db.query("SELECT 1 FROM sessions WHERE id = 's'").get()).toBeNull();
    scheduleWork("x", command, () => createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id }));
    expect(() => scheduleWork("x", command, () => createSession("s2", project.id, { agentRuntimeType: "pi", sourceId: source.id }))).toThrow();
  } finally { setDb(new Database(":memory:")); db.close(); }
});
