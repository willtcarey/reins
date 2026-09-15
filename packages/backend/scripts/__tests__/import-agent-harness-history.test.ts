import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import fixture from "./fixtures/agent-harness-legacy-history.json";
import { createAgentHarnessPiRuntime } from "../../src/runtimes/pi/agent-harness-runtime.js";
import { PiStorageAdapter } from "../../src/runtimes/pi/storage-adapter.js";
import { copyDatabaseWithVacuum, importAgentHarnessHistory } from "../lib/agent-harness-history-import.js";
import { validate } from "../validate-agent-harness-history.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function schema(db: Database): void {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE migrations(name TEXT PRIMARY KEY); INSERT INTO migrations VALUES('027_add_agent_harness_storage');
    CREATE TABLE sessions(id TEXT PRIMARY KEY, agent_runtime_type TEXT NOT NULL, model_provider TEXT, model_id TEXT, thinking_level TEXT, harness_next_seq INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE session_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL,
      role TEXT NOT NULL, message_json TEXT NOT NULL, created_at TEXT NOT NULL, parent_id INTEGER REFERENCES session_messages(id) ON DELETE SET NULL,
      harness_id TEXT, UNIQUE(session_id,seq));
    CREATE UNIQUE INDEX idx_harness ON session_messages(session_id,harness_id) WHERE harness_id IS NOT NULL;
    CREATE TABLE session_attachments(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,kind TEXT NOT NULL,mime_type TEXT NOT NULL,filename TEXT,byte_size INTEGER NOT NULL,sha256 TEXT NOT NULL,data BLOB,created_at TEXT NOT NULL,pruned_at TEXT,width INTEGER,height INTEGER);
    CREATE TABLE pi_values(session_id TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,seq INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(session_id,namespace,key));
    CREATE TABLE pi_lists(session_id TEXT NOT NULL,namespace TEXT NOT NULL,key TEXT NOT NULL,seq INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(session_id,namespace,key,seq));
    CREATE TABLE pi_usage(session_id TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,entry_id TEXT,adjustment INTEGER NOT NULL,usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json)),PRIMARY KEY(session_id,id),UNIQUE(session_id,seq));`);
}

async function makeFixture(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "reins-history-import-")); roots.push(root);
  const source = join(root, "source.db");
  const db = new Database(source); schema(db);
  db.query("INSERT INTO sessions VALUES(?,?,?,?,?,1)").run("pi", "pi", "anthropic", "pi-old", "high");
  db.query("INSERT INTO sessions VALUES(?,?,?,?,?,1)").run("claude", "claude_agent_sdk", "claude_agent_sdk", "claude-old", "medium");
  for (const [sessionId, messages] of [["pi", fixture.pi], ["claude", fixture.claude]] as const) {
    let parent: number | null = null;
    for (const [index, message] of messages.entries()) {
      const createdAt = `2026-01-01T00:00:0${index}.000Z`;
      const result = db.query("INSERT INTO session_messages(session_id,seq,role,message_json,created_at,parent_id) VALUES(?,?,?,?,?,?)")
        .run(sessionId, index + 1, message.role, JSON.stringify({ ...message, timestamp: Date.parse(createdAt) }), createdAt, parent);
      parent = Number(result.lastInsertRowid);
    }
  }
  db.query("INSERT INTO session_attachments VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("att-1", "claude", "image", "image/png", "x.png", 3, "hash", new Uint8Array([1, 2, 3]), "2026-01-01T00:00:00.000Z", null, 1, 1);
  db.close();
  return { root, source };
}

const config = {
  catalog: [{ provider: "faux", modelId: "fake" }],
  sessions: {
  pi: { model: { provider: "faux", modelId: "fake" }, activeToolNames: [] },
  claude: { model: { provider: "faux", modelId: "fake" }, activeToolNames: ["read", "bash"] },
  },
};

describe("offline AgentHarness history import", () => {
  test("preserves identity data and translates Pi and Claude messages into one canonical format", async () => {
    const { root, source } = await makeFixture();
    const before = await readFile(source);
    const output = join(root, "output.db");
    const report = await importAgentHarnessHistory({ source, output, config });
    expect(report).toMatchObject({ sessions: 2, messages: 10, attachments: 1, integrity: "ok", foreignKeys: 0, unresolvedModels: [] });
    expect(await readFile(source)).toEqual(before);

    const db = new Database(output, { readonly: true });
    const rows = db.query<{ id:number; parent_id:number|null; harness_id:string; role:string; message_json:string }, []>("SELECT id,parent_id,harness_id,role,message_json FROM session_messages ORDER BY id").all();
    expect(rows.map((row) => row.id)).toEqual([1,2,3,4,5,6,7,8,9,10]);
    expect(rows.map((row) => row.role)).toEqual([
      "reinsInput", "assistant", "toolResult", "compaction", "reinsInput", "assistant",
      "reinsInput", "assistant", "toolResult", "assistant",
    ]);
    expect(rows.slice(1).every((row, index) => row.parent_id === index + 1 || row.id === 7)).toBe(true);
    expect(JSON.parse(rows[0]!.message_json).message.reinsId).toBe("client-message-1");
    expect(rows[0]!.harness_id).toBe("pi-user");
    const assistant = JSON.parse(rows[1]!.message_json);
    expect(assistant).toMatchObject({ type: "message", message: { role: "assistant", content: [
      { type: "thinking", thinkingSignature: "sig" }, { type: "toolCall", id: "call-1" },
    ] } });
    const compaction = JSON.parse(rows[3]!.message_json);
    expect(compaction).toEqual({ type: "compaction", timestamp: Date.parse("2026-01-01T00:00:03.000Z"), summary: "summary", retainedTail: [], tokensBefore: 123, fromHook: false });
    const claudeUser = JSON.parse(rows[6]!.message_json);
    expect(claudeUser.message).toMatchObject({ role: "reinsInput", content: [
      { type: "text", text: "claude question" }, { type: "image", attachmentId: "att-1" },
    ] });
    expect(db.query<{ data: Uint8Array }, []>("SELECT data FROM session_attachments WHERE id='att-1'").get()!.data).toEqual(new Uint8Array([1,2,3]));
    expect(db.query<{ value_json:string }, []>("SELECT value_json FROM pi_values WHERE session_id='claude' AND namespace='pi.lane.config'").get())
      .toEqual({ value_json: JSON.stringify({ model: config.sessions.claude.model, thinkingLevel: "medium", activeToolNames: ["read","bash"] }) });
    db.close();
  });

  test("actual harness fake resume repairs a detached post-compaction suffix and sends the legacy active context once", async () => {
    const { root, source } = await makeFixture(); const output = join(root, "output.db");
    const sourceDb = new Database(source);
    sourceDb.query("UPDATE session_messages SET parent_id=NULL WHERE id=5").run(); sourceDb.close();
    const report = await importAgentHarnessHistory({ source, output, config });
    expect(report.ancestryRepair).toEqual({ changedLinks: 1, affectedSessions: 1 });
    const db = new Database(output);
    const storage = new PiStorageAdapter(db, "pi");
    const session = new StorageBackedSession({ id: "pi", createdAt: 0, storageVersion: 1, cwd: "/tmp" }, storage);
    const tip = await session.getBranchTip("main", BACKGROUND_CONTEXT);
    const branch = (await session.scanBranch({ start: tip!, stopAtType: "compaction", order: "newestFirst" }, BACKGROUND_CONTEXT)).toReversed();
    expect(branch.map((entry) => entry.type)).toEqual(["compaction", "message", "message"]);
    expect(branch[0]).toMatchObject({ type: "compaction", retainedTail: [] });
    const projected = branch.flatMap((entry) => entry.type === "compaction"
      ? [{ role: "compactionSummary", summary: entry.summary }, ...entry.retainedTail]
      : entry.type === "message" ? [entry.message] : []);
    expect(projected.map((message) => message.role)).toEqual(["compactionSummary", "reinsInput", "assistant"]);
    expect(projected).toHaveLength(3);
    await session.close(BACKGROUND_CONTEXT);

    const calls: unknown[][] = [];
    const provider = fauxProvider({ provider: "faux", models: [{ id: "fake", contextWindow: 2_000, maxTokens: 100 }] });
    provider.setResponses([(context) => {
      calls.push(structuredClone(context.messages));
      return fauxAssistantMessage("validated");
    }]);
    const models = createModels(); models.setProvider(provider.provider);
    const runtime = await createAgentHarnessPiRuntime({
      db, sessionId: "pi", createdAt: 0, cwd: "/tmp",
      options: { models, model: provider.getModel(), tools: [], compaction: { enabled: false, reserveTokens: 20, keepRecentTokens: 20 } },
    });
    await runtime.prompt([{ type: "text", text: "validation prompt" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((message: any) => message.role)).toEqual(["user", "user", "assistant", "user"]);
    expect(calls[0]!.filter((message: any) => message.role === "user"
      && Array.isArray(message.content)
      && message.content.some((block: any) => block.type === "text" && block.text.includes("<summary>\nsummary\n</summary>"))))
      .toHaveLength(1);
    await runtime.close(); db.close();
  });

  test("rejects invalid client identity and differing display content", async () => {
    const invalid = await makeFixture();
    const invalidDb = new Database(invalid.source);
    invalidDb.query("UPDATE session_messages SET message_json=json_set(message_json, '$.clientMessageId', 1) WHERE id=1").run(); invalidDb.close();
    await expect(importAgentHarnessHistory({ source: invalid.source, output: join(invalid.root, "invalid-client.db"), config })).rejects.toThrow("invalid clientMessageId");

    const differing = await makeFixture();
    const differingDb = new Database(differing.source);
    differingDb.query("UPDATE session_messages SET message_json=json_set(message_json, '$.displayContent[0].text', 'different') WHERE id=1").run(); differingDb.close();
    await expect(importAgentHarnessHistory({ source: differing.source, output: join(differing.root, "different-display.db"), config })).rejects.toThrow("displayContent that differs");
  });

  test("rejects missing models, metadata, unknown formats, and malformed ancestry without leaving output", async () => {
    const { root, source } = await makeFixture();
    const missingOutput = join(root, "missing.db");
    await expect(importAgentHarnessHistory({ source, output: missingOutput, config: { catalog: config.catalog, sessions: { pi: config.sessions.pi } } })).rejects.toThrow("claude requires an explicit model");
    await expect(stat(missingOutput)).rejects.toThrow();
    const metadataDb = new Database(source);
    metadataDb.query("UPDATE session_messages SET message_json=json_set(message_json, '$.metadata.audit', 1) WHERE id=1").run(); metadataDb.close();
    const metadataOutput = join(root, "metadata.db");
    await expect(importAgentHarnessHistory({ source, output: metadataOutput, config })).rejects.toThrow("messages with unsupported metadata");
    await expect(stat(metadataOutput)).rejects.toThrow();
    const db = new Database(source);
    db.query("UPDATE session_messages SET message_json=json_remove(message_json, '$.metadata'), role='unknown' WHERE id=1").run(); db.close();
    const unknownOutput = join(root, "unknown.db");
    await expect(importAgentHarnessHistory({ source, output: unknownOutput, config })).rejects.toThrow("unsupported role/shape");
    await expect(stat(unknownOutput)).rejects.toThrow();
    const ancestryDb = new Database(source);
    ancestryDb.query("UPDATE session_messages SET role='user', parent_id=10 WHERE id=1").run(); ancestryDb.close();
    const malformedOutput = join(root, "malformed.db");
    await expect(importAgentHarnessHistory({ source, output: malformedOutput, config })).rejects.toThrow("messages with invalid ancestry");
    await expect(stat(malformedOutput)).rejects.toThrow();
  }, 20_000);

  test("repairs detached roots but rejects non-null alternative ancestry", async () => {
    const { root, source } = await makeFixture();
    const detached = new Database(source);
    detached.query("UPDATE session_messages SET parent_id=NULL WHERE id=8").run(); detached.close();
    const output = join(root, "detached.db");
    const report = await importAgentHarnessHistory({ source, output, config });
    expect(report.ancestryRepair).toEqual({ changedLinks: 1, affectedSessions: 1 });
    expect(new Database(output, { readonly: true }).query<{ parent_id: number }, []>("SELECT parent_id FROM session_messages WHERE id=8").get())
      .toEqual({ parent_id: 7 });

    const alternativeSource = (await makeFixture());
    const alternative = new Database(alternativeSource.source);
    alternative.query("UPDATE session_messages SET parent_id=1 WHERE id=3").run(); alternative.close();
    const rejected = join(alternativeSource.root, "alternative.db");
    await expect(importAgentHarnessHistory({ source: alternativeSource.source, output: rejected, config })).rejects.toThrow("refusing to flatten possible branches");
    await expect(stat(rejected)).rejects.toThrow();
  });

  test("assigns deterministic row identities when archived and active rows repeat a logical ID", async () => {
    const { root, source } = await makeFixture();
    const db = new Database(source);
    db.query("UPDATE session_messages SET message_json=json_set(message_json, '$.logicalId', 'repeated') WHERE id IN (1,2)").run(); db.close();
    const output = join(root, "duplicates.db");
    await importAgentHarnessHistory({ source, output, config });
    const migrated = new Database(output, { readonly: true });
    const ids = migrated.query<{ harness_id: string }, []>("SELECT harness_id FROM session_messages WHERE id IN (1,2) ORDER BY id").all().map((row) => row.harness_id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith("reins-import-v1-"))).toBe(true);
    migrated.close();
  });

  test("reports catalog-unavailable models without blocking structural import", async () => {
    const { root, source } = await makeFixture(); const output = join(root, "unresolved.db");
    const report = await importAgentHarnessHistory({ source, output, config: { ...config, catalog: [] } });
    expect(report.unresolvedModels).toEqual([{ provider: "faux", modelId: "fake", sessions: 2 }]);
  });

  test("recreates verified-empty Pi tables with canonical foreign keys, checks, and unique keys", async () => {
    const { root, source } = await makeFixture();
    const db = new Database(source);
    db.exec(`DROP TABLE pi_values; DROP TABLE pi_usage;
      CREATE TABLE pi_values(session_id TEXT,namespace TEXT,key TEXT,seq INTEGER,value_json TEXT,PRIMARY KEY(session_id,namespace,key));
      CREATE TABLE pi_usage(session_id TEXT,id TEXT,seq INTEGER,entry_id TEXT,adjustment INTEGER,usage_json TEXT,details_json TEXT,PRIMARY KEY(session_id,id),UNIQUE(id,seq));`);
    db.close();
    const output = join(root, "recreated-schema.db");
    await importAgentHarnessHistory({ source, output, config });
    const migrated = new Database(output, { readonly: true });
    expect(migrated.query<{ table: string; on_delete: string }, []>("PRAGMA foreign_key_list(pi_values)").all())
      .toContainEqual(expect.objectContaining({ table: "sessions", on_delete: "CASCADE" }));
    const usageIndexes = migrated.query<{ name: string; unique: number }, []>("PRAGMA index_list(pi_usage)").all().filter((row) => row.unique === 1);
    expect(usageIndexes).toHaveLength(2);
    const sql = migrated.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='pi_usage'").get()!.sql;
    expect(sql).toContain("CHECK(json_valid(usage_json))");
    expect(sql).toContain("UNIQUE(session_id,seq)");
    migrated.close();
  });

  test("rejects nonempty legacy harness state", async () => {
    const { root, source } = await makeFixture();
    const db = new Database(source);
    db.exec("CREATE TABLE harness_values(session_id TEXT, namespace TEXT, key TEXT, value_json TEXT)");
    db.query("INSERT INTO harness_values VALUES('pi','old','value','1')").run(); db.close();
    const output = join(root, "legacy-state.db");
    await expect(importAgentHarnessHistory({ source, output, config })).rejects.toThrow("unsupported legacy table harness_values");
    await expect(stat(output)).rejects.toThrow();
  });

  test("refuses repeat runs, existing outputs, and same-file aliases", async () => {
    const { root, source } = await makeFixture(); const output = join(root, "output.db");
    await importAgentHarnessHistory({ source, output, config });
    await expect(importAgentHarnessHistory({ source, output, config })).rejects.toThrow("Output already exists");
    await expect(importAgentHarnessHistory({ source, output: source, config })).rejects.toThrow("distinct files");
    const repeated = join(root, "repeated.db");
    await expect(importAgentHarnessHistory({ source: output, output: repeated, config })).rejects.toThrow("already or partially");
  });

  test("standalone validator rejects changed compaction accounting and wrong main tips", async () => {
    const changed = await makeFixture(); const changedOutput = join(changed.root, "changed.db");
    await importAgentHarnessHistory({ source: changed.source, output: changedOutput, config });
    const changedDb = new Database(changedOutput);
    changedDb.query("UPDATE session_messages SET message_json=json_set(message_json, '$.tokensBefore', 0) WHERE role='compaction'").run(); changedDb.close();
    await expect(validate(changed.source, changedOutput)).rejects.toThrow("Archive projection mismatch");

    const tipped = await makeFixture(); const tippedOutput = join(tipped.root, "tipped.db");
    await importAgentHarnessHistory({ source: tipped.source, output: tippedOutput, config });
    const tipDb = new Database(tippedOutput);
    tipDb.query("UPDATE pi_values SET value_json='null' WHERE session_id='pi' AND namespace='pi.branch.tip'").run(); tipDb.close();
    await expect(validate(tipped.source, tippedOutput)).rejects.toThrow("Main tip is not the final entry");
  });

  test("standalone validator reproduces archive, attachment, ancestry, lane, and active-context hashes", async () => {
    const { root, source } = await makeFixture(); const output = join(root, "validated.db");
    await importAgentHarnessHistory({ source, output, config });
    const report = await validate(source, output);
    expect(report).toMatchObject({ messages: 10, sessions: 2, ancestryRepair: { changedLinks: 0, affectedSessions: 0 }, quickCheck: "ok", foreignKeyRows: 0 });
    expect(report.archiveExpectedHash).toBe(report.archiveActualHash);
    expect(report.activeExpectedHash).toBe(report.activeActualHash);
    expect(report.attachmentSourceHash).toBe(report.attachmentOutputHash);
  });

  test("VACUUM INTO captures committed WAL rows without modifying the source", async () => {
    const { root, source } = await makeFixture();
    const writer = new Database(source); writer.exec("PRAGMA journal_mode=WAL");
    writer.query("INSERT INTO sessions VALUES(?,?,?,?,?,1)").run("wal", "pi", "p", "m", "off");
    const before = await readFile(source); const snapshot = join(root, "snapshot.db");
    copyDatabaseWithVacuum(source, snapshot);
    expect(new Database(snapshot, { readonly: true }).query("SELECT 1 FROM sessions WHERE id='wal'").get()).toBeTruthy();
    expect(await readFile(source)).toEqual(before);
    writer.close();
  });
});
