import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoundedJsonlLog } from "../../models/client-telemetry-log.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("BoundedJsonlLog", () => {
  test("rotates JSONL records within a fixed total file count", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reins-telemetry-test-"));
    const path = join(tempDir, "client.jsonl");
    const log = new BoundedJsonlLog({ path, maxFileBytes: 80, maxFiles: 3 });

    for (let sequence = 0; sequence < 10; sequence += 1) {
      await log.append([{ sequence, event: `event-${sequence}` }]);
    }

    const files = (await readdir(tempDir)).toSorted();
    expect(files).toEqual(["client.jsonl", "client.jsonl.1", "client.jsonl.2"]);
    for (const file of files) {
      expect(Buffer.byteLength(await readFile(join(tempDir, file), "utf8"))).toBeLessThanOrEqual(80);
    }
    expect(await readFile(path, "utf8")).toContain('"sequence":9');
  });
});
