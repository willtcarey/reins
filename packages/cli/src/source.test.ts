import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { lastLine, reins } from "./testing/reins.js";

const servers: { stop(force?: boolean): unknown }[] = [];
const temps: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway server answering `respond`, recording what it was asked. */
function fakeServer(respond: (request: Request) => Response | Promise<Response>) {
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
  const dir = mkdtempSync(join(tmpdir(), "reins-source-"));
  temps.push(dir);
  writeFileSync(join(dir, "node.json"), JSON.stringify({ version: 1, serverUrl, nodeId, keyPath: join(dir, "keys", `${nodeId}.pem`) }));
  return dir;
}

const addition = z.object({ nodeId: z.string(), path: z.string() });
const added = (nodeId: string, path: string) => Response.json({ id: 9, nodeId, nodeName: nodeId, connected: true, path }, { status: 201 });

test("source add adds a source of the project on the node named, or on this machine's node with the path resolved here", async () => {
  const server = fakeServer(async request => { const { nodeId, path } = addition.parse(await request.json()); return added(nodeId, path); });
  const env = { REINS_NODE_DATA_DIR: pairedHome(server.url, "laptop") };

  const named = await reins(["source", "add", "/srv/app", "--project", "3", "--node", "desktop"], env);
  expect({ exitCode: named.exitCode, last: lastLine(named.stdout) }).toEqual({ exitCode: 0, last: "Source added to project 3 on node desktop: /srv/app" });
  const here = await reins(["source", "add", "app", "--project", "3"], env);
  expect({ exitCode: here.exitCode, last: lastLine(here.stdout) }).toEqual({ exitCode: 0, last: `Source added to project 3 on node laptop: ${resolve("app")}` });

  expect(server.requests).toEqual([
    { method: "POST", path: "/api/projects/3/sources", body: JSON.stringify({ nodeId: "desktop", path: "/srv/app" }) },
    { method: "POST", path: "/api/projects/3/sources", body: JSON.stringify({ nodeId: "laptop", path: resolve("app") }) },
  ]);
});

test("source add needs a project, and an absolute path for a node named; a refusal exits 1 with the server's message, and no server exits 5", async () => {
  const refusing = fakeServer(() => Response.json({ error: "Directory does not exist: /srv/missing" }, { status: 400 }));

  expect((await reins(["source", "add", "/srv/app", "--node", "desktop", "--server", refusing.url])).exitCode).toBe(2);
  expect((await reins(["source", "add", "/srv/app", "--project", "three", "--server", refusing.url])).exitCode).toBe(2);
  expect((await reins(["source", "add", "app", "--project", "3", "--node", "desktop", "--server", refusing.url])).exitCode).toBe(2);
  expect(refusing.requests).toEqual([]);

  const refused = await reins(["source", "add", "/srv/missing", "--project", "3", "--node", "desktop", "--server", refusing.url]);
  expect({ exitCode: refused.exitCode, last: lastLine(refused.stderr) }).toEqual({
    exitCode: 1, last: `Not added: ${refusing.url} answered 400: Directory does not exist: /srv/missing`,
  });

  const gone = fakeServer(() => new Response());
  servers.pop()!.stop(true);
  expect((await reins(["source", "add", "/srv/app", "--project", "3", "--node", "desktop", "--server", gone.url])).exitCode).toBe(5);
});

/** A node as `GET /api/nodes` lists it, with its sources as [path, project ID, project name]. */
const nodeView = (id: string, sources: Array<[string, number, string]>) => ({
  id, name: id, connected: true, paired: true, hostname: null, pairedAt: null, revokedAt: null, build: null,
  sources: sources.map(([path, projectId, name]) => ({ path, project: { id: projectId, name, sourceId: 1 } })),
});

test("source list prints every source with its node and project, or those of the project or node named", async () => {
  const server = fakeServer(() => Response.json([nodeView("desktop", [["/srv/api", 2, "Api"], ["/srv/app", 3, "App"]]), nodeView("laptop", [["/home/me/app", 3, "App"]])]));
  const list = async (...args: string[]) => (await reins(["source", "list", "--server", server.url, ...args])).stdout;

  expect(await list()).toBe("desktop\t/srv/api\tApi (project 2)\ndesktop\t/srv/app\tApp (project 3)\nlaptop\t/home/me/app\tApp (project 3)\n");
  expect(await list("--project", "3")).toBe("desktop\t/srv/app\tApp (project 3)\nlaptop\t/home/me/app\tApp (project 3)\n");
  expect(await list("--node", "laptop")).toBe("laptop\t/home/me/app\tApp (project 3)\n");
  expect(await list("--node", "nowhere")).toBe("No sources.\n");
});
