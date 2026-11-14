import { afterEach, describe, expect, test } from "bun:test";
import type { Source } from "@reins/sdk";
import type { McpApi } from "@backend/extensions/mcp/api.js";
import type { McpSessionServersView, McpRepoHttpServerView, McpRepoStdioServerView } from "@backend/extensions/mcp/repo-servers.js";
import { registerMcpSessionServers } from "../../../extensions/mcp/session-servers.js";
import type { McpRemoteServerView } from "@backend/extensions/mcp/servers.js";
import { McpRepoServers } from "../../../extensions/mcp/repo-servers-list.js";
import { McpOwnServers } from "../../../extensions/mcp/own-servers-list.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { paneContext, testSdk } from "../../helpers/reins-sdk.js";
import { testElement } from "../../helpers/test-dom.js";
import { makeProject } from "../../helpers/fixtures.js";
import { clickButton, templateToString } from "../../helpers/lit-template.js";

const MCP = { name: "mcp", label: "MCP" };

const sessionShown = (sessionId: string) => ({ view: { view: "session", sessionId }, subject: [{ type: "session" as const, id: sessionId }] });
const text = (rendered: unknown) => templateToString(rendered).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const OFF = { state: "off" as const, message: "MCP server shopify-dev is off" };
const stdio = (overrides: Partial<McpRepoStdioServerView> = {}): McpRepoStdioServerView => ({
  id: 4, projectId: 7, name: "shopify-dev", transport: "stdio", enabled: true, allowed: true, status: { state: "ready" }, variables: [],
  version: { command: "npx", args: ["-y", "@shopify/dev-mcp@latest"], cwd: null, envNames: [] }, changed: false,
  ...overrides,
});
const stripe = (overrides: Partial<McpRepoHttpServerView> = {}): McpRepoHttpServerView => ({
  id: 5, projectId: 7, name: "stripe", transport: "http", enabled: true, allowed: true, status: { state: "needs_sign_in" }, variables: [],
  url: "https://mcp.stripe.com", authKind: "oauth", headerNames: [], signedIn: false, ...overrides,
});
const listing = (servers: McpSessionServersView["servers"]): McpSessionServersView => ({
  projectId: 7,
  file: { state: "read", error: null, sessionId: "s1", readAt: "2026-11-12T10:00:00.000Z" },
  servers,
  skipped: [{ name: "Bad_Name", reason: "Its name must start with a lowercase letter" }],
});

const vercel = (overrides: Partial<McpRemoteServerView> = {}): McpRemoteServerView => ({
  id: 1, name: "vercel", instructions: "", url: "https://mcp.vercel.com", transport: "http", authKind: "oauth",
  headerName: null, hasHeaderValue: false, oauthClientId: null, hasClientSecret: false, oauthScope: null, enabled: true,
  signedIn: true, status: { state: "ready" }, createdAt: "2026-10-28 10:00:00", updatedAt: "2026-10-28 10:00:00", ...overrides,
});

/** Answers each method as given, recording every call. */
function backend(answers: { view?: McpSessionServersView | null; own?: McpRemoteServerView[] }) {
  const calls: Array<{ method: string; body: unknown }> = [];
  mockFetch((url, init) => {
    const method = String(url).split("/").at(-1)!;
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "sessionServers") return Response.json(answers.view);
    if (method === "list") return Response.json(answers.own ?? []);
    if (method === "tools" && !(init?.body && "sessionId" in JSON.parse(String(init.body)))) return Response.json([]);
    if (method === "update") return Response.json({ ...answers.own?.[0], enabled: false, status: { state: "disabled" } });
    if (method === "tools") return Response.json([{ name: "search_docs", description: "Searches shopify.dev", inputSchema: { type: "object" } }]);
    if (method === "signIn") return Response.json({ authorizationUrl: "https://auth.example/authorize?state=1", callbackUrl: "https://reins.example/callback" });
    return new Response(null, { status: 204 });
  });
  return calls;
}

afterEach(() => { restoreFetch(); });

/** An SDK whose sessions `s1`–`s3` are on the main checkout and `s4`–`s5` on a task's worktree. */
function mcpSdk(options: Parameters<typeof testSdk>[0] = {}) {
  const sdk = testSdk<McpApi>({ extension: MCP, ...options });
  sdk.projectsStore.projects = [makeProject(7, "Merchtable")];
  for (const [id, source] of [["s1", main], ["s2", main], ["s3", main], ["s4", task], ["s5", task]] as const) {
    sdk.sessions.set(id, { projectId: 7, placement: { available: true, removed: false, nodeId: source.nodeId, nodeName: "Node", path: source.path } });
  }
  return sdk;
}
const main: Source = { nodeId: "node", path: "/work" };
const task: Source = { nodeId: "node", path: "/work/.worktrees/task-1" };
const listOf = (source: Source, sessionId: string) => ({ view: "mcp-servers" as const, source, sessionId });

/** The pane mounted for `view`, and its two sections, the `.mcp.json`'s first. */
function mountPane(sdk: ReturnType<typeof mcpSdk>, view: ReturnType<typeof listOf>) {
  registerMcpSessionServers(sdk.reins);
  const renderer = sdk.views.rendererFor(view);
  const target = testElement();
  renderer?.pane?.mount(target, view, paneContext("inspector"));
  const sections = [...target.childNodes].flatMap(node => [...node.childNodes]);
  const repo = sections.find(node => node instanceof McpRepoServers)!;
  const own = sections.find(node => node instanceof McpOwnServers)!;
  return { renderer, sections, repo, own };
}

describe("a session's MCP servers list in the Inspector", () => {
  test("/mcp opens it for the session shown; nothing opens it by itself", async () => {
    backend({});
    const sdk = mcpSdk({ current: sessionShown("s4") });
    registerMcpSessionServers(sdk.reins);
    sdk.showMain(sessionShown("s3"));
    await Bun.sleep(0);
    const byItself = [...sdk.opened];

    await sdk.commands.run(sdk.commands.invocation("/mcp")!);

    expect(byItself).toEqual([]);
    expect(sdk.opened).toEqual([{ view: listOf(main, "s3"), container: "inspector" }]);
  });

  test("is one tab per checkout, and follows the session shown on its checkout", async () => {
    backend({ view: listing([]) });
    const sdk = mcpSdk({ current: sessionShown("s1") });
    const view = listOf(main, "s1");
    const { renderer, repo: list } = mountPane(sdk, view);

    sdk.showMain(sessionShown("s2"));
    await Bun.sleep(0);
    const onSameCheckout = list.sessionId;
    sdk.showMain(sessionShown("s4"));
    await Bun.sleep(0);

    expect(renderer?.key?.(listOf(main, "s2"))).toBe(renderer?.key?.(view));
    expect(renderer?.key?.(listOf(task, "s4"))).not.toBe(renderer?.key?.(view));
    expect(onSameCheckout).toBe("s2");
    expect(list.sessionId).toBe("s2");
  });

  test("shows the project's servers under its name first, then the global ones as Settings draws them, whose header goes to Settings", async () => {
    const calls = backend({ view: listing([stripe()]), own: [vercel()] });
    const sdk = mcpSdk({ current: sessionShown("s1") });
    const { sections, repo, own } = mountPane(sdk, listOf(main, "s1"));
    await repo.load();
    await Bun.sleep(0);

    const ownText = text(own.render());
    clickButton(own.render(), "Tools");
    await Bun.sleep(0);
    clickButton(own.render(), "Turn off vercel");
    clickButton(own.render(), "Edit in Settings");
    await Bun.sleep(0);

    expect(sections.indexOf(repo)).toBeLessThan(sections.indexOf(own));
    expect(text(repo.render())).toMatch(/^Merchtable stripe oauth Sign in/);
    expect(ownText).toBe("Global Edit in Settings vercel oauth Sign out Turn off vercel https://mcp.vercel.com ready Tools");
    expect(calls.find(call => call.method === "tools")?.body).toEqual({ id: 1 });
    expect(calls.find(call => call.method === "update")?.body).toEqual({ id: 1, changes: { enabled: false } });
    expect(sdk.mainHistory.at(-1)).toBe("#/settings/extensions/mcp");
  });

  test("a session of no project shows only the user's own servers", async () => {
    backend({ view: null, own: [vercel()] });
    const sdk = mcpSdk({ current: sessionShown("s1") });
    const { repo } = mountPane(sdk, listOf(main, "s1"));
    await repo.load();

    expect(text(repo.render())).toBe("");
  });
});

describe("the list of a .mcp.json's servers", () => {
  const list = async (view: McpSessionServersView) => {
    const calls = backend({ view });
    const element = new McpRepoServers();
    element.reins = testSdk<McpApi>({ extension: MCP }).reins;
    element.sessionId = "s1";
    await element.load();
    return { element, calls };
  };

  test("badges and shows each server as the settings page does: its kind, its command or URL, its status and its toggle; and the entries skipped with why", async () => {
    const { element } = await list(listing([
      stdio({ allowed: false, status: OFF }),
      stripe(),
      stripe({ id: 6, name: "docs", transport: "sse", status: { state: "ready" }, signedIn: true }),
    ]));

    const shown = templateToString(element.render());

    expect(text(element.render())).toContain("shopify-dev stdio Turn on shopify-dev npx -y @shopify/dev-mcp@latest off");
    expect(text(element.render())).toContain("stripe oauth Sign in Turn off stripe https://mcp.stripe.com needs sign-in");
    expect(text(element.render())).toContain("docs oauth sse Sign out Turn off docs https://mcp.stripe.com ready Tools");
    expect(text(element.render())).not.toMatch(/approv/i);
    expect(text(element.render())).toContain("Bad_Name : Its name must start with a lowercase letter");
    expect(text(element.render())).not.toContain("as read");
    expect([...shown.matchAll(/aria-checked="?(true|false)/g)].map(match => match[1])).toEqual(["false", "true", "true"]);
  });

  test("says why there are no servers: no file, a file it cannot use, none read yet, or none in it", async () => {
    const said = async (view: McpSessionServersView) => text((await list(view)).element.render());

    expect(await said({ ...listing([]), file: { state: "missing", error: null, sessionId: "s1", readAt: "2026-11-12T10:00:00.000Z" }, skipped: [] })).toContain("No .mcp.json in this checkout.");
    expect(await said({ ...listing([]), file: { state: "invalid", error: "Unexpected token", sessionId: "s1", readAt: "2026-11-12T10:00:00.000Z" }, skipped: [] })).toContain("This .mcp.json could not be used: Unexpected token");
    expect(await said({ ...listing([]), file: null, skipped: [] })).toContain("Read when this session next starts.");
    expect(await said({ ...listing([]), skipped: [] })).toContain("This .mcp.json has no servers.");
  });

  test("signing in shows a link to the sign-in page, also when the browser opens no window", async () => {
    const open = globalThis.open;
    globalThis.open = () => null;
    try {
      const { element } = await list(listing([stripe()]));

      clickButton(element.render(), "Sign in");
      await Bun.sleep(0);
      const shown = templateToString(element.render());

      expect(text(element.render())).toContain("Finish signing in to stripe in the window that opened. Open the sign-in page");
      expect(shown).toContain("https://auth.example/authorize?state=1");
    } finally {
      globalThis.open = open;
    }
  });

  test("Tools lists the tools, asked for in the session", async () => {
    const { element, calls } = await list(listing([stdio()]));

    clickButton(element.render(), "Tools");
    await Bun.sleep(0);

    expect(calls.find(call => call.method === "tools")?.body).toEqual({ id: 4, sessionId: "s1" });
    expect(text(element.render())).toContain("search_docs Searches shopify.dev");
  });

  test("a command changed since the user turned it on says so, and turning it on allows this session's command", async () => {
    const { element, calls } = await list(listing([stdio({ allowed: false, changed: true, status: OFF })]));

    const shown = text(element.render());
    clickButton(element.render(), "Turn on shopify-dev");
    await Bun.sleep(0);

    expect(shown).toContain("Its command changed since you turned it on.");
    expect(calls.find(call => call.method === "allow")?.body).toEqual({ id: 4, allowed: true, sessionId: "s1" });
  });
});
