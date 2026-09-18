import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("manual AgentHarness Pi launcher", () => {
  test("creates and reopens a canonical fake-provider session only inside its sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-manual-launcher-test-"));
    const process = Bun.spawn([
      processExecPath(),
      "run",
      join(import.meta.dir, "..", "manual-agent-harness-pi.ts"),
      "--root",
      root,
    ], { stdout: "pipe", stderr: "pipe", env: { PATH: Bun.env.PATH ?? "" } });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(`SANDBOX_ROOT=${root}`);
    expect(stdout).toContain(`DATABASE=${join(root, "data", "reins.db")}`);
    expect(stdout).toContain("fake response one");
    expect(stdout).toContain("fake response after reopen");
    expect(stdout).toContain("FAKE_REOPEN_OK");
    expect((await readdir(join(root, "data"))).toSorted()).toEqual(["reins.db", "reins.db-shm", "reins.db-wal"]);
    expect(await readdir(join(root, "home"))).toEqual([]);
  }, 15_000);
});

function processExecPath(): string {
  return process.execPath;
}
