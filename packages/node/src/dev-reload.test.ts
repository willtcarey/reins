import { expect, test } from "bun:test";
import { createReloadWhenIdle, isReloadSource, trackCalls, type ReloadActivity } from "./dev-reload.js";

test("node code changes reload, tests and fixtures do not", () => {
  expect(["node.ts", "runtime/pi-runtime.ts", "protocol/schema.ts"].every(isReloadSource)).toBe(true);
  expect(["node.test.ts", "runtime/__fixtures__/a.ts", "__tests__/x.ts", "dist/node.ts", "notes.md"].some(isReloadSource)).toBe(false);
});

function reloader(initial: ReloadActivity) {
  let activity = initial;
  const logs: string[] = [];
  let reloads = 0;
  const controller = createReloadWhenIdle({ activity: () => activity, reload: () => { reloads++; }, log: message => logs.push(message), debounceMs: 20, pollMs: 20 });
  return { controller, logs, reloads: () => reloads, set: (next: ReloadActivity) => { activity = next; } };
}

test("a burst of changes on an idle node is one reload after the debounce", async () => {
  const r = reloader({ activeRuns: 0, pending: 0 });
  r.controller.changed("a.ts");
  r.controller.changed("b.ts");
  r.controller.changed("a.ts");
  expect(r.reloads()).toBe(0);
  await Bun.sleep(60);
  r.controller.changed("c.ts");
  await Bun.sleep(60);
  expect(r.reloads()).toBe(1);
  expect(r.logs).toEqual(["node reloading after code change (a.ts, b.ts)"]);
});

test("a reload waits for active runs and work in progress, then happens once", async () => {
  const r = reloader({ activeRuns: 2, pending: 0 });
  r.controller.changed("node.ts");
  await Bun.sleep(80);
  expect(r.reloads()).toBe(0);
  r.set({ activeRuns: 0, pending: 1 });
  r.controller.changed("storage.ts");
  await Bun.sleep(80);
  expect(r.reloads()).toBe(0);
  r.set({ activeRuns: 0, pending: 0 });
  await Bun.sleep(80);
  expect(r.reloads()).toBe(1);
  expect(r.logs).toEqual([
    "code changed (node.ts); waiting for 2 active runs before reloading",
    "code changed (node.ts, storage.ts); waiting for work in progress before reloading",
    "node reloading after code change (node.ts, storage.ts)",
  ]);
});

test("stop cancels a pending reload", async () => {
  const r = reloader({ activeRuns: 0, pending: 0 });
  r.controller.changed("node.ts");
  r.controller.stop();
  await Bun.sleep(60);
  expect(r.reloads()).toBe(0);
});

test("tracked calls count until their promise settles, including when they fail; untracked methods do not count", async () => {
  let release!: () => void;
  const commands = {
    abort: () => new Promise<void>(resolve => { release = resolve; }),
    steer: () => Promise.reject(new Error("no")),
    attach: () => new Promise<void>(() => undefined),
  };
  const { tracked, inFlight } = trackCalls(commands, ["attach"]);
  const aborting = tracked.abort();
  expect(inFlight()).toBe(1);
  const failing = tracked.steer();
  expect(inFlight()).toBe(2);
  await expect(failing).rejects.toThrow("no");
  expect(inFlight()).toBe(1);
  void tracked.attach();
  expect(inFlight()).toBe(1);
  release();
  await aborting;
  expect(inFlight()).toBe(0);
});
