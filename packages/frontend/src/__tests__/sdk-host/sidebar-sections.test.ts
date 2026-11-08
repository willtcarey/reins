import { describe, expect, test } from "bun:test";
import type { SidebarSection } from "@reins/sdk";
import { memoryLayout, testSdk } from "../helpers/reins-sdk.js";

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({ id, mount: () => {}, ...extra });
const ids = (sections: readonly { id: string }[]) => sections.map(({ id }) => id);

describe("reins.sidebar.registerSection", () => {
  test("shows sections in registration order until the user arranges them, and its disposer removes one", () => {
    const { reins, sidebar } = testSdk();

    reins.sidebar.registerSection(section("inbox"));
    const disposeRecent = reins.sidebar.registerSection(section("recent"));
    reins.sidebar.registerSection(section("projects"));
    disposeRecent();
    disposeRecent();

    expect(ids(sidebar.shown())).toEqual(["inbox", "projects"]);
  });

  test("refuses a second section of an ID, and an ID that is not lowercase letters, digits and hyphens", () => {
    const { reins, sidebar } = testSdk();
    reins.sidebar.registerSection(section("recent"));

    expect(() => reins.sidebar.registerSection(section("recent"))).toThrow('The sidebar already has a "recent" section');
    expect(() => reins.sidebar.registerSection(section("My Section"))).toThrow("is not a sidebar section ID");
    expect(ids(sidebar.shown())).toEqual(["recent"]);
  });

  test("applies the user's order and switches, and shows a section they have not arranged at the end, on", async () => {
    const { storage } = memoryLayout({ order: ["projects", "inbox"], hidden: ["recent"] });
    const { reins, sidebar } = testSdk({ sidebarLayout: storage });
    for (const id of ["inbox", "recent", "projects"]) reins.sidebar.registerSection(section(id));

    await sidebar.load();
    reins.sidebar.registerSection(section("notes"));

    expect(ids(sidebar.shown())).toEqual(["projects", "inbox", "notes"]);
    expect(sidebar.arrangement().map(({ section: { id }, visible }) => [id, visible])).toEqual([
      ["projects", true], ["inbox", true], ["recent", false], ["notes", true],
    ]);
  });

  test("records the sections each extension registered", () => {
    const { reins, extensionHost, sdkFor } = testSdk();
    const other = { name: "notes", label: "Notes" };
    extensionHost.activate({ ...other, register: (sdk) => sdk.sidebar.registerSection(section("notes")) }, sdkFor(other));
    reins.sidebar.registerSection(section("recent"));

    expect(extensionHost.list()[0]?.registrations.sidebarSections).toEqual(["notes"]);
  });
});

describe("SidebarSections: arranging", () => {
  test("moving and turning off a section shows at once and stores the whole order, keeping sections not registered now", async () => {
    const { storage, saved } = memoryLayout({ order: ["gone", "projects"], hidden: [] });
    const { reins, sidebar } = testSdk({ sidebarLayout: storage });
    for (const id of ["inbox", "recent", "projects"]) reins.sidebar.registerSection(section(id));
    await sidebar.load();

    await sidebar.move("recent", -1);
    await sidebar.setVisible("inbox", false);

    expect(ids(sidebar.shown())).toEqual(["projects", "recent"]);
    expect(saved).toEqual([
      { order: ["projects", "recent", "inbox", "gone"], hidden: [] },
      { order: ["projects", "recent", "inbox", "gone"], hidden: ["inbox"] },
    ]);
  });

  test("a change that cannot be stored is put back, and rejects", async () => {
    const { reins, sidebar } = testSdk({ sidebarLayout: { load: async () => null, save: async () => { throw new Error("offline"); } } });
    for (const id of ["inbox", "recent"]) reins.sidebar.registerSection(section(id));

    const change = sidebar.setVisible("recent", false);
    const shownAtOnce = ids(sidebar.shown());

    await expect(change).rejects.toThrow("offline");
    expect(shownAtOnce).toEqual(["inbox"]);
    expect(ids(sidebar.shown())).toEqual(["inbox", "recent"]);
  });
});
