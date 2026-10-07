import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../project-fixture.js";
import { defaultSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { enqueueInput, getNodeCommand, pendingInputs } from "../../nodes/node-command-store.js";

const text = (value: string) => [{ type: "text" as const, text: value }];

function withDb(run: (db: Database) => void) {
  return () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
    try {
      const project = createProject("outbox", "/tmp/outbox");
      for (const id of ["s", "other"]) createSession(id, project.id, { agentRuntimeType: "pi", sourceId: defaultSource(project.id)!.id });
      run(db);
    } finally { setDb(new Database(":memory:")); db.close(); }
  };
}

test("a replay of queued input is the same input; different input under its client ID is refused; client IDs are per session", withDb(db => {
  const id = enqueueInput("s", "prompt", text("one"), "one")!;
  expect(enqueueInput("s", "prompt", text("one"), "one")).toBe(id);
  expect(() => enqueueInput("s", "steer", text("other"), "one")).toThrow("clientId already used for different input");
  const other = enqueueInput("other", "prompt", text("one"), "one");
  expect(other).not.toBe(id);
  expect(pendingInputs("s")).toEqual([{ id, clientId: "one" }]);
  expect(getNodeCommand(id)).toEqual({ id, sessionId: "s", command: { op: "session.prompt", sessionId: "s", clientId: "one", content: text("one"), sourceSessionId: null } });
  // The database enforces it too: the key lives in the command JSON, not in a column of its own.
  expect(db.query<{ name: string }, []>("PRAGMA table_info(node_command_outbox)").all().map(row => row.name)).not.toContain("client_id");
  expect(() => db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES ('duplicate', 's', ?, 'queued')")
    .run(JSON.stringify({ op: "session.prompt", clientId: "one", content: [] }))).toThrow();
}));

test("a stored command that does not parse as a node command is invalid when read", withDb(db => {
  const insert = (id: string, command: object) => db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, 's', ?, 'queued')").run(id, JSON.stringify(command));
  insert("invalid-input", { op: "session.steer", clientId: "bad", content: text("hello"), sourceSessionId: 42 });
  insert("retired-op", { op: "session.provision", mode: "reopen" });
  insert("missing-content", { op: "session.prompt", clientId: "missing" });
  for (const id of ["invalid-input", "retired-op", "missing-content"]) expect(() => getNodeCommand(id)).toThrow("Stored node command is invalid");
}));
