import { describe, expect, test } from "bun:test";
import type { ServerExtension } from "@reins/sdk/server";
import { BackendFailure, startBackend } from "../../extension-system/backend.js";
import { createAppState } from "../helpers/app-state.js";
import { testExtensionData, useTestDb } from "../helpers/test-db.js";

function start(extension: ServerExtension, openStorage = (name: string) => testExtensionData().open(name)) {
  const { host } = createAppState(undefined, { extensions: [] }).extensions;
  return { host, run: () => startBackend("notes", extension, { host, openStorage }) };
}

function failure(run: () => unknown): BackendFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof BackendFailure) return error;
    throw error;
  }
  throw new Error("Expected a BackendFailure");
}

describe("startBackend", () => {
  useTestDb();

  test("applies its migrations, registers it, then starts its services; disposing stops them, runs its disposer and removes all it registered", async () => {
    const log: string[] = [];
    const { host, run } = start({
      migrations: [{ id: "001_notes", up: db => db.exec("CREATE TABLE notes (text TEXT)") }],
      register: reins => {
        reins.services.register({ name: "poll", start: ({ signal }) => {
          log.push("service started");
          signal.addEventListener("abort", () => log.push("service stopped"));
        } });
        log.push("registered");
        reins.http.handle({ forgotten: {} }, { forgotten: () => {} });
        return () => { log.push("disposer"); };
      },
    });

    const backend = run();

    expect(log).toEqual(["registered", "service started"]);
    expect(backend.storage.db.query("SELECT id FROM reins_migrations").all()).toEqual([{ id: "001_notes" }]);
    expect(host.registrationsOf("notes").httpMethods).toEqual(["forgotten"]);

    await backend.dispose();

    expect(log).toEqual(["registered", "service started", "service stopped", "disposer"]);
    expect(host.registrationsOf("notes").httpMethods).toEqual([]);
  });

  test("a migration that throws is rolled back, those before it stay, and the failure keeps the storage it opened", () => {
    const { run } = start({
      migrations: [
        { id: "001_notes", up: db => db.exec("CREATE TABLE notes (text TEXT)") },
        { id: "002_broken", up: db => { db.exec("CREATE TABLE half (x)"); throw new Error("no such column"); } },
      ],
      register: () => () => {},
    });

    const error = failure(run);

    expect({ stage: error.stage, message: error.message }).toEqual({ stage: "migration", message: "no such column" });
    const tables = error.storage?.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
    expect(tables).toEqual(["notes", "reins_migrations"]);
  });

  test("a register function that throws leaves nothing registered", () => {
    const { host, run } = start({
      register: reins => {
        reins.http.handle({ early: {} }, { early: () => {} });
        throw new Error("misconfigured");
      },
    });

    const error = failure(run);

    expect({ stage: error.stage, message: error.message }).toEqual({ stage: "register", message: "misconfigured" });
    expect(host.registrationsOf("notes").httpMethods).toEqual([]);
  });

  test("storage that cannot be opened fails before anything runs", () => {
    let registered = false;
    const { run } = start({ register: () => { registered = true; return () => {}; } }, () => { throw new Error("disk full"); });

    const error = failure(run);

    expect({ stage: error.stage, storage: error.storage, registered }).toEqual({ stage: "storage", storage: null, registered: false });
  });
});
