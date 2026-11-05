/**
 * Tests for ExtensionsStore — Settings' Extensions section: the backend's report merged with the frontend's
 * extensions by name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionView } from "@backend/extensions/host.js";
import type { ExtensionRegistration, ReinsSdk } from "@reins/sdk";
import { ExtensionsStore } from "../../../models/stores/extensions-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";

function backendExtension(name: string, overrides: Partial<ExtensionView> = {}): ExtensionView {
  return {
    name,
    status: "loaded",
    failure: null,
    errors: [],
    registrations: { tools: null, images: null, promptSections: 0, settlementListeners: 0, scriptFunctions: [], httpMethods: [], pages: [] },
    services: [],
    storage: null,
    ...overrides,
  };
}

function serveBackend(response: () => Response): string[] {
  const requests: string[] = [];
  mockFetch((url) => {
    requests.push(url);
    return response();
  });
  return requests;
}

afterEach(() => restoreFetch());

describe("ExtensionsStore", () => {
  test("merges each extension's backend and frontend parts by name, by label; an extension may have one part", async () => {
    const sdk = testSdk();
    const mcp: ExtensionRegistration = { name: "mcp", label: "MCP", description: "Remote MCP servers.", register: (reins: ReinsSdk) => reins.settings.register({ mount: () => {} }) };
    const viewer: ExtensionRegistration = { name: "file-viewer", label: "File viewer", register: () => () => {} };
    sdk.extensions.activate(mcp, sdk.sdkFor(mcp));
    sdk.extensions.activate(viewer, sdk.sdkFor(viewer));
    const backendMcp = backendExtension("mcp", { registrations: { tools: { title: "MCP servers" }, images: null, promptSections: 1, settlementListeners: 0, scriptFunctions: ["mcp.list"], httpMethods: ["list"], pages: [] } });
    const requests = serveBackend(() => Response.json([backendMcp, backendExtension("audit")]));
    const store = new ExtensionsStore(sdk.extensions);

    await store.load();

    expect(requests).toEqual(["/api/extensions"]);
    expect(store.extensions.map(({ name, label, description, parts, status }) => ({ name, label, description, parts, status }))).toEqual([
      { name: "audit", label: "audit", description: null, parts: { backend: true, frontend: false }, status: "loaded" },
      { name: "file-viewer", label: "File viewer", description: null, parts: { backend: false, frontend: true }, status: "loaded" },
      { name: "mcp", label: "MCP", description: "Remote MCP servers.", parts: { backend: true, frontend: true }, status: "loaded" },
    ]);
    const merged = store.extensions[2];
    expect(merged?.backend).toEqual(backendMcp);
    expect(merged?.frontend?.registrations.settingsPage).toBe(true);
  });

  test("an extension is failed when either part failed, with each part's error", async () => {
    const sdk = testSdk();
    const notes: ExtensionRegistration = { name: "notes", label: "Notes", register: () => () => {} };
    sdk.extensions.activate(notes, sdk.sdkFor(notes));
    serveBackend(() => Response.json([backendExtension("notes", { status: "failed", failure: { stage: "migration", message: "bad migration" } })]));
    const store = new ExtensionsStore(sdk.extensions);

    await store.load();

    expect(store.extensions.map(({ status, problems }) => ({ status, problems }))).toEqual([
      { status: "failed", problems: ["Backend: a migration failed: bad migration"] },
    ]);
  });

  test("while the backend's report cannot be loaded, the frontend's extensions are still listed, and the error is kept", async () => {
    const sdk = testSdk();
    const notes: ExtensionRegistration = { name: "notes", label: "Notes", register: () => () => {} };
    sdk.extensions.activate(notes, sdk.sdkFor(notes));
    serveBackend(() => Response.json({ error: "server down" }, { status: 500 }));
    const store = new ExtensionsStore(sdk.extensions);

    const result = await store.load();

    expect(result).toEqual({ error: "server down" });
    expect(store.backendError).toBe("server down");
    expect(store.extensions.map(({ name, parts }) => ({ name, parts }))).toEqual([{ name: "notes", parts: { backend: false, frontend: true } }]);
  });

  test("a registration made or disposed on the frontend reaches the list and its listeners", async () => {
    const sdk = testSdk();
    let reins: ReinsSdk | undefined;
    const notes: ExtensionRegistration = { name: "notes", label: "Notes", register: (sdkOfNotes: ReinsSdk) => { reins = sdkOfNotes; return () => {}; } };
    sdk.extensions.activate(notes, sdk.sdkFor(notes));
    const store = new ExtensionsStore(sdk.extensions);
    let changes = 0;
    store.subscribe(() => { changes += 1; });

    const remove = reins!.commands.register({ name: "note", description: "", run: () => {} });
    expect(store.extensions[0]?.frontend?.registrations.commands).toEqual(["note"]);
    remove();

    expect(store.extensions[0]?.frontend?.registrations.commands).toEqual([]);
    expect(changes).toBe(2);
  });
});
