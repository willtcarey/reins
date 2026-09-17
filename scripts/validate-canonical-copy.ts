#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { chmodSync, createReadStream, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const source = resolve(process.argv[2] ?? "");
const root = resolve(process.argv[3] ?? `/tmp/reins-canonical-validation-${process.pid}`);
if (!process.argv[2]) throw new Error("Usage: validate-canonical-copy.ts SOURCE.sqlite [WORK_ROOT]");

async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function copyBaseline(from: string, to: string): Promise<void> {
  const child = Bun.spawn(["cp", "--sparse=auto", from, to], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Failed to create the disposable validation clone");
}

const sourceHash = await hash(source);
rmSync(root, { recursive: true, force: true });
const dataDir = join(root, "execution-data");
const home = join(root, "home");
for (const dir of [dataDir, home, join(home, ".config"), join(home, ".cache"), join(home, ".local", "share")]) {
  mkdirSync(dir, { recursive: true });
}
const execution = join(dataDir, "reins.db");
await copyBaseline(source, execution);
if (await hash(execution) !== sourceHash) throw new Error("Disposable clone hash mismatch");
chmodSync(execution, 0o600);

// Isolation is established before any application module is imported.
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  REINS_DATA_DIR: dataDir,
  NO_PROXY: "*",
  no_proxy: "*",
});
for (const key of Object.keys(process.env)) {
  if (/(_API_KEY|_TOKEN|_SECRET|ANTHROPIC|OPENAI|GOOGLE|GEMINI|AWS_)/i.test(key)) delete process.env[key];
}

const db = new Database(execution);
db.exec("PRAGMA foreign_keys = ON; DELETE FROM auth_credentials");
const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check;
if (integrity !== "ok") throw new Error(`Integrity check failed: ${integrity}`);
const foreignKeys = db.query("PRAGMA foreign_key_check").all().length;
if (foreignKeys !== 0) throw new Error(`Foreign key violations: ${foreignKeys}`);

const { setDb } = await import("../packages/backend/src/db.js");
setDb(db);
const { loadMessages, loadActiveMessages, loadMessagePage, listSessionEntries } = await import("../packages/backend/src/messages-store.js");
const sessions = db.query<{ id: string }, []>("SELECT id FROM sessions ORDER BY id").all();
let archiveRows = 0;
let mainAncestryRows = 0;
let pagedRows = 0;
let toolCalls = 0;
for (const { id } of sessions) {
  const expectedArchive = db.query<{ count: number }, [string]>(
    `SELECT COUNT(*) AS count FROM session_messages
     WHERE session_id = ? AND json_extract(message_json, '$.type') IN ('message', 'compaction')`,
  ).get(id)!.count;
  const archive = loadMessages(id);
  if (archive.length !== expectedArchive) throw new Error(`Archive projection count mismatch for session ${id}`);
  archiveRows += archive.length;

  const active = loadActiveMessages(id);
  const tip = db.query<{ value_json: string }, [string]>(
    "SELECT value_json FROM pi_values WHERE session_id = ? AND namespace = 'pi.branch.tip' AND key = 'main'",
  ).get(id);
  if (!tip) throw new Error(`Missing main branch tip for session ${id}`);
  mainAncestryRows += active.length;

  let afterSeq = -1;
  let sessionPaged = 0;
  for (;;) {
    const page = loadMessagePage(id, 200, { afterSeq });
    sessionPaged += page.items.length;
    if (page.items.length === 0) break;
    const cursor = page.pageInfo.endCursor;
    if (!cursor) throw new Error(`Missing end cursor for session ${id}`);
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!decoded || typeof decoded !== "object" || !("seq" in decoded) || typeof decoded.seq !== "number") {
      throw new Error(`Invalid cursor for session ${id}`);
    }
    if (decoded.seq <= afterSeq) throw new Error(`Non-advancing cursor for session ${id}`);
    afterSeq = decoded.seq;
  }
  if (sessionPaged !== expectedArchive) throw new Error(`Pagination count mismatch for session ${id}`);
  pagedRows += sessionPaged;

  const entries = listSessionEntries(id, { types: ["toolCall"], includeContent: false });
  for (const entry of entries) {
    if (entry.type !== "toolCall") throw new Error(`Unexpected timeline entry type for session ${id}`);
    if (entry.result && entry.result.seq < entry.seq) throw new Error(`Tool result precedes call for session ${id}`);
  }
  toolCalls += entries.length;
}

if (await hash(source) !== sourceHash) {
  throw new Error("Immutable source changed during validation");
}
console.log(JSON.stringify({
  source,
  sourceHash,
  executionDb: execution,
  credentialsRemovedFromExecutionClone: true,
  sessions: sessions.length,
  archiveRows,
  mainAncestryRows,
  pagedRows,
  toolCalls,
  integrity,
  foreignKeys,
}, null, 2));
db.close();
