import { afterEach, describe, expect, jest, test } from "bun:test";
import { setTimeout as sleep } from "timers/promises";
import type { Disposer, ServerSdk, ServiceContext } from "@reins/sdk/server";
import { buildRouter } from "../../routes/index.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { makeRequest } from "../helpers/request.js";
import { useTestDb } from "../helpers/test-db.js";

const router = buildRouter();

async function services(state: TestAppState, extension: string) {
  const response = (await router.handle(makeRequest("GET", "/api/installed-extensions"), state))!;
  const views: { name: string; services: unknown[] }[] = await response.json();
  return views.find(view => view.name === extension)!.services;
}

/** Lets the host's promise chains run (immediates are not faked). */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

afterEach(() => {
  jest.useRealTimers();
});

describe("an extension's services", () => {
  useTestDb();

  test("a service starts once, after its extension registered with its migrations applied, and reports running", async () => {
    const log: string[] = [];
    const state = createAppState(undefined, {
      extensions: [{
        name: "poller",
        migrations: [{ id: "001_items", up: db => db.exec("CREATE TABLE items (id INTEGER)") }],
        register: reins => {
          reins.services.register({
            name: "poll",
            start: ({ signal }) => {
              reins.db.query("SELECT * FROM items").all();
              log.push(`start aborted=${signal.aborted}`);
            },
          });
          log.push("registered");
          return () => {};
        },
      }],
    });
    await settle();

    expect(log).toEqual(["registered", "start aborted=false"]);
    expect(await services(state, "poller")).toEqual([
      { name: "poll", state: "running", since: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), restarts: 0, nextAttemptAt: null, lastError: null },
    ]);
  });

  test("disposing its registration aborts its signal, awaits its stop, and removes it from the report", async () => {
    const log: string[] = [];
    let dispose: Disposer | undefined;
    const state = createAppState(undefined, {
      extensions: [{
        name: "poller",
        register: reins => {
          dispose = reins.services.register({
            name: "poll",
            start: ({ signal }) => ({
              stop: async () => { await Bun.sleep(1); log.push(`stop aborted=${signal.aborted}`); },
            }),
          });
          return () => {};
        },
      }],
    });
    await settle();

    await dispose!();

    expect(log).toEqual(["stop aborted=true"]);
    expect(await services(state, "poller")).toEqual([]);
  });

  test("a reload stops the old app's instance before the new app starts one on its code", async () => {
    const log: string[] = [];
    const extension = (version: number) => ({
      name: "poller",
      register: (reins: ServerSdk) => {
        reins.services.register({
          name: "poll",
          start: () => {
            log.push(`start ${version}`);
            return { stop: async () => { await Bun.sleep(1); log.push(`stop ${version}`); } };
          },
        });
        return () => {};
      },
    });
    const first = createAppState(undefined, { extensions: [extension(1)] });
    await settle();

    // The app's `stop` (server.ts) awaits this before the next app starts.
    await first.extensions.dispose();
    createAppState(undefined, { extensions: [extension(2)] });
    await settle();

    expect(log).toEqual(["start 1", "stop 1", "start 2"]);
  });

  test("a loop on the signal needs no stop: its rejection at the abort, given to fail, is no crash", async () => {
    const errors: unknown[] = [];
    let ticks = 0;
    const state = createAppState(undefined, {
      extensions: [{
        name: "poller",
        register: reins => {
          reins.services.register({
            name: "poll",
            start: ({ signal, fail }) => {
              void (async () => {
                while (!signal.aborted) {
                  ticks++;
                  await sleep(1, undefined, { signal });
                }
              })().catch(fail);
            },
          });
          return () => {};
        },
      }],
      onExtensionError: (_name, error) => errors.push(error),
    });
    await Bun.sleep(20);

    await state.extensions.dispose();
    const ticksAtStop = ticks;
    await Bun.sleep(20);

    expect(ticksAtStop).toBeGreaterThan(1);
    expect(ticks).toBe(ticksAtStop);
    expect(errors).toEqual([]);
  });

  test("a stop that hangs is given up after 5 s and reported, so the app's stop goes on", async () => {
    jest.useFakeTimers();
    const errors: string[] = [];
    const state = createAppState(undefined, {
      extensions: [{
        name: "stuck",
        register: reins => {
          reins.services.register({ name: "poll", start: () => ({ stop: () => new Promise<void>(() => {}) }) });
          return () => {};
        },
      }],
      onExtensionError: (name, error) => errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`),
    });
    await settle();

    let stopped = false;
    const stopping = state.extensions.dispose().then(() => { stopped = true; });
    await settle();
    jest.advanceTimersByTime(4_999);
    await settle();
    const stoppedEarly = stopped;
    jest.advanceTimersByTime(1);
    await stopping;

    expect(stoppedEarly).toBe(false);
    expect(errors).toEqual(["stuck: Service poll did not stop within 5 s"]);
  });

  test("a crash restarts the service after a backoff of 1 s, doubling, back to 1 s once it ran for a minute", async () => {
    jest.useFakeTimers();
    const starts: number[] = [];
    let context: ServiceContext | undefined;
    let stops = 0;
    const state = createAppState(undefined, {
      extensions: [{
        name: "poller",
        register: reins => {
          reins.services.register({
            name: "poll",
            start: async ctx => {
              starts.push(Date.now());
              if (starts.length <= 2) throw new Error(`refused ${starts.length}`);
              context = ctx;
              return { stop: () => { stops++; } };
            },
          });
          return () => {};
        },
      }],
      onExtensionError: () => {},
    });
    await settle();
    const t0 = starts[0]!;

    expect(await services(state, "poller")).toEqual([{
      name: "poll", state: "restarting", since: new Date(t0).toISOString(), restarts: 0,
      nextAttemptAt: new Date(t0 + 1_000).toISOString(), lastError: { message: "refused 1", at: new Date(t0).toISOString() },
    }]);
    jest.advanceTimersByTime(1_000);
    await settle();
    jest.advanceTimersByTime(1_999);
    await settle();
    expect(starts.map(at => at - t0)).toEqual([0, 1_000]);
    jest.advanceTimersByTime(1);
    await settle();
    expect(starts.map(at => at - t0)).toEqual([0, 1_000, 3_000]);
    expect(await services(state, "poller")).toMatchObject([{ state: "running", restarts: 2, lastError: { message: "refused 2" } }]);

    // Healthy for a minute: the next crash waits 1 s again.
    jest.advanceTimersByTime(60_000);
    context!.fail(new Error("lost the queue"));
    await settle();
    expect(context!.signal.aborted).toBe(true);
    expect(stops).toBe(1);
    expect(await services(state, "poller")).toMatchObject([{ state: "restarting", restarts: 2, nextAttemptAt: new Date(t0 + 64_000).toISOString(), lastError: { message: "lost the queue" } }]);
    jest.advanceTimersByTime(1_000);
    await settle();
    expect(starts.map(at => at - t0)).toEqual([0, 1_000, 3_000, 64_000]);
    expect(await services(state, "poller")).toMatchObject([{ state: "running", restarts: 3 }]);
  });

  test("a crash whose stop hangs leaves the service failed, never started again in that app", async () => {
    jest.useFakeTimers();
    let starts = 0;
    let context: ServiceContext | undefined;
    const state = createAppState(undefined, {
      extensions: [{
        name: "poller",
        register: reins => {
          reins.services.register({
            name: "poll",
            start: ctx => { starts++; context = ctx; return { stop: () => new Promise<void>(() => {}) }; },
          });
          return () => {};
        },
      }],
      onExtensionError: () => {},
    });
    await settle();

    context!.fail(new Error("lost the queue"));
    jest.advanceTimersByTime(5_000);
    await settle();
    jest.advanceTimersByTime(300_000);
    await settle();

    expect(starts).toBe(1);
    expect(await services(state, "poller")).toMatchObject([{ state: "failed", lastError: { message: "Service poll did not stop within 5 s" } }]);
  });

  test("a failed extension starts none of its services", async () => {
    const starts: string[] = [];
    createAppState(undefined, {
      extensions: [
        {
          name: "migrating",
          migrations: [{ id: "001_fails", up: () => { throw new Error("bad migration"); } }],
          register: reins => reins.services.register({ name: "poll", start: () => { starts.push("migrating"); } }),
        },
        {
          name: "throwing",
          register: reins => {
            reins.services.register({ name: "poll", start: () => { starts.push("throwing"); } });
            throw new Error("cannot register");
          },
        },
      ],
      onExtensionError: () => {},
    });
    await settle();

    expect(starts).toEqual([]);
  });

  test("a name the extension already has refuses the registration", () => {
    let error: unknown;
    createAppState(undefined, {
      extensions: [{
        name: "poller",
        register: reins => {
          reins.services.register({ name: "poll", start: () => {} });
          try { reins.services.register({ name: "poll", start: () => {} }); } catch (thrown) { error = thrown; }
          return () => {};
        },
      }],
    });

    expect(error).toBeInstanceOf(Error);
  });
});
