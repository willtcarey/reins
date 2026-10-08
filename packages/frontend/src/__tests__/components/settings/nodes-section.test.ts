import { afterEach, describe, expect, test } from "bun:test";
import type { NodeView } from "@backend/routes/nodes.js";
import { SettingsNodesSection } from "../../../components/settings/nodes-section.js";
import { Loadable } from "../../../helpers/loadable.js";
import { NodesStore } from "../../../models/stores/nodes-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { templateToString } from "../../helpers/lit-template.js";

const originalLocation = globalThis.location;

const localNode: NodeView = { id: "internal", name: "Internal", connected: true, paired: false, hostname: null, pairedAt: null, revokedAt: null };
const laptop: NodeView = { id: "laptop", name: "Laptop", connected: true, paired: true, hostname: "laptop.local", pairedAt: "2026-10-01T09:00:00.000Z", revokedAt: null };

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

  test("offers Revoke only for a paired node that is not revoked", () => {
    expect(visibleText(sectionListing([laptop]))).toContain("Revoke");
    expect(visibleText(sectionListing([localNode]))).not.toContain("Revoke");
    expect(visibleText(sectionListing([{ ...laptop, revokedAt: "2026-10-08T12:00:00.000Z" }]))).not.toContain("Revoke");
  });

  test("shows the pairing command after a code is created, and neither once dismissed", async () => {
    Reflect.set(globalThis, "location", { origin: "https://reins.example:4100" });
    mockFetch(() => new Response(JSON.stringify({ code: "single-use-code", expiresAt: "2026-10-08T12:10:00.000Z" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    const section = sectionListing([localNode]);
    const store = section.store!;

    await store.createPairingCode("");

    expect(visibleText(section)).toContain("bun run reins node pair https://reins.example:4100 single-use-code");
    expect(visibleText(section)).toContain("expires in 10 minutes");

    store.dismissPairingCode();

    expect(visibleText(section)).not.toContain("single-use-code");
  });
});
