import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../migrations.js";
import { setDb } from "../../db.js";
import { createProject } from "../project-fixture.js";
import { defaultSource } from "../../node-store.js";
import { createSession } from "../../session-store.js";
import { enqueueInput as enqueue, insertCommand } from "../../nodes/node-command-store.js";
import { recoverInterruptedDispatches } from "../../nodes/node-command-recovery.js";
import { createServerState } from "../helpers/server-state.js";
import { drainCommands } from "../helpers/loopback-node.js";
import { useFakeNode } from "../helpers/fake-node.js";

/** Queues input that is not yet admitted (so it has a command ID). */
const enqueueInput = (...args: Parameters<typeof enqueue>): string => enqueue(...args)!;
const text = [{ type: "text" as const, text: "hi" }];

const setup = () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  setDb(db);
  runMigrations(db);
  const project = createProject("a", "/tmp/a");
  return { db, project, source: defaultSource(project.id)! };
};
const closeDb = (db: Database) => { setDb(new Database(":memory:")); db.close(); };

test("startup requeues interrupted commands in place and deletes failed ones; the interrupted prompt is then delivered once", async () => {
  const { db, project, source } = setup();
  try {
    createSession("s", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    createSession("other", project.id, { agentRuntimeType: "pi", sourceId: source.id });
    const interrupted = enqueueInput("s", "prompt", text, "interrupted");
    const behind = enqueueInput("s", "prompt", text, "behind");
    insertCommand("lost-failure", "other", JSON.stringify({ op: "session.setModel", provider: "a", modelId: "b" }));
    // The server stopped while the prompt was being delivered; a failure's notification was lost.
    db.query("UPDATE node_command_outbox SET state = 'dispatching' WHERE id = ?").run(interrupted);
    db.query("UPDATE node_command_outbox SET state = 'failed' WHERE id = 'lost-failure'").run();

    expect(recoverInterruptedDispatches(db)).toBe(1);
    // Requeued in place (same rows, same order); the failed row is gone.
    expect(db.query("SELECT id, state FROM node_command_outbox ORDER BY rowid").all()).toEqual([{ id: interrupted, state: "queued" }, { id: behind, state: "queued" }]);

    const state = createServerState();
    const node = useFakeNode(state);
    await drainCommands(state);
    expect(node.sent.map(command => command.op === "session.prompt" && command.clientId)).toEqual(["interrupted", "behind"]);
    expect(db.query("SELECT COUNT(*) AS n FROM node_command_outbox").get()).toEqual({ n: 0 });
  } finally { closeDb(db); }
});

