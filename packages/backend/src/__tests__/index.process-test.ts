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
    // Its own port and socket, so a running dev server cannot collide with it if startup gets far enough
    // to listen before the exit.
    const child = Bun.spawnSync([process.execPath, "--eval", `await import(${JSON.stringify(entry)}); process.exit(0)`], {
      env: { ...process.env, REINS_DATA_DIR: dir, HOME: dir, REINS_PORT: "0", REINS_NODE_SOCKET: join(dir, "run", "node.sock") },
      stdout: "pipe", stderr: "pipe", timeout: 20_000,
    });
    expect(child.stderr.toString()).not.toContain("Unsupported Reins history format");
    expect(child.exitCode).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
