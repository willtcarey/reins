import { afterEach, expect, test } from "bun:test";
import { reins } from "./testing/reins.js";

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
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

/** A node as `GET /api/nodes` lists it, with its sources in use as [path, its projects as [ID, name]]. */
const nodeView = (id: string, sources: Array<[string, Array<[number, string]>]>) => ({
  id, name: id, connected: true, paired: true, hostname: null, pairedAt: null, revokedAt: null, build: null,
  sources: sources.map(([path, projects], index) => ({ id: index + 1, path, projects: projects.map(([projectId, name]) => ({ id: projectId, name })) })),
});

test("source list prints every source in use with its node and the projects using it, or those of the project or node named", async () => {
  const server = fakeServer(() => Response.json([
    nodeView("desktop", [["/srv/api", [[2, "Api"]]], ["/srv/shared", [[2, "Api"], [3, "App"]]], ["/srv/scratch", []]]),
    nodeView("laptop", [["/home/me/app", [[3, "App"]]]]),
  ]));
  const list = async (...args: string[]) => (await reins(["source", "list", "--server", server.url, ...args])).stdout;

  expect(await list()).toBe([
    "desktop\t/srv/api\tApi (project 2)",
    "desktop\t/srv/shared\tApi (project 2), App (project 3)",
    "desktop\t/srv/scratch\tno project",
    "laptop\t/home/me/app\tApp (project 3)",
  ].join("\n") + "\n");
  expect(await list("--project", "3")).toBe("desktop\t/srv/shared\tApi (project 2), App (project 3)\nlaptop\t/home/me/app\tApp (project 3)\n");
  expect(await list("--node", "laptop")).toBe("laptop\t/home/me/app\tApp (project 3)\n");
  expect(await list("--node", "nowhere")).toBe("No sources.\n");
});
