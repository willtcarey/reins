import { describe, expect, test } from "bun:test";
import { SettingsSidebarSection } from "../../../components/settings/sidebar-section.js";
import { SidebarSections } from "../../../sdk-host/sidebar-sections.js";
import { clickButton, templateToString } from "../../helpers/lit-template.js";
import { memoryLayout } from "../../helpers/reins-sdk.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function sidebarWith(ids: string[]) {
  const { storage, saved } = memoryLayout();
  const sections = new SidebarSections(storage);
  for (const id of ids) sections.register({ id, title: id[0]!.toUpperCase() + id.slice(1), mount: () => {} });
  const element = new SettingsSidebarSection();
  element.sections = sections;
  return { element, sections, saved };
}

describe("Settings → Sidebar", () => {
  test("lists every section in the sidebar's order, with whether it is shown", () => {
    const { element } = sidebarWith(["inbox", "recent", "projects"]);

    const text = templateToString(element.render()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

    expect(text).toMatch(/Inbox .*Recent .*Projects/);
    expect(templateToString(element.render()).match(/aria-checked="?true/g)).toHaveLength(3);
  });

  test("moving a section and turning one off change the sidebar and are stored", async () => {
    const { element, sections, saved } = sidebarWith(["inbox", "recent", "projects"]);

    clickButton(element.render(), "Move Projects up");
    await settle();
    clickButton(element.render(), "Show Inbox");
    await settle();

    expect(sections.shown().map(({ id }) => id)).toEqual(["projects", "recent"]);
    expect(saved.at(-1)).toEqual({ order: ["inbox", "projects", "recent"], hidden: ["inbox"] });
  });
});
