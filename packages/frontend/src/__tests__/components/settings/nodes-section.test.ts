import { afterEach, describe, expect, test } from "bun:test";
import type { NodeView } from "@backend/models/node.js";
import { SettingsNodesSection } from "../../../components/settings/nodes-section.js";
import { Loadable } from "../../../helpers/loadable.js";
import { NodesStore } from "../../../models/stores/nodes-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { clickButton, templateToString } from "../../helpers/lit-template.js";
import { setConfirmHostForTesting, type ConfirmOptions } from "../../../ui/confirm-dialog.js";

const originalLocation = globalThis.location;

const localNode: NodeView = { id: "internal", name: "Internal", connected: true, paired: false, hostname: null, pairedAt: null, revokedAt: null, sources: [], build: null };
const laptop: NodeView = { id: "laptop", name: "Laptop", connected: true, paired: true, hostname: "laptop.local", pairedAt: "2026-10-01T09:00:00.000Z", revokedAt: null, sources: [], build: null };
const build = (status: "current" | "outdated" | "updating") => ({ id: "a".repeat(64), status });
const pairingCode = { id: 7, code: "single-use-code", expiresAt: "2026-10-08T12:10:00.000Z" };

afterEach(() => {
  restoreFetch();
  setConfirmHostForTesting(null);
  Reflect.set(globalThis, "location", originalLocation);
});

/** The section's text as a user reads it: markup stripped, whitespace collapsed. */
function visibleText(section: SettingsNodesSection): string {
  return templateToString(section.render()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function sectionListing(nodes: NodeView[]): SettingsNodesSection {
  const store = new NodesStore();
  store.nodes = Loadable.idle<NodeView[]>().asLoaded(nodes);
  const section = new SettingsNodesSection();
  section.store = store;
  return section;
}

describe("SettingsNodesSection", () => {
  test("shows each node's status, its hostname, and marks the local node", () => {
    expect(visibleText(sectionListing([laptop]))).toContain("Laptop laptop.local connected");
    expect(visibleText(sectionListing([{ ...laptop, connected: false }]))).toContain("Laptop laptop.local offline");
    expect(visibleText(sectionListing([{ ...laptop, connected: false, revokedAt: "2026-10-08T12:00:00.000Z" }]))).toContain("Laptop laptop.local revoked");
    expect(visibleText(sectionListing([localNode]))).toContain("Internal local connected");
    // A node named after its hostname shows it once.
    expect(visibleText(sectionListing([{ ...laptop, name: "bigbox", hostname: "bigbox" }]))).toContain("bigbox connected");
    expect(visibleText(sectionListing([{ ...laptop, name: "bigbox", hostname: "bigbox" }]))).not.toContain("bigbox bigbox");
  });

  test("a node restarting on the server's build says it is updating, and one served on another build says so; a current build shows nothing", () => {
    expect(visibleText(sectionListing([{ ...laptop, connected: false, build: build("updating") }]))).toContain("Laptop laptop.local updating… offline");
    expect(visibleText(sectionListing([{ ...laptop, build: build("outdated") }]))).toContain("Laptop laptop.local old build connected");
    expect(visibleText(sectionListing([{ ...laptop, build: build("current") }]))).toContain("Laptop laptop.local connected");
  });

  test("offers Remove, and no Revoke, for paired nodes, revoked or not, but not the local node", () => {
    expect(visibleText(sectionListing([laptop]))).toContain("Remove");
    expect(visibleText(sectionListing([{ ...laptop, revokedAt: "2026-10-08T12:00:00.000Z" }]))).toContain("Remove");
    expect(visibleText(sectionListing([localNode]))).not.toContain("Remove");
    expect(visibleText(sectionListing([laptop, { ...laptop, id: "old", revokedAt: "2026-10-08T12:00:00.000Z" }]))).not.toContain("Revoke");
  });

  test("Remove asks first, and declining keeps the node", async () => {
    const requests: string[] = [];
    mockFetch((url, init) => { requests.push(`${init?.method ?? "GET"} ${url}`); return new Response(null, { status: 204 }); });
    const asked: ConfirmOptions[] = [];
    setConfirmHostForTesting({ open: async (options) => { asked.push(options); return false; } });
    const section = sectionListing([localNode, laptop]);

    clickButton(section.render(), "Remove");
    await Bun.sleep(1);

    expect(asked).toEqual([{ title: "Remove Laptop?", message: "This is permanent: it can never connect again; pair the machine again to use it.", confirmLabel: "Remove", destructive: true }]);
    expect(requests).toEqual([]);
    expect(section.store!.nodes.data).toEqual([localNode, laptop]);
  });

  test("confirming Remove removes the node", async () => {
    const requests: string[] = [];
    mockFetch((url, init) => { requests.push(`${init?.method ?? "GET"} ${url}`); return new Response(null, { status: 204 }); });
    setConfirmHostForTesting({ open: async () => true });
    const section = sectionListing([localNode, laptop]);

    clickButton(section.render(), "Remove");

    for (let i = 0; i < 20 && section.store!.nodes.data!.length > 1; i++) await Bun.sleep(1);
    expect(requests).toEqual(["DELETE /api/nodes/laptop"]);
    expect(section.store!.nodes.data).toEqual([localNode]);
  });

  test("pairing replaces the node list with the command and code, waiting for the machine, until it is done", async () => {
    Reflect.set(globalThis, "location", { origin: "https://reins.example:4100" });
    mockFetch(() => new Response(JSON.stringify({ id: 7, code: "single-use-code", expiresAt: "2026-10-08T12:10:00.000Z" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    const section = sectionListing([localNode]);
    const store = section.store!;

    await store.createPairingCode("");

    expect(visibleText(section)).toContain("curl -fsSL https://reins.example:4100/nodes/install | sh -s -- single-use-code");
    expect(visibleText(section)).toContain("expires in 10 minutes");
    expect(visibleText(section)).toContain("Waiting for the machine to pair");
    expect(visibleText(section)).not.toContain("Internal");

    store.dismissPairingCode();

    expect(visibleText(section)).not.toContain("single-use-code");
    expect(visibleText(section)).toContain("Internal");
  });

  test("a paired code shows its node waiting to connect, with the command to run if it does not", () => {
    Reflect.set(globalThis, "location", { origin: "https://reins.example:4100" });
    const section = sectionListing([localNode]);
    section.store!.pairing = { ...pairingCode, name: "", status: "paired", node: { ...laptop, connected: false } };

    const text = visibleText(section);

    expect(text).toContain("Paired as Laptop");
    expect(text).toContain("Waiting for Laptop to connect");
    expect(text).toContain("curl -fsSL https://reins.example:4100/nodes/install | sh -s -- single-use-code");
    expect(text).not.toContain("Waiting for the machine to pair");
    expect(text).not.toContain("expires in");
  });

  test("a paired node that connected says so, no longer waiting", () => {
    const section = sectionListing([localNode]);
    section.store!.pairing = { ...pairingCode, name: "", status: "connected", node: laptop };

    const text = visibleText(section);

    expect(text).toContain("Laptop is connected");
    expect(text).not.toContain("Waiting for");
    expect(text).not.toContain("single-use-code");
  });

  test("an expired code says so and offers another instead of the code", () => {
    const section = sectionListing([localNode]);
    section.store!.pairing = { ...pairingCode, name: "", status: "expired" };

    const text = visibleText(section);

    expect(text).toContain("This code expired");
    expect(text).toContain("Create another code");
    expect(text).not.toContain("single-use-code");
    expect(text).not.toContain("Waiting for the machine");
  });

  test("leaving the section drops a pairing code still shown", () => {
    const section = sectionListing([localNode]);
    const store = section.store!;
    store.pairing = { ...pairingCode, name: "", status: "waiting" };

    section.disconnectedCallback();

    expect(store.pairing).toBeNull();
  });

  test("lists each node's checkouts with their projects; a paired node without any says where to add one, the local node does not", () => {
    const text = visibleText(sectionListing([{ ...laptop, sources: [
      { path: "/srv/api", project: { id: 2, name: "Api", sourceId: 5 } },
      { path: "/srv/website", project: { id: 3, name: "Website", sourceId: 6 } },
    ] }]));

    expect(text).toContain("/srv/api Api /srv/website Website");
    expect(visibleText(sectionListing([laptop]))).toContain("No checkouts yet. Add one from a project's settings");
    expect(visibleText(sectionListing([localNode]))).not.toContain("No checkouts yet");
  });
});
