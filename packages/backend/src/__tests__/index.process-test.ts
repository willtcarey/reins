import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../migrations.js";

test("backend bootstrap does not validate migrated history before startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reins-bootstrap-"));
  try {
    const db = new Database(join(dir, "reins.db"));
    runMigrations(db);
    db.exec("DROP INDEX idx_session_messages_session_harness_id");
    db.close();

    const entry = new URL("../index.ts", import.meta.url).href;
    const child = Bun.spawnSync([process.execPath, "--eval", `await import(${JSON.stringify(entry)}); process.exit(0)`], {
      env: { ...process.env, REINS_DATA_DIR: dir, HOME: dir },
      stdout: "pipe", stderr: "pipe",
    });
    expect(child.stderr.toString()).not.toContain("Unsupported Reins history format");
    expect(child.exitCode).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
