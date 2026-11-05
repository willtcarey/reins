import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScript } from "../../tools/execute.js";
import { getDb } from "../../app-globals.js";
import { createProject } from "../project-fixture.js";
import { createAppState } from "../helpers/app-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { connectLoopbackNode, loopbackLink, SEEDED_NODE_ID, stopLoopbackNode } from "../helpers/loopback-node.js";
import { scriptContext } from "../helpers/script-context.js";

describe("ui.openFile", () => {
  useTestDb();

  /** The caller works in `checkout` on the seeded node; "Mac mini" is a second node. Both nodes share this
   * machine's filesystem. `opened` holds the `open_file` messages broadcast. */
  async function callerAndMini() {
    const state = createAppState();
    const checkout = mkdtempSync(join(tmpdir(), "reins-open-checkout-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "reins-open-elsewhere-"));
    const project = createProject("Files", checkout);
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('mini', 'Mac mini')");
    connectLoopbackNode(state);
    connectLoopbackNode(state, { nodeId: "mini" });
    await loopbackLink(state).ready();
    await loopbackLink(state, "mini").ready();
    const opened: unknown[] = [];
    state.process.clients.add({ ws: { send: data => { const message = JSON.parse(data); if (message.type === "open_file") opened.push(message); return 0; } } });
    const ctx = scriptContext(state, { sessionId: "caller", projectId: project.id });
    return {
      checkout,
      elsewhere,
      projectId: project.id,
      opened,
      script: (code: string) => runScript(ctx, code),
      async stop() {
        await stopLoopbackNode(state);
        await stopLoopbackNode(state, "mini");
        await state.nodes.close();
        rmSync(checkout, { recursive: true, force: true });
        rmSync(elsewhere, { recursive: true, force: true });
      },
    };
  }

  test("opens a file on another node in its directory there", async () => {
    const { elsewhere, projectId, opened, script, stop } = await callerAndMini();
    try {
      writeFileSync(join(elsewhere, "report.html"), "<p>hi</p>");

      const result = await script(`return await api.ui.openFile(${JSON.stringify(join(elsewhere, "report.html"))}, { node: "mac mini", startLine: 1, endLine: 1 });`);

      expect(result).toMatchObject({ ok: true, text: "File opened" });
      expect(opened).toEqual([{
        type: "open_file",
        sessionId: "caller",
        projectId,
        source: { nodeId: "mini", path: elsewhere },
        path: "report.html",
        startLine: 1,
        endLine: 1,
      }]);
    } finally { await stop(); }
  });

  test("opens a file under the caller's checkout in the checkout, named absolutely or relative to it", async () => {
    const { checkout, opened, script, stop } = await callerAndMini();
    try {
      mkdirSync(join(checkout, "src"));
      writeFileSync(join(checkout, "src", "app.ts"), "export {}");

      await script(`await api.ui.openFile(${JSON.stringify(join(checkout, "src", "app.ts"))});`);
      await script(`await api.ui.openFile("src/app.ts", { node: "current" });`);

      const shown = { source: { nodeId: SEEDED_NODE_ID, path: checkout }, path: "src/app.ts" };
      expect(opened).toEqual([expect.objectContaining(shown), expect.objectContaining(shown)]);
    } finally { await stop(); }
  });

  test("fails for a file missing on the node, opening nothing", async () => {
    const { elsewhere, opened, script, stop } = await callerAndMini();
    try {
      const missing = join(elsewhere, "missing.html");

      const result = await script(`return await api.ui.openFile(${JSON.stringify(missing)}, { node: "mini" });`);

      expect(result).toEqual({ ok: false, error: expect.stringContaining(`File not found on Mac mini: ${missing}`) });
      expect(opened).toEqual([]);
    } finally { await stop(); }
  });
});
