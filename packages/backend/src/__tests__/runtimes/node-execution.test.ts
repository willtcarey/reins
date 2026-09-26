import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { createSource } from "../../node-store.js";
import { createSession } from "../session-fixture.js";
import { executeSessionCommand } from "../../runtimes/node-execution.js";
import { selectCreationSource } from "../../runtimes/node-source.js";

test("creation policy permits queued remote placement but execution rejects unsupported sources", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  try {
    const project = createProject("a", "/tmp/a");
    expect(selectCreationSource(project.id).node_id).toBe("internal");
    db.exec("INSERT INTO nodes VALUES ('remote', 'Remote')");
    const remote = createSource(project.id, "remote", "/remote/a");
    expect(selectCreationSource(project.id, remote.id)).toEqual(remote);
    createSession("remote", project.id, { agentRuntimeType: "pi", sourceId: remote.id });
    await expect(executeSessionCommand({ sessions: new Map(), clients: new Set(), frontendDir: "" }, "remote", "steer", [{type:"text",text:"hi"}], "c"))
      .rejects.toThrow("Execution source unavailable");
  } finally { setDb(new Database(":memory:")); db.close(); }
});
