import { describe, expect, test } from "bun:test";
import { describeTiming, timeRequest, timed, timedSync } from "../request-timing.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../database.js";
import { createTestRepo } from "./helpers/test-repo.js";
import { localGit } from "./helpers/local-git.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("request timing", () => {
  test("adds up a request's timed phases by name", async () => {
    const [, timing] = await timeRequest(async () => {
      await timed("git diff", () => sleep(30));
      await timed("git rev-parse", () => sleep(5));
      await timed("git rev-parse", () => sleep(5));
      timedSync("parse numstat", () => 1);
    });

    expect([...timing.phases.keys()]).toEqual(["git diff", "git rev-parse", "parse numstat"]);
    expect(timing.phases.get("git diff")!.ms).toBeGreaterThanOrEqual(25);
    expect(timing.phases.get("git rev-parse")!.count).toBe(2);
  });

  test("keeps the phases of requests that overlap apart", async () => {
    const [[, first], [, second]] = await Promise.all([
      timeRequest(() => timed("one", () => sleep(10))),
      timeRequest(() => timed("two", () => sleep(10))),
    ]);

    expect([...first.phases.keys()]).toEqual(["one"]);
    expect([...second.phases.keys()]).toEqual(["two"]);
  });

  test("outside a request, a timed phase only runs", async () => {
    expect(await timed("alone", async () => 7)).toBe(7);
  });

  test("measures how long the event loop was blocked during the request", async () => {
    const [, timing] = await timeRequest(async () => {
      await sleep(30);
      const until = performance.now() + 150;
      while (performance.now() < until) { /* blocks the event loop */ }
      await sleep(30);
    });

    expect(timing.maxLagMs).toBeGreaterThanOrEqual(100);
  });

  test("describes the phases, the slowest first, and the event loop's lag", () => {
    const phases = new Map([["git rev-parse", { count: 2, ms: 60.4 }], ["git diff", { count: 1, ms: 640.2 }]]);

    expect(describeTiming({ phases, maxLagMs: 12.6 })).toBe("(git diff 640ms, git rev-parse ×2 60ms; event loop lag 13ms)");
  });

  test("every SQLite statement a request runs adds to one sqlite phase", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reins-request-timing-"));
    const db = openDatabase(join(dir, "test.db"));
    try {
      db.run("CREATE TABLE things (name TEXT)");

      const [, timing] = await timeRequest(async () => {
        db.query("INSERT INTO things (name) VALUES (?)").run("a");
        db.prepare("INSERT INTO things (name) VALUES (?)").run("b");
        db.query("SELECT name FROM things").all();
        db.query("SELECT count(*) AS n FROM things").get();
        db.run("DELETE FROM things WHERE name = 'a'");
      });

      expect(timing.phases.get("sqlite")?.count).toBe(5);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a git command is a phase of the request that runs it", async () => {
    const repo = await createTestRepo();

    const [, timing] = await timeRequest(() => localGit(repo.dir).getCurrentBranch());

    expect(timing.phases.get("git rev-parse")?.count).toBe(1);
  });
});
