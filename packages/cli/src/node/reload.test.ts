import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastLine, reins } from "../testing/reins.js";

const servers: { stop(force?: boolean): unknown }[] = [];
const temps: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway server answering `respond`, recording what it was asked. */
function fakeServer(respond: (request: Request) => Response | Promise<Response> = () => Response.json({ scheduled: true })) {
  const requests: Array<{ method: string; path: string; body: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({ method: request.method, path: new URL(request.url).pathname, body: await request.clone().text() });
      return respond(request);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, port: String(server.port), requests };
}

/** A node home paired with `serverUrl` as `nodeId`. */
function pairedHome(serverUrl: string, nodeId: string) {
  const dir = mkdtempSync(join(tmpdir(), "reins-node-reload-"));
  temps.push(dir);
  writeFileSync(join(dir, "node.json"), JSON.stringify({ version: 1, serverUrl, nodeId, keyPath: join(dir, "keys", `${nodeId}.pem`), sourceRoots: [] }));
  return dir;
}

const SCHEDULED = "reload scheduled: it restarts once its runs reach a pause point, and they continue on the new code.";

test("on an unpaired machine, asks the local server to reload the local node, or the one named, and exits once it is scheduled", async () => {
  const local = fakeServer();
  const env = { REINS_PORT: local.port };

  const run = await reins(["node", "reload"], env);
  expect({ exitCode: run.exitCode, last: lastLine(run.stdout) }).toEqual({ exitCode: 0, last: `Node internal ${SCHEDULED}` });
  await reins(["node", "reload", "remote", "--force"], env);
  await reins(["node", "reload"], { ...env, REINS_NODE_ID: "configured" });

  expect(local.requests).toEqual([
    { method: "POST", path: "/api/nodes/internal/reload", body: JSON.stringify({ force: false }) },
    { method: "POST", path: "/api/nodes/remote/reload", body: JSON.stringify({ force: true }) },
    { method: "POST", path: "/api/nodes/configured/reload", body: JSON.stringify({ force: false }) },
  ]);
});

test("on a paired machine, reloads this node on its server; --local the local node on the local server; --server the named server", async () => {
  const paired = fakeServer();
  const local = fakeServer();
  const other = fakeServer();
  const env = { REINS_NODE_DATA_DIR: pairedHome(paired.url, "laptop"), REINS_PORT: local.port };

  expect(lastLine((await reins(["node", "reload"], env)).stdout)).toBe(`Node laptop ${SCHEDULED}`);
  await reins(["node", "reload", "--local"], env);
  await reins(["node", "reload", "--server", `${other.url}/`], env);
  await reins(["node", "reload", "remote", `--server=${paired.url}`], env);
  await reins(["node", "reload", "--server", paired.url], env);

  expect(paired.requests.map(request => request.path)).toEqual(["/api/nodes/laptop/reload", "/api/nodes/remote/reload", "/api/nodes/laptop/reload"]);
  expect(local.requests.map(request => request.path)).toEqual(["/api/nodes/internal/reload"]);
  // Another server does not know this node: the default is that server's local node.
  expect(other.requests.map(request => request.path)).toEqual(["/api/nodes/internal/reload"]);
});

test("a refusal exits 1 with the server's message; a server that is not Reins, or none, exits 5", async () => {
  const refusing = fakeServer(() => Response.json({ error: "Node internal is not connected" }, { status: 503 }));
  const refused = await reins(["node", "reload"], { REINS_PORT: refusing.port });
  expect({ exitCode: refused.exitCode, last: lastLine(refused.stderr) }).toEqual({ exitCode: 1, last: `Node internal did not reload: http://localhost:${refusing.port} answered 503: Node internal is not connected` });

  // A server that predates the endpoint answers its web app.
  const html = fakeServer(() => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }));
  const notReins = await reins(["node", "reload", "--server", html.url]);
  expect(notReins.exitCode).toBe(5);
  expect(lastLine(notReins.stderr)).toStartWith(`Node internal did not reload: ${html.url} answered 200: POST /api/nodes/internal/reload answered 200 without JSON`);

  const gone = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = String(gone.port);
  gone.stop(true);
  const none = await reins(["node", "reload"], { REINS_PORT: port });
  expect(none.exitCode).toBe(5);
  expect(lastLine(none.stderr)).toStartWith(`Node internal did not reload: http://localhost:${port} did not answer: `);
});

test("a --server that is not an http(s) URL is a usage error, and nothing is asked", async () => {
  const local = fakeServer();

  const run = await reins(["node", "reload", "--server", "ftp://s3cret.example"], { REINS_PORT: local.port });

  expect({ exitCode: run.exitCode, last: lastLine(run.stderr) }).toEqual({ exitCode: 2, last: "The server URL must be an http:// or https:// URL." });
  expect(run.output).not.toContain("s3cret");
  expect(local.requests).toEqual([]);
});
