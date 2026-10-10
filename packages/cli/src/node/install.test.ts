import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateBuild, bundleBuildId, currentBuildId, RESTART_EXIT_CODE, writeLauncher } from "./install.js";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

test("activating a bundle run from elsewhere puts it under its build ID and makes it current; activating another flips current to it", async () => {
  const home = join(tempDir("reins-install-"), "home");
  const downloads = tempDir("reins-install-downloads-");
  writeFileSync(join(downloads, "first.js"), "console.log(1);\n");
  writeFileSync(join(downloads, "second.js"), "console.log(2);\n");

  const first = await activateBuild(home, join(downloads, "first.js"));
  expect(first).toBe(await bundleBuildId(join(downloads, "first.js")));
  expect(readFileSync(join(home, "builds", first, "reins.js"), "utf8")).toBe("console.log(1);\n");
  expect(readlinkSync(join(home, "current"))).toBe(join("builds", first));

  const second = await activateBuild(home, join(downloads, "second.js"));
  expect(readFileSync(join(home, "current", "reins.js"), "utf8")).toBe("console.log(2);\n");
  expect(await currentBuildId(home)).toBe(second);
  // The previous build stays.
  expect(readFileSync(join(home, "builds", first, "reins.js"), "utf8")).toBe("console.log(1);\n");
});

test("activating the bundle where the install script put it flips current to it, copying nothing", async () => {
  const home = tempDir("reins-install-");
  writeFileSync(join(home, "download.js"), "console.log(3);\n");
  const buildId = await bundleBuildId(join(home, "download.js"));
  mkdirSync(join(home, "builds", buildId), { recursive: true });
  writeFileSync(join(home, "builds", buildId, "reins.js"), "console.log(3);\n");

  expect(await activateBuild(home, join(home, "builds", buildId, "reins.js"))).toBe(buildId);
  expect(await currentBuildId(home)).toBe(buildId);
});

test("the launcher runs the current build with the node home, the restart code and its own arguments, again each time it exits with that code, then exits as it did", async () => {
  // A home whose path needs quoting in sh.
  const home = tempDir("reins-launcher-it's ");
  symlinkSync(process.execPath, join(home, "bun"));
  // Exits with the restart code on its first two runs, then with 4.
  writeFileSync(join(home, "node.js"), `
    const { appendFileSync, readFileSync } = require("node:fs");
    const log = process.env.REINS_NODE_DATA_DIR + "/runs.log";
    appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), home: process.env.REINS_NODE_DATA_DIR, restart: process.env.REINS_NODE_RESTART_EXIT_CODE }) + "\\n");
    process.exit(readFileSync(log, "utf8").trim().split("\\n").length < 3 ? ${RESTART_EXIT_CODE} : 4);
  `);
  await activateBuild(home, join(home, "node.js"));
  const launcher = await writeLauncher(home);
  expect(await writeLauncher(home)).toBe(launcher);

  const proc = Bun.spawn([launcher, "node", "run", "it's"], { env: { PATH: process.env.PATH }, stdout: "inherit", stderr: "inherit" });

  expect(await proc.exited).toBe(4);
  const run = { argv: ["node", "run", "it's"], home, restart: String(RESTART_EXIT_CODE) };
  expect(readFileSync(join(home, "runs.log"), "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([run, run, run]);
});
