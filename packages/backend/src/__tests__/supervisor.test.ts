import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices, NODE_REFUSED_EXIT_CODE, NODE_RELOAD_EXIT_CODE, NODE_RESTART, runSupervisor, SERVER_RESTART_EXIT_CODE, type Service } from "../supervisor.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("start and dev both run a server that stops everything unless it exits to be restarted alone, and a node that is restarted only when it exits, never watched for code changes; each is told the exit codes that restart it at once, the node also the one that leaves it stopped", () => {
  for (const mode of ["start", "dev"] as const) {
    const services = createServices(mode, "/repo");
    const server = services.find(service => service.name === "server")!;
    const node = services.find(service => service.name === "node")!;
    expect(server.onExit).toBe("stop-all");
    expect(server.restartAtOnceOn).toEqual({ code: SERVER_RESTART_EXIT_CODE, reason: "restarting" });
    expect(server.env).toEqual({ REINS_SERVER_RESTART_EXIT_CODE: String(SERVER_RESTART_EXIT_CODE) });
    expect(server.command.at(-1)).toBe(mode === "dev" ? "packages/backend/dev.ts" : "packages/backend/src/index.ts");
    expect(node.command).toEqual([process.execPath, "packages/node/src/main.ts"]);
    expect(node.onExit).toEqual({ restart: NODE_RESTART, notRestartedOn: { code: NODE_REFUSED_EXIT_CODE, reason: "refused by the server" } });
    expect(node.restartAtOnceOn).toEqual({ code: NODE_RELOAD_EXIT_CODE, reason: "reloading" });
    expect(node.env).toEqual({ REINS_NODE_RELOAD_EXIT_CODE: String(NODE_RELOAD_EXIT_CODE), REINS_NODE_REFUSED_EXIT_CODE: String(NODE_REFUSED_EXIT_CODE) });
  }
  expect(createServices("start", "/repo").map(service => service.name)).toEqual(["server", "node"]);
});

/** A service running `script` with Bun, which appends a line to `log` each time it starts. */
function scriptedService(name: string, log: string, script: string, rest: Pick<Service, "onExit" | "restartAtOnceOn">): Service {
  const started = `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.pid + "\\n");`;
  return { name, cwd: tmpdir(), command: [process.execPath, "-e", started + script], ...rest };
}
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n");

test("a server exiting with its restart code is started again at once and alone, the node running on as it was; its next exit with another code stops everything with that code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reins-supervisor-"));
  dirs.push(dir);
  const serverLog = join(dir, "server.log");
  const nodeLog = join(dir, "node.log");
  const logged: string[] = [];
  const code = await runSupervisor([
    // First start: wait for the node, then exit to be restarted; second start: exit 3.
    scriptedService("server", serverLog, `
      const fs = require("node:fs");
      const restarted = fs.readFileSync(${JSON.stringify(serverLog)}, "utf8").trim().split("\\n").length > 1;
      const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(nodeLog)})) { clearInterval(wait); process.exit(restarted ? 3 : ${SERVER_RESTART_EXIT_CODE}); } }, 20);
    `, { onExit: "stop-all", restartAtOnceOn: { code: SERVER_RESTART_EXIT_CODE, reason: "restarting" } }),
    scriptedService("node", nodeLog, "setInterval(() => {}, 1000);", { onExit: { restart: NODE_RESTART } }),
  ], "test", message => logged.push(message));

  expect(code).toBe(3);
  expect(lines(serverLog)).toHaveLength(2);
  expect(lines(nodeLog)).toHaveLength(1);
  expect(logged).toContain(`server exited with code ${SERVER_RESTART_EXIT_CODE}`);
  expect(logged).toContain("server restarting");
  expect(logged.filter(line => line.startsWith("started node"))).toHaveLength(1);
  expect(logged).toContain("stopping all services");
});
