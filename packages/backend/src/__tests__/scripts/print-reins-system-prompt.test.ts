import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../../scripts/print-reins-system-prompt.ts");

function printPrompt(args: string[], env: Record<string, string | undefined> = process.env) {
  return Bun.spawnSync([process.execPath, script, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("print Reins system prompt", () => {
  test("includes global ~/.agents/AGENTS.md before project instructions", () => {
    const home = mkdtempSync(join(tmpdir(), "reins-prompt-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "reins-prompt-project-"));
    try {
      mkdirSync(join(home, ".agents"));
      writeFileSync(join(home, ".agents", "AGENTS.md"), "Global agent instructions.\n");
      writeFileSync(join(cwd, "AGENTS.md"), "Local project instructions.\n");
      const result = printPrompt(["--cwd", cwd], {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      });
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(0);
      expect(output).toContain(`## ${join(home, ".agents", "AGENTS.md")}`);
      expect(output.indexOf("Global agent instructions.")).toBeLessThan(output.indexOf("Local project instructions."));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("prints the current AgentHarness tool and project context", () => {
    const cwd = mkdtempSync(join(tmpdir(), "reins-prompt-"));
    try {
      writeFileSync(join(cwd, "AGENTS.md"), "Print script project instructions.\n");
      const result = printPrompt(["--cwd", cwd]);
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(0);
      expect(output).toContain("Print script project instructions.");
      expect(output).toContain("- create_task:");
      expect(output).toContain("- search:");
      expect(output).toContain("- execute:");
      expect(output).toContain("This is a project assistant session");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("prints task-specific guidance when requested", () => {
    const cwd = mkdtempSync(join(tmpdir(), "reins-prompt-task-"));
    try {
      const result = printPrompt(["--cwd", cwd, "--task-title", "Fix session routing", "--task-description", "Keep route history."]);
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(0);
      expect(output).toContain("Title: Fix session routing");
      expect(output).toContain("Description: Keep route history.");
      expect(output).not.toContain("This is a project assistant session");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
