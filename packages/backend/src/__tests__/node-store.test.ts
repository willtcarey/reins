import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../migrations.js";
import { setDb } from "../db.js";
import { createProject } from "./project-fixture.js";
import { createSession } from "./session-fixture.js";
import { generateKeyPairSync } from "node:crypto";
import { getSource, createSource, updateSourcePath, activeNodeKey } from "../node-store.js";
import { createPairingCode, redeemPairingCode } from "../models/node-pairing.js";
import { revokeNode } from "../models/nodes.js";
import { setupTestDb, teardownTestDb } from "./helpers/test-db.js";
import { createServerState } from "./helpers/server-state.js";

test("sessions bind to a source of their project, wherever its path moves", () => {
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
    updateSourcePath(source!.id, "/tmp/new-a");
    expect(getSource(source!.id)?.path).toBe("/tmp/new-a");
    expect(() => db.exec(`UPDATE sessions SET project_id = ${b.id} WHERE id = 'one'`)).toThrow();
  } finally { setDb(new Database(":memory:")); db.close(); }
});

test("a node's active key is the public key it paired with, until it is revoked; an unpaired or unknown node has none", async () => {
  setupTestDb();
  const state = createServerState();
  try {
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
    const { nodeId } = redeemPairingCode({ code: createPairingCode({}).code, publicKey, hostname: "box" });

    expect(activeNodeKey(nodeId)).toBe(publicKey);
    expect(activeNodeKey("internal")).toBeNull();
    expect(activeNodeKey("nowhere")).toBeNull();
    revokeNode(state.nodes, nodeId);
    expect(activeNodeKey(nodeId)).toBeNull();
  } finally { await state.nodes.close(); teardownTestDb(); }
});
