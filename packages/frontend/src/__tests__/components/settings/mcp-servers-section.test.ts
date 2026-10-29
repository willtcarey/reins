import { afterEach, describe, expect, test } from "bun:test";
import type { McpServerView } from "@backend/models/mcp-servers.js";
import { SettingsMcpServersSection } from "../../../components/settings/mcp-servers-section.js";
import { Loadable } from "../../../helpers/loadable.js";
import { McpServersStore } from "../../../models/stores/mcp-servers-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { StubClient } from "../../helpers/stub-client.js";
import { clickButton, submitDialog, templateToString, typeIntoField } from "../../helpers/lit-template.js";
import { setConfirmHostForTesting } from "../../../ui/confirm-dialog.js";

const originalHtmlInputElement = globalThis.HTMLInputElement;
const originalLocation = globalThis.location;
const originalOpen = globalThis.open;

class TestInputElement extends EventTarget {
  value = "";
}

afterEach(() => {
  restoreFetch();
  setConfirmHostForTesting(null);
  Reflect.set(globalThis, "HTMLInputElement", originalHtmlInputElement);
  Reflect.set(globalThis, "location", originalLocation);
  Reflect.set(globalThis, "open", originalOpen);
});

function server(overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    id: 1, name: "executor", description: "Brand New Box tools", url: "https://executor.example/mcp", transport: "http", authKind: "oauth",
    headerName: null, hasHeaderValue: false, oauthClientId: null, hasClientSecret: false, oauthScope: null, enabled: true,
    signedIn: true, status: { state: "connected" }, toolCount: 2, createdAt: "2026-10-28 10:00:00", updatedAt: "2026-10-28 10:00:00",
    ...overrides,
  };
}

/** The section's text as a user reads it: markup stripped, whitespace collapsed. */
function visibleText(section: SettingsMcpServersSection): string {
  return templateToString(section.render()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function sectionListing(servers: McpServerView[], client?: StubClient): SettingsMcpServersSection {
  const store = new McpServersStore(client);
  store.servers = Loadable.idle<McpServerView[]>().asLoaded(servers);
  const section = new SettingsMcpServersSection();
  section.store = store;
  return section;
}

function recordRequests(respond: (url: string, init?: RequestInit) => Response): Array<{ request: string; body: unknown }> {
  const requests: Array<{ request: string; body: unknown }> = [];
  mockFetch((url, init) => {
    requests.push({ request: `${init?.method ?? "GET"} ${url}`, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return respond(url, init);
  });
  return requests;
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i++) await Bun.sleep(1);
}

describe("SettingsMcpServersSection", () => {
  test("shows each server's status and what can be done about it", () => {
    expect(visibleText(sectionListing([server()]))).toContain("executor oauth connected Sign out Edit Remove Disable executor");
    expect(visibleText(sectionListing([server({ signedIn: false, status: { state: "needs_sign_in" } })]))).toContain("executor oauth needs sign-in Sign in Edit Remove");
    const failing = visibleText(sectionListing([server({ authKind: "none", signedIn: false, status: { state: "error", message: "The server answered HTTP 502" } })]));
    expect(failing).toContain("executor no auth error Connect Edit Remove");
    expect(failing).toContain("The server answered HTTP 502");
    const disabled = visibleText(sectionListing([server({ enabled: false, status: { state: "disabled" } })]));
    expect(disabled).toContain("executor oauth disabled Sign out Edit Remove Enable executor");
    expect(disabled).not.toContain("2 tools");
  });

  test("adding a header server sends its header name and value, and lists it", async () => {
    Reflect.set(globalThis, "HTMLInputElement", TestInputElement);
    const created = server({ id: 2, name: "keyed", authKind: "header", headerName: "X-Api-Key", hasHeaderValue: true, signedIn: false, status: { state: "not_connected" } });
    const requests = recordRequests(() => Response.json(created, { status: 201 }));
    const section = sectionListing([server()]);

    clickButton(section.render(), "Add MCP server");
    typeIntoField(section.render(), "Name", "keyed", new TestInputElement());
    typeIntoField(section.render(), "URL", "https://keyed.example/mcp", new TestInputElement());
    clickButton(section.render(), "Header");
    typeIntoField(section.render(), "Header name", "X-Api-Key", new TestInputElement());
    typeIntoField(section.render(), "Header value", "s3cret", new TestInputElement());
    submitDialog(section.render());

    await until(() => section.store!.servers.data!.length === 2);
    expect(requests).toEqual([{
      request: "POST /api/mcp-servers",
      body: { name: "keyed", description: "", url: "https://keyed.example/mcp", authKind: "header", headerName: "X-Api-Key", headerValue: "s3cret" },
    }]);
    expect(section.store!.servers.data!.map(listed => listed.name)).toEqual(["executor", "keyed"]);
  });

  test("editing a server leaves its secrets out unless new ones are typed", async () => {
    Reflect.set(globalThis, "HTMLInputElement", TestInputElement);
    Reflect.set(globalThis, "location", { origin: "https://reins.example" });
    const slack = server({ name: "slack", oauthClientId: "app-id", hasClientSecret: true });
    const requests = recordRequests(() => Response.json({ ...slack, description: "Workspace" }));
    const section = sectionListing([slack]);

    clickButton(section.render(), "Edit");
    expect(visibleText(section)).toContain("its redirect URL is https://reins.example/oauth/mcp/callback");
    typeIntoField(section.render(), "Description", "Workspace", new TestInputElement());
    submitDialog(section.render());

    await until(() => requests.length === 1 && section.store!.servers.data![0]!.description === "Workspace");
    expect(requests).toEqual([{
      request: "PATCH /api/mcp-servers/1",
      body: { name: "slack", description: "Workspace", url: "https://executor.example/mcp", authKind: "oauth", oauthClientId: "app-id", oauthScope: null },
    }]);
  });

  test("Sign in opens the authorization page in a window and waits until the server says it is signed in", async () => {
    const opened: string[] = [];
    Reflect.set(globalThis, "open", (url: string) => { opened.push(url); return null; });
    const requests = recordRequests(() => Response.json({ authorizationUrl: "https://auth.example/authorize?state=abc" }));
    const client = new StubClient();
    const needsSignIn = server({ signedIn: false, status: { state: "needs_sign_in" } });
    const section = sectionListing([needsSignIn], client);

    clickButton(section.render(), "Sign in");
    await until(() => opened.length === 1);

    expect(requests.map(request => request.request)).toEqual(["POST /api/mcp-servers/1/sign-in"]);
    expect(opened).toEqual(["https://auth.example/authorize?state=abc"]);
    expect(visibleText(section)).toContain("Finish signing in to executor in the window that opened.");

    client.fireMessage({ type: "mcp_server_updated", server: server() });

    expect(visibleText(section)).not.toContain("Finish signing in");
    expect(visibleText(section)).toContain("executor oauth connected Sign out");
  });

  test("the tools expand into their names and descriptions, listed again when the server's tools change", async () => {
    let tools = [{ name: "search", description: "Finds tools", inputSchema: { type: "object" } }];
    const requests = recordRequests(() => Response.json(tools));
    const client = new StubClient();
    const section = sectionListing([server({ toolCount: 1 })], client);

    clickButton(section.render(), "1 tool");
    await until(() => visibleText(section).includes("search"));
    expect(visibleText(section)).toContain("search Finds tools");

    tools = [...tools, { name: "execute", description: "Runs code", inputSchema: { type: "object" } }];
    client.fireMessage({ type: "mcp_server_updated", server: server({ toolCount: 2 }) });
    await until(() => visibleText(section).includes("execute"));

    expect(visibleText(section)).toContain("search Finds tools execute Runs code");
    expect(requests.map(request => request.request)).toEqual(["GET /api/mcp-servers/1/tools", "GET /api/mcp-servers/1/tools"]);
  });

  test("the switch disables a server", async () => {
    const requests = recordRequests(() => Response.json(server({ enabled: false, status: { state: "disabled" } })));
    const section = sectionListing([server()]);

    clickButton(section.render(), "Disable executor");
    await until(() => !section.store!.servers.data![0]!.enabled);

    expect(requests).toEqual([{ request: "PATCH /api/mcp-servers/1", body: { enabled: false } }]);
    expect(visibleText(section)).toContain("Enable executor");
  });

  test("Remove asks first; confirming removes the server", async () => {
    const requests = recordRequests(() => new Response(null, { status: 204 }));
    let answer = false;
    const asked: string[] = [];
    setConfirmHostForTesting({ open: async (options) => { asked.push(options.title); return answer; } });
    const section = sectionListing([server()]);

    clickButton(section.render(), "Remove");
    await Bun.sleep(1);
    expect(requests).toEqual([]);

    answer = true;
    clickButton(section.render(), "Remove");
    await until(() => section.store!.servers.data!.length === 0);

    expect(asked).toEqual(["Remove executor?", "Remove executor?"]);
    expect(requests).toEqual([{ request: "DELETE /api/mcp-servers/1", body: undefined }]);
    expect(visibleText(section)).toContain("No MCP servers yet.");
  });
});
