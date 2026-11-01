import { afterEach, describe, expect, test } from "bun:test";
import type { McpApi } from "@backend/extensions/mcp/api.js";
import type { McpServerView } from "@backend/extensions/mcp/servers.js";
import { SettingsMcpServersSection } from "../../../extensions/mcp/mcp-servers-section.js";
import { Loadable } from "../../../helpers/loadable.js";
import { McpServersStore } from "../../../extensions/mcp/mcp-servers-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";
import { testElement } from "../../helpers/test-dom.js";
import { registerMcp } from "../../../extensions/mcp/index.js";
import { clickButton, collectTemplateProperties, submitDialog, templateToString, typeIntoField } from "../../helpers/lit-template.js";
import { setConfirmHostForTesting } from "../../../ui/confirm-dialog.js";

const originalHtmlInputElement = globalThis.HTMLInputElement;
const originalHtmlTextAreaElement = globalThis.HTMLTextAreaElement;
const originalLocation = globalThis.location;
const originalOpen = globalThis.open;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

class TestInputElement extends EventTarget {
  value = "";
}

afterEach(() => {
  restoreFetch();
  setConfirmHostForTesting(null);
  Reflect.set(globalThis, "HTMLInputElement", originalHtmlInputElement);
  Reflect.set(globalThis, "HTMLTextAreaElement", originalHtmlTextAreaElement);
  Reflect.set(globalThis, "location", originalLocation);
  Reflect.set(globalThis, "open", originalOpen);
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

/** A document for the error toast, in case no earlier test made the toast container. */
function stubToasts() {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ add() {} }), body: { appendChild() {} } },
  });
}

function server(overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    id: 1, name: "executor", instructions: "Brand New Box tools", url: "https://executor.example/mcp", transport: "http", authKind: "oauth",
    headerName: null, hasHeaderValue: false, oauthClientId: null, hasClientSecret: false, oauthScope: null, enabled: true,
    signedIn: true, status: { state: "ready" }, createdAt: "2026-10-28 10:00:00", updatedAt: "2026-10-28 10:00:00",
    ...overrides,
  };
}

/** The section's text as a user reads it: markup stripped, whitespace collapsed. */
function visibleText(section: SettingsMcpServersSection): string {
  return templateToString(section.render()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** The section with each server's action menu open: its items are rendered only then. */
function withMenus(section: SettingsMcpServersSection): unknown[] {
  const rendered = section.render();
  const menus = collectTemplateProperties(rendered, "content").map(content => typeof content === "function" ? content() : null);
  return [rendered, ...menus];
}

/** The items of the servers' action menus, as a user reads them. */
function menuText(section: SettingsMcpServersSection): string {
  return templateToString(withMenus(section).slice(1)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

const MCP = { name: "mcp", label: "MCP" };

/** The section listing `servers`, over the MCP extension's SDK (whose `client` sends its messages). */
function sectionListing(servers: McpServerView[], sdk = testSdk<McpApi>({ extension: MCP })): SettingsMcpServersSection {
  const store = new McpServersStore(sdk.reins);
  store.servers = Loadable.idle<McpServerView[]>().asLoaded(servers);
  const section = new SettingsMcpServersSection();
  section.store = store;
  return section;
}

function recordRequests(respond: (url: string, init?: RequestInit) => Response | Promise<Response>): Array<{ request: string; body: unknown }> {
  const requests: Array<{ request: string; body: unknown }> = [];
  mockFetch((url, init) => {
    requests.push({ request: `${init?.method ?? "GET"} ${url}`, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return respond(url, init);
  });
  return requests;
}

/** The window `open` returns: what the section does with it is what a user sees in it. */
class FakePopup {
  location = { href: "about:blank" };
  opener: unknown = {};
  closed = false;
  close() {
    this.closed = true;
  }
}

function openReturning(popup: FakePopup | null): Array<{ url: string; target: string; features: string }> {
  const opened: Array<{ url: string; target: string; features: string }> = [];
  Reflect.set(globalThis, "open", (url: string, target: string, features: string) => {
    opened.push({ url, target, features });
    return popup;
  });
  return opened;
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i++) await Bun.sleep(1);
}

describe("SettingsMcpServersSection", () => {
  test("shows each server's status and what can be done about it", () => {
    const connected = sectionListing([server()]);
    expect(visibleText(connected)).toContain("executor oauth Disable executor Brand New Box tools https://executor.example/mcp ready Tools");
    expect(menuText(connected)).toBe("Test Edit Sign out Remove");

    const signedOut = sectionListing([server({ signedIn: false, status: { state: "needs_sign_in" } })]);
    expect(visibleText(signedOut)).toContain("executor oauth Sign in Disable executor");
    expect(visibleText(signedOut)).toContain("needs sign-in");
    expect(menuText(signedOut)).toBe("Edit Remove");

    const failing = sectionListing([server({ authKind: "none", signedIn: false, status: { state: "error", message: "The server answered HTTP 502" } })]);
    expect(visibleText(failing)).toContain("executor no auth Disable executor");
    expect(visibleText(failing)).toContain("error Tools The server answered HTTP 502");
    expect(menuText(failing)).toBe("Test Edit Remove");

    const disabled = sectionListing([server({ enabled: false, status: { state: "disabled" } })]);
    expect(visibleText(disabled)).toContain("executor oauth Enable executor");
    expect(visibleText(disabled)).not.toContain("Tools");
    expect(menuText(disabled)).toBe("Edit Sign out Remove");

    const legacy = sectionListing([server({ transport: "sse" })]);
    expect(visibleText(legacy)).toContain("executor oauth sse Disable executor");
  });

  test("adding a header server sends its header name and value and the transport chosen under Advanced, and lists it", async () => {
    Reflect.set(globalThis, "HTMLInputElement", TestInputElement);
    const created = server({ id: 2, name: "keyed", authKind: "header", headerName: "X-Api-Key", hasHeaderValue: true, signedIn: false, status: { state: "ready" } });
    const requests = recordRequests(() => Response.json(created, { status: 201 }));
    const section = sectionListing([server()]);

    clickButton(section.render(), "Add MCP server");
    typeIntoField(section.render(), "Name", "keyed", new TestInputElement());
    typeIntoField(section.render(), "URL", "https://keyed.example/mcp", new TestInputElement());
    clickButton(section.render(), "Header");
    typeIntoField(section.render(), "Header name", "X-Api-Key", new TestInputElement());
    typeIntoField(section.render(), "Header value", "s3cret", new TestInputElement());
    clickButton(section.render(), "Advanced");
    clickButton(section.render(), "HTTP+SSE (legacy)");
    submitDialog(section.render());

    await until(() => section.store!.servers.data!.length === 2);
    expect(requests).toEqual([{
      request: "POST /api/extensions/mcp/create",
      body: { name: "keyed", instructions: "", url: "https://keyed.example/mcp", transport: "sse", authKind: "header", headerName: "X-Api-Key", headerValue: "s3cret" },
    }]);
    expect(section.store!.servers.data!.map(listed => listed.name)).toEqual(["executor", "keyed"]);
  });

  test("editing a server leaves its secrets out unless new ones are typed", async () => {
    Reflect.set(globalThis, "HTMLInputElement", TestInputElement);
    Reflect.set(globalThis, "HTMLTextAreaElement", TestInputElement);
    Reflect.set(globalThis, "location", { origin: "https://reins.example" });
    const slack = server({ name: "slack", oauthClientId: "app-id", hasClientSecret: true });
    const requests = recordRequests(() => Response.json({ ...slack, instructions: "Workspace.\nAsk before posting." }));
    const section = sectionListing([slack]);

    clickButton(withMenus(section), "Edit");
    expect(visibleText(section)).toContain("its redirect URL is https://reins.example/extensions/mcp/oauth/callback");
    expect(visibleText(section)).toContain("Agents are given these in their system prompt");
    typeIntoField(section.render(), "Instructions", "Workspace.\nAsk before posting.", new TestInputElement());
    submitDialog(section.render());

    await until(() => requests.length === 1 && section.store!.servers.data![0]!.instructions === "Workspace.\nAsk before posting.");
    expect(requests).toEqual([{
      request: "POST /api/extensions/mcp/update",
      body: { id: 1, changes: { name: "slack", instructions: "Workspace.\nAsk before posting.", url: "https://executor.example/mcp", transport: "http", authKind: "oauth", oauthClientId: "app-id", oauthScope: null } },
    }]);
  });

  test("Sign in opens a window in the click, sends it to the authorization page once the server gives it, and waits until signed in", async () => {
    const popup = new FakePopup();
    const opened = openReturning(popup);
    let answer!: (response: Response) => void;
    const requests = recordRequests(() => new Promise<Response>(resolve => { answer = resolve; }));
    const sdk = testSdk<McpApi>({ extension: MCP });
    const section = sectionListing([server({ signedIn: false, status: { state: "needs_sign_in" } })], sdk);

    clickButton(section.render(), "Sign in");

    expect(opened).toEqual([{ url: "", target: "_blank", features: "popup,width=520,height=720" }]);
    expect(popup.location.href).toBe("about:blank");
    await until(() => requests.length === 1);
    expect(requests.map(request => request.request)).toEqual(["POST /api/extensions/mcp/signIn"]);

    answer(Response.json({ authorizationUrl: "https://auth.example/authorize?state=abc" }));
    await until(() => popup.location.href !== "about:blank");

    expect(popup.location.href).toBe("https://auth.example/authorize?state=abc");
    expect(popup.opener).toBeNull();
    expect(popup.closed).toBe(false);
    expect(visibleText(section)).toContain("Finish signing in to executor in the window that opened.");

    sdk.client.fireMessage({ type: "extension", extension: "mcp", message: { type: "mcp_server_updated", server: server() } });

    expect(visibleText(section)).not.toContain("Finish signing in");
    expect(visibleText(section)).toContain("ready Tools");
    expect(menuText(section)).toContain("Sign out");
  });

  test("a sign-in the server refuses closes the window it opened", async () => {
    stubToasts();
    const popup = new FakePopup();
    openReturning(popup);
    recordRequests(() => Response.json({ error: "The server has no OAuth metadata" }, { status: 502 }));
    const section = sectionListing([server({ signedIn: false, status: { state: "needs_sign_in" } })]);

    clickButton(section.render(), "Sign in");
    await until(() => popup.closed);

    expect(popup.closed).toBe(true);
    expect(popup.location.href).toBe("about:blank");
    expect(visibleText(section)).not.toContain("Finish signing in");
  });

  test("when the browser blocks the window, the sign-in page is a link", async () => {
    const opened = openReturning(null);
    recordRequests(() => Response.json({ authorizationUrl: "https://auth.example/authorize?state=abc" }));
    const section = sectionListing([server({ signedIn: false, status: { state: "needs_sign_in" } })]);

    clickButton(section.render(), "Sign in");
    await until(() => section.store!.signIn !== null);

    expect(opened).toHaveLength(1);
    expect(visibleText(section)).toContain("Finish signing in to executor in the window that opened. Open the sign-in page");
    expect(templateToString(section.render())).toContain("href=https://auth.example/authorize?state=abc");
  });

  test("the tools expand into their names and descriptions, listed when shown", async () => {
    const requests = recordRequests(() => Response.json([{ name: "search", description: "Finds tools", inputSchema: { type: "object" } }]));
    const sdk = testSdk<McpApi>({ extension: MCP });
    const section = sectionListing([server()], sdk);

    clickButton(section.render(), "Tools");
    await until(() => visibleText(section).includes("search"));
    expect(visibleText(section)).toContain("search Finds tools");

    sdk.client.fireMessage({ type: "extension", extension: "mcp", message: { type: "mcp_server_updated", server: server({ instructions: "Changed" }) } });
    clickButton(section.render(), "Tools");
    expect(visibleText(section)).not.toContain("search");
    clickButton(section.render(), "Tools");
    await until(() => visibleText(section).includes("search"));

    expect(requests.map(request => request.request)).toEqual(["POST /api/extensions/mcp/tools", "POST /api/extensions/mcp/tools"]);
  });

  test("a long tool description is cut to 3 lines until Show more", async () => {
    const long = "Runs code. ".repeat(30);
    recordRequests(() => Response.json([
      { name: "execute", description: long, inputSchema: { type: "object" } },
      { name: "search", description: "Finds tools", inputSchema: { type: "object" } },
    ]));
    const section = sectionListing([server()]);

    clickButton(section.render(), "Tools");
    await until(() => visibleText(section).includes("execute"));
    expect(templateToString(section.render())).toContain("line-clamp-3");
    expect(visibleText(section)).toContain("Show more search Finds tools");

    clickButton(section.render(), "Show more");

    expect(templateToString(section.render())).not.toContain("line-clamp-3");
    clickButton(section.render(), "Show less");
    expect(templateToString(section.render())).toContain("line-clamp-3");
  });

  test("Test connects afresh, shows that it is testing, then the result and the tools shown listed again", async () => {
    let answer!: (response: Response) => void;
    const requests = recordRequests((url) => url.endsWith("/test")
      ? new Promise<Response>(resolve => { answer = resolve; })
      : Response.json([{ name: "search", description: "Finds tools", inputSchema: { type: "object" } }]));
    const section = sectionListing([server({ authKind: "none", signedIn: false, status: { state: "error", message: "The server answered HTTP 502" } })]);
    clickButton(section.render(), "Tools");
    await until(() => requests.length === 1);

    clickButton(withMenus(section), "Test");
    await until(() => requests.length === 2);
    expect(visibleText(section)).toContain("testing… Tools");

    answer(Response.json(server({ authKind: "none", signedIn: false })));
    await until(() => requests.length === 3);

    expect(requests.map(request => request.request)).toEqual(["POST /api/extensions/mcp/tools", "POST /api/extensions/mcp/test", "POST /api/extensions/mcp/tools"]);
    expect(visibleText(section)).toContain("ready Tools");
    expect(visibleText(section)).not.toContain("HTTP 502");
  });

  test("the switch disables a server", async () => {
    const requests = recordRequests(() => Response.json(server({ enabled: false, status: { state: "disabled" } })));
    const section = sectionListing([server()]);

    clickButton(section.render(), "Disable executor");
    await until(() => !section.store!.servers.data![0]!.enabled);

    expect(requests).toEqual([{ request: "POST /api/extensions/mcp/update", body: { id: 1, changes: { enabled: false } } }]);
    expect(visibleText(section)).toContain("Enable executor");
  });

  test("Remove asks first; confirming removes the server", async () => {
    const requests = recordRequests(() => new Response(null, { status: 204 }));
    let answer = false;
    const asked: string[] = [];
    setConfirmHostForTesting({ open: async (options) => { asked.push(options.title); return answer; } });
    const section = sectionListing([server()]);

    clickButton(withMenus(section), "Remove");
    await Bun.sleep(1);
    expect(requests).toEqual([]);

    answer = true;
    clickButton(withMenus(section), "Remove");
    await until(() => section.store!.servers.data!.length === 0);

    expect(asked).toEqual(["Remove executor?", "Remove executor?"]);
    expect(requests).toEqual([{ request: "POST /api/extensions/mcp/remove", body: { id: 1 } }]);
    expect(visibleText(section)).toContain("No MCP servers yet.");
  });

  test("lists the servers again when the connection comes back, as messages sent meanwhile were lost", async () => {
    const requests = recordRequests(() => Response.json([server(), server({ id: 2, name: "vercel" })]));
    const sdk = testSdk<McpApi>({ extension: MCP });
    const section = sectionListing([server()], sdk);

    sdk.client.fireConnection(false);
    sdk.client.fireConnection(true);
    await until(() => section.store!.servers.data!.length === 2);

    expect(requests.map(request => request.request)).toEqual(["POST /api/extensions/mcp/list"]);
    expect(visibleText(section)).toContain("vercel");
  });
});

describe("registerMcp", () => {
  test("gives MCP a Settings page, which lists the servers once shown and stops when it leaves", async () => {
    const requests = recordRequests(() => Response.json([server()]));
    const { reins, client, settingsPages } = testSdk<McpApi>({ extension: MCP });
    registerMcp(reins);
    const target = testElement();

    const mounted = settingsPages.page("mcp")?.settings.mount(target);
    const [shown] = target.childNodes;

    expect(shown).toBeInstanceOf(SettingsMcpServersSection);
    if (!(shown instanceof SettingsMcpServersSection)) return;
    await until(() => shown.store?.servers.data?.length === 1);
    expect(requests.map(request => request.request)).toEqual(["POST /api/extensions/mcp/list"]);

    mounted?.dispose?.();
    client.fireConnection(false);
    client.fireConnection(true);
    await Bun.sleep(1);
    expect(requests).toHaveLength(1);
  });

  test("its disposer takes its page out of Settings", () => {
    const { reins, settingsPages } = testSdk<McpApi>({ extension: MCP });

    registerMcp(reins)();

    expect(settingsPages.page("mcp")).toBeNull();
  });
});
