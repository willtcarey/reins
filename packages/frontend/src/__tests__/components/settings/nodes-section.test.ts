import { afterEach, describe, expect, test } from "bun:test";
import type { NodeView } from "@backend/models/nodes.js";
import { SettingsNodesSection } from "../../../components/settings/nodes-section.js";
import { Loadable } from "../../../helpers/loadable.js";
import { NodesStore } from "../../../models/stores/nodes-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { clickButton, templateToString } from "../../helpers/lit-template.js";

const originalLocation = globalThis.location;

const localNode: NodeView = { id: "internal", name: "Internal", connected: true, paired: false, hostname: null, pairedAt: null, revokedAt: null };
const laptop: NodeView = { id: "laptop", name: "Laptop", connected: true, paired: true, hostname: "laptop.local", pairedAt: "2026-10-01T09:00:00.000Z", revokedAt: null };
const pairingCode = { id: 7, code: "single-use-code", expiresAt: "2026-10-08T12:10:00.000Z" };

afterEach(() => {
  restoreFetch();
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
  });

  test("offers Remove, and no Revoke, for paired nodes, revoked or not, but not the local node", () => {
    expect(visibleText(sectionListing([laptop]))).toContain("Remove");
    expect(visibleText(sectionListing([{ ...laptop, revokedAt: "2026-10-08T12:00:00.000Z" }]))).toContain("Remove");
    expect(visibleText(sectionListing([localNode]))).not.toContain("Remove");
    expect(visibleText(sectionListing([laptop, { ...laptop, id: "old", revokedAt: "2026-10-08T12:00:00.000Z" }]))).not.toContain("Revoke");
  });

  test("Remove asks in the row first; Cancel keeps the node", () => {
    const requests: string[] = [];
    mockFetch((url, init) => { requests.push(`${init?.method ?? "GET"} ${url}`); return new Response(null, { status: 204 }); });
    const section = sectionListing([localNode, laptop]);

    clickButton(section.render(), "Remove");

    expect(visibleText(section)).toContain("Remove Laptop");
    expect(visibleText(section)).toContain("This is permanent: it can never connect again; pair the machine again to use it.");

    clickButton(section.render(), "Cancel");

    expect(visibleText(section)).not.toContain("This is permanent");
    expect(requests).toEqual([]);
    expect(section.store!.nodes.data).toEqual([localNode, laptop]);
  });

  test("confirming Remove removes the node", async () => {
    const requests: string[] = [];
    mockFetch((url, init) => { requests.push(`${init?.method ?? "GET"} ${url}`); return new Response(null, { status: 204 }); });
    const section = sectionListing([localNode, laptop]);
    clickButton(section.render(), "Remove");

    clickButton(section.render(), "Remove");

    for (let i = 0; i < 20 && section.store!.nodes.data!.length > 1; i++) await Bun.sleep(1);
    expect(requests).toEqual(["DELETE /api/nodes/laptop"]);
    expect(section.store!.nodes.data).toEqual([localNode]);
    expect(visibleText(section)).not.toContain("This is permanent");
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

    expect(visibleText(section)).toContain("bun run reins node pair https://reins.example:4100 single-use-code");
    expect(visibleText(section)).toContain("expires in 10 minutes");
    expect(visibleText(section)).toContain("Waiting for the machine to pair");
    expect(visibleText(section)).not.toContain("Internal");

    store.dismissPairingCode();

    expect(visibleText(section)).not.toContain("single-use-code");
    expect(visibleText(section)).toContain("Internal");
  });

  test("a paired code shows the node it paired instead of the code", () => {
    const section = sectionListing([localNode]);
    section.store!.pairing = { ...pairingCode, name: "", status: "paired", node: laptop };

    const text = visibleText(section);

    expect(text).toContain("Paired as Laptop");
    expect(text).not.toContain("single-use-code");
    expect(text).not.toContain("Waiting for the machine");
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
});
