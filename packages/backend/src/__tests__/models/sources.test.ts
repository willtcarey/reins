import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { connectLoopbackNode, loopbackLink, stopLoopbackNode } from "../helpers/loopback-node.js";
import { CheckoutNotFoundError, ensureSource } from "../../models/sources.js";
import { NodeNotFoundError } from "../../models/nodes.js";
import { Models } from "../../models/models.js";
import { getDb } from "../../app-globals.js";

const sources = () => getDb().query("SELECT node_id, path FROM sources ORDER BY id").all();

describe("ensureSource", () => {
  let state: TestAppState;
  let dir: string;

  useTestDb();

  beforeEach(() => {
    state = createAppState();
    dir = mkdtempSync(join(tmpdir(), "reins-location-"));
  });
  afterEach(async () => {
    await stopLoopbackNode(state);
    await state.nodes.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("makes a location the node confirms is a directory, once: the same node and path are the same source", async () => {
    connectLoopbackNode(state);
    await loopbackLink(state).ready();
    const nodes = new Models(state).nodes;

    const made = await ensureSource("internal", dir, nodes);
    const again = await ensureSource("internal", `${dir}/`, nodes);

    expect(made.record).toEqual({ id: made.id, node_id: "internal", path: dir });
    expect(again.id).toBe(made.id);
    expect(sources()).toEqual([{ node_id: "internal", path: dir }]);
  });

  test("a known location is returned without its node, which may be offline", async () => {
    getDb().query("INSERT INTO sources (node_id, path) VALUES ('internal', ?)").run(dir);

    expect((await ensureSource("internal", dir, new Models(state).nodes)).path).toBe(dir);
  });

  test("refuses a new location that is relative, on a removed or unknown node, or not a directory there, keeping nothing", async () => {
    getDb().exec("INSERT INTO nodes (id, name, removed_at) VALUES ('gone', 'Gone', '2026-10-11T09:00:00.000Z')");
    connectLoopbackNode(state);
    await loopbackLink(state).ready();
    const nodes = new Models(state).nodes;

    await expect(ensureSource("internal", "relative/path", nodes)).rejects.toThrow(CheckoutNotFoundError);
    await expect(ensureSource("gone", dir, nodes)).rejects.toThrow(NodeNotFoundError);
    await expect(ensureSource("nowhere", dir, nodes)).rejects.toThrow(NodeNotFoundError);
    await expect(ensureSource("internal", join(dir, "missing"), nodes)).rejects.toThrow(CheckoutNotFoundError);
    expect(sources()).toEqual([]);
  });
});
