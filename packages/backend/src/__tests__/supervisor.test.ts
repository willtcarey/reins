import { expect, test } from "bun:test";
import { createServices, NODE_RESTART } from "../supervisor.js";

test("start and dev both run the server and a node that is restarted only when it exits, never watched for code changes", () => {
  for (const mode of ["start", "dev"] as const) {
    const services = createServices(mode, "/repo");
    const server = services.find(service => service.name === "server")!;
    const node = services.find(service => service.name === "node")!;
    expect(server.onExit).toBe("stop-all");
    expect(server.command.at(-1)).toBe(mode === "dev" ? "packages/backend/dev.ts" : "packages/backend/src/index.ts");
    expect(node.command).toEqual([process.execPath, "packages/node/src/main.ts"]);
    expect(node.onExit).toEqual({ restart: NODE_RESTART });
    expect(node.env).toBeUndefined();
  }
  expect(createServices("start", "/repo").map(service => service.name)).toEqual(["server", "node"]);
});
