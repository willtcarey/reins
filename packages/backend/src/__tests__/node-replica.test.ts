import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../migrations.js";
import { resetDb, setDb } from "../db.js";
import { getSession } from "../session-store.js";
import { nodeSessionReports } from "../runtimes/node-session-events.js";
import { createServerState } from "./helpers/server-state.js";
import { createProject } from "../project-store.js";
import { createSession } from "./session-fixture.js";
import { latestNodeSettlement } from "../node-replica.js";

/** A file-backed server database, so a test can restart the server: a fresh connection with no memory. */
function serverDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "reins-server-restart-"));
  const path = join(dir, "reins.db");
  const open = () => {
    const db = new Database(path);
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setDb(db);
    return db;
  };
  let db = open();
  return {
    get db() { return db; },
    restart() { resetDb(); db.close(); db = open(); return db; },
    dispose() { resetDb(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("a repeated lifecycle report applies nothing, even after a server restart; a resumed run settles again, with or without a new start", () => {
  const server = serverDatabase();
  let state = createServerState();
  try {
    const project = createProject("Lifecycle restart", "/tmp/lifecycle-restart");
    createSession("parent", project.id, { agentRuntimeType: "pi" });
    createSession("child", project.id, { agentRuntimeType: "pi", parentSessionId: "parent" });
    const steers = () => server.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM node_command_outbox WHERE session_id = 'parent' AND json_extract(command_json, '$.op') = 'session.steer'").get()!.n;
    const settled = { sessionId: "child", runId: "r1", status: "completed" as const, metadata: { model: null, thinkingLevel: null },
      reply: { text: "Done", stopReason: "stop", errorMessage: null } };
    nodeSessionReports(state).started({ sessionId: "child", runId: "r1" });
    expect(getSession("child")?.activity_state).toBe("running");
    // Pi re-emits `started` for a run in progress (in-run compaction): already applied.
    nodeSessionReports(state).started({ sessionId: "child", runId: "r1" });
    nodeSessionReports(state).settled(settled);
    expect(steers()).toBe(1);
    expect(getSession("child")?.activity_state).toBeNull();
    expect(latestNodeSettlement(server.db, "child")).toEqual({ seq: 1, nextSeq: 1, status: "completed" });

    // The same settlement again, after a server restart: applied once.
    state.nodes.close();
    server.restart();
    state = createServerState();
    const updated = getSession("child")!.updated_at;
    nodeSessionReports(state).settled(settled);
    expect(steers()).toBe(1);
    expect(getSession("child")).toMatchObject({ activity_state: null, updated_at: updated });
    expect(latestNodeSettlement(server.db, "child")).toEqual({ seq: 1, nextSeq: 1, status: "completed" });
    // Pi resumes the settled run (after it was settled as interrupted): it runs and settles again.
    nodeSessionReports(state).started({ sessionId: "child", runId: "r1" });
    expect(getSession("child")?.activity_state).toBe("running");
    nodeSessionReports(state).settled({ ...settled, reply: { text: "Done again", stopReason: "stop", errorMessage: null } });
    expect(steers()).toBe(2);
    expect(latestNodeSettlement(server.db, "child")).toEqual({ seq: 2, nextSeq: 1, status: "completed" });
    // A resumed run may settle without reporting a new start.
    nodeSessionReports(state).settled({ ...settled, status: "failed", error: { message: "failed on resume" }, reply: null });
    expect(latestNodeSettlement(server.db, "child")).toMatchObject({ seq: 3, status: "failed" });
  } finally { state.nodes.close(); server.dispose(); }
});
