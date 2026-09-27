import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../migrations.js";
import { setDb } from "../db.js";
import { createProject } from "../project-store.js";
import { createSession } from "./session-fixture.js";
import { getSource, createSource } from "../node-store.js";
import { executeSessionCommand } from "../runtimes/node-execution.js";

test("sessions bind to a source of their project and local paths follow project updates", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  runMigrations(db);
  try {
    const a = createProject("a", "/tmp/a");
    const b = createProject("b", "/tmp/b");
    const source = getSource(createSession("one", a.id, { agentRuntimeType: "pi" }).source_id);
    expect(source).toMatchObject({ project_id: a.id, node_id: "internal", path: "/tmp/a" });
    const other = createSource(b.id, "internal", "/tmp/b2");
    expect(() => createSession("bad", a.id, { agentRuntimeType: "pi", sourceId: other.id })).toThrow();
    db.exec(`UPDATE projects SET path = '/tmp/new-a' WHERE id = ${a.id}`);
    expect(getSource(source!.id)?.path).toBe("/tmp/new-a");
    expect(() => db.exec(`UPDATE sessions SET project_id = ${b.id} WHERE id = 'one'`)).toThrow();
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("execution refuses a source not on the internal node", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  runMigrations(db);
  try {
    const project = createProject("a", "/tmp/a");
    db.exec("INSERT INTO nodes VALUES ('remote', 'Remote')");
    const source = createSource(project.id, "remote", "/remote/a");
    createSession("remote-session", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    await expect(executeSessionCommand({ clients: new Set(), frontendDir: "" }, "remote-session", "abort"))
      .rejects.toThrow("Execution source unavailable");
  } finally { setDb(new Database(":memory:")); db.close(); }
});
