import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

const script = join(import.meta.dir, "../node-reload.ts");

/** Runs `bun run node:reload` against a throwaway server answering `respond`. */
async function reload(args: string[], respond: (request: Request) => Response | Promise<Response>) {
  const requests: Array<{ method: string; path: string; body: string }> = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({ method: request.method, path: new URL(request.url).pathname, body: await request.clone().text() });
      return respond(request);
    },
  });
  const child = Bun.spawn([process.execPath, script, ...args], {
    env: { ...process.env, REINS_PORT: String(server.port), REINS_NODE_ID: undefined }, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr, requests };
}

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

describe("node:reload", () => {
  test("asks the server to reload the local node, or the one named, and exits once it is scheduled", async () => {
    const local = await reload([], () => Response.json({ scheduled: true }));
    expect(local).toMatchObject({ exitCode: 0, requests: [{ method: "POST", path: "/api/nodes/internal/reload", body: JSON.stringify({ force: false }) }] });
    expect(local.stdout).toContain("Node internal reload scheduled");

    const named = await reload(["remote", "--force"], () => Response.json({ scheduled: true }));
    expect(named).toMatchObject({ exitCode: 0, requests: [{ path: "/api/nodes/remote/reload", body: JSON.stringify({ force: true }) }] });
  });

  test("fails with the server's refusal, and when the server answers anything but the reload's JSON", async () => {
    const refused = await reload([], () => Response.json({ error: "Node internal is not connected" }, { status: 503 }));
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("Node internal did not reload (503): Node internal is not connected");

    // A server that predates the endpoint answers its web app.
    const html = await reload([], () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }));
    expect(html.exitCode).toBe(1);
    expect(html.stderr).toContain("Node internal did not reload (200): POST /api/nodes/internal/reload answered 200 without JSON");
  });
});
