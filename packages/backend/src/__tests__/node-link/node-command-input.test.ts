import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../../project-store.js";
import { createSession } from "../../session-store.js";
import { defaultSource } from "../../node-store.js";
import { enqueueInput } from "../../node-link/node-command-store.js";
import { drainCommands } from "../helpers/loopback-node.js";
import { useFakeNode } from "../helpers/fake-node.js";
import { createServerState } from "../helpers/server-state.js";

test("malformed persisted input and reopen commands fail closed before Pi admission", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  try {
    const project = createProject("bad outbox", "/tmp/bad-outbox");
    const sourceId = defaultSource(project.id)!.id;
    createSession("bad-input", project.id, { agentRuntimeType: "pi", sourceId });
    createSession("bad-open", project.id, { agentRuntimeType: "pi", sourceId });
    createSession("legacy-open", project.id, { agentRuntimeType: "pi", sourceId });
    createSession("bad-prompt", project.id, { agentRuntimeType: "pi", sourceId });
    const state = createServerState();
    const node = useFakeNode(state);
    db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, ?, ?, 'queued')")
      .run("invalid-input", "bad-input", JSON.stringify({ op: "session.steer", clientId: "bad", content: [{ type: "text", text: "hello" }], sourceSessionId: 42 }));
    db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, ?, ?, 'queued')")
      .run("reopen", "bad-open", JSON.stringify({ op: "session.provision", mode: "reopen" }));
    db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, ?, ?, 'queued')")
      .run("legacy", "legacy-open", JSON.stringify({ op: "session.open", mode: "reopen" }));
    db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES (?, ?, ?, 'queued')")
      .run("missing-content", "bad-prompt", JSON.stringify({ op: "session.prompt", clientId: "missing" }));
    await drainCommands(state);
    expect(node.sent).toEqual([]);
    for (const id of ["invalid-input", "reopen", "legacy", "missing-content"]) {
      expect(db.query<{ state: string }, [string]>("SELECT state FROM node_command_outbox WHERE id = ?").get(id)).toBeNull();
    }
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("one outbox scan orders input, deduplicates clientId and removes failed commands", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  try {
    const project = createProject("inputs", "/tmp/inputs");
    const sourceId = defaultSource(project.id)!.id;
    createSession("s", project.id, { agentRuntimeType: "pi", sourceId });
    createSession("other", project.id, { agentRuntimeType: "pi", sourceId });
    const state = createServerState();
    const node = useFakeNode(state);
    const inputs = (sessionId: string, op: string) => node.sent.flatMap((command) => command.op === op && command.sessionId === sessionId && "content" in command ? [command.content] : []);
    const first = enqueueInput("s", "prompt", [{ type: "text", text: "one" }], "a");
    expect(enqueueInput("s", "prompt", [{ type: "text", text: "one" }], "a")).toBe(first);
    expect(db.query<{ name: string }, []>("PRAGMA table_info(node_command_outbox)").all().map(row => row.name)).not.toContain("client_id");
    expect(() => db.query("INSERT INTO node_command_outbox (id, session_id, command_json, state) VALUES ('duplicate', 's', ?, 'queued')")
      .run(JSON.stringify({ op: "session.prompt", clientId: "a", content: [] }))).toThrow();
    expect(() => enqueueInput("s", "steer", [{ type: "text", text: "different" }], "a")).toThrow();
    enqueueInput("s", "steer", [{ type: "text", text: "two" }], "b");
    await drainCommands(state);
    expect(inputs("s", "session.prompt")).toEqual([[{ type: "text", text: "one" }]]);
    expect(inputs("s", "session.steer")).toEqual([[{ type: "text", text: "two" }]]);
    node.rejectWhen(command => "content" in command && command.content.some(block => block.type === "text" && block.text === "three") ? "delivery failed" : null);
    const third = enqueueInput("s", "prompt", [{ type: "text", text: "three" }], "c");
    enqueueInput("s", "prompt", [{ type: "text", text: "four" }], "d");
    enqueueInput("other", "prompt", [{ type: "text", text: "independent" }], "e");
    await drainCommands(state);
    expect(inputs("s", "session.prompt")).toEqual([[{ type: "text", text: "one" }], [{ type: "text", text: "three" }], [{ type: "text", text: "four" }]]);
    expect(inputs("other", "session.prompt")).toEqual([[{ type: "text", text: "independent" }]]);
    expect(db.query("SELECT id FROM node_command_outbox WHERE id = ?").get(third)).toBeNull();
    // The outbox is a queue: admitted input is deleted as it settles.
    expect(db.query("SELECT id FROM node_command_outbox WHERE id = ?").get(first)).toBeNull();
    enqueueInput("other", "steer", [{ type: "text", text: "still works" }], "f");
    await drainCommands(state);
    expect(inputs("other", "session.steer")).toEqual([[{ type: "text", text: "still works" }]]);
    expect(db.query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { setDb(new Database(":memory:")); db.close(); }
});
