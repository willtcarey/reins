import { afterEach, expect, test } from "bun:test";
import { reins } from "./testing/reins.js";

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A throwaway server answering `respond`, recording what it was asked. */
function fakeServer(respond: (request: Request) => Response | Promise<Response>) {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.clone().text();
      requests.push(`${request.method} ${new URL(request.url).pathname}${body ? ` ${body}` : ""}`);
      return respond(request);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

/** An extension as `GET /api/installed-extensions` reports it. */
const view = (name: string, overrides: Record<string, unknown> = {}) => ({
  name, status: "loaded", failure: null, source: { kind: "built-in" }, manifest: null, build: null, backendPart: true, errors: [],
  registrations: { tools: null, promptSections: 0, settlementListeners: 0, scriptFunctions: [], httpMethods: [], pages: [] }, services: [], storage: null,
  ...overrides,
});
const spoke = (overrides: Record<string, unknown> = {}) => view("spoke", {
  source: { kind: "path", path: "/home/me/spoke" }, manifest: { label: "Spoke", description: null, version: "0.2.0", icon: null }, ...overrides,
});

test("extension add asks the server to add the directory, as an absolute path, and says whether it loaded", async () => {
  const server = fakeServer(() => Response.json(spoke(), { status: 201 }));

  const result = await reins(["extension", "add", "/home/me/spoke", "--server", server.url]);

  expect(server.requests).toEqual([`POST /api/installed-extensions {"path":"/home/me/spoke"}`]);
  expect(result).toMatchObject({ exitCode: 0, stdout: "Added Spoke (spoke) 0.2.0 from /home/me/spoke: loaded.\n" });
});

test("extension add of one whose files are not built keeps it added, failed, and exits 1 with its error", async () => {
  const server = fakeServer(() => Response.json(spoke({ status: "failed", failure: { stage: "load", message: "Its backend file dist/server.js does not exist: build the extension first" } }), { status: 201 }));

  const result = await reins(["extension", "add", "/home/me/spoke", "--server", server.url]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("Added spoke from /home/me/spoke, but it failed (load): Its backend file dist/server.js does not exist: build the extension first\nFix it, then run: reins extension reload spoke\n");
});

test("extension add of what the server refuses exits 1 with the server's reason", async () => {
  const server = fakeServer(() => Response.json({ error: "An extension named spoke is already added" }, { status: 409 }));

  const result = await reins(["extension", "add", "/home/me/spoke", "--server", server.url]);

  expect(result).toMatchObject({ exitCode: 1, stderr: `Not added: ${server.url} answered 409: An extension named spoke is already added\n` });
});

test("extension list prints each extension, its status and where it came from, and why it failed", async () => {
  const server = fakeServer(() => Response.json([
    view("mcp"),
    view("file-viewer", { status: "disabled", backendPart: false }),
    spoke({ status: "failed", failure: { stage: "load", message: "Its backend file dist/server.js does not exist: build the extension first" } }),
    view("inbox", { source: { kind: "path", path: "/home/me/inbox" }, frontendFailure: { message: "TypeError: x is not a function\n    at register (frontend.js:3:1)", at: "2026-01-01T00:00:00.000Z" } }),
  ]));

  const result = await reins(["extension", "list", "--server", server.url]);

  expect(server.requests).toEqual(["GET /api/installed-extensions"]);

  expect(result.stdout).toBe([
    "mcp\tloaded\tbuilt in",
    "file-viewer\tdisabled\tbuilt in",
    "spoke\tfailed\t/home/me/spoke",
    "  load failed: Its backend file dist/server.js does not exist: build the extension first",
    "inbox\tloaded\t/home/me/inbox",
    "  frontend failed in a browser at 2026-01-01T00:00:00.000Z: TypeError: x is not a function",
    "      at register (frontend.js:3:1)",
  ].join("\n") + "\n");
});

test("extension reload and remove name the extension", async () => {
  const server = fakeServer((request) => request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(spoke()));

  const reloaded = await reins(["extension", "reload", "spoke", "--server", server.url]);
  const removed = await reins(["extension", "remove", "spoke", "--server", server.url]);

  expect(server.requests).toEqual(["POST /api/installed-extensions/spoke/reload", "DELETE /api/installed-extensions/spoke"]);
  expect(reloaded.stdout).toBe("Reloaded Spoke (spoke) 0.2.0: loaded.\n");
  expect(removed.stdout).toBe("Removed spoke. Its data and secrets stay on the server; adding it again finds them.\n");
});

test("extension disable and enable turn the extension off and on, built in or added", async () => {
  const server = fakeServer((request) => request.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json({ error: "No extension named nothing" }, { status: 404 }));

  const disabled = await reins(["extension", "disable", "file-viewer", "--server", server.url]);
  const enabled = await reins(["extension", "enable", "spoke", "--server", server.url]);

  expect(server.requests).toEqual([
    `PATCH /api/installed-extensions/file-viewer {"enabled":false}`,
    `PATCH /api/installed-extensions/spoke {"enabled":true}`,
  ]);
  expect(disabled.stdout).toBe("Turned off file-viewer. Browsers drop it now; it stays off until you turn it on.\n");
  expect(enabled.stdout).toBe("Turned on spoke.\n");
});
