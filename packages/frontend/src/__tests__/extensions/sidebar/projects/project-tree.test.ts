import { afterEach, describe, expect, test } from "bun:test";
import { ProjectExpansion } from "../../../../extensions/sidebar/projects/project-tree.js";
import { ProjectsSection, registerProjects } from "../../../../extensions/sidebar/projects/projects-section.js";
import { makeProject } from "../../../helpers/fixtures.js";
import { renameSessionEvent } from "../../../../components/events.js";
import { collectTemplateEventListeners, collectTemplateProperties } from "../../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../../helpers/mock-fetch.js";
import { shownSession, testSdk } from "../../../helpers/reins-sdk.js";

afterEach(restoreFetch);

describe("Projects: expansion", () => {
  test("expands the current project, and collapses it when the main area moves to another", () => {
    const expansion = new ProjectExpansion();

    expansion.follow(1);
    const first = expansion.isExpanded(1);
    expansion.follow(2);

    expect([first, expansion.isExpanded(1), expansion.isExpanded(2)]).toEqual([true, false, true]);
  });

  test("keeps a project the user expanded by hand expanded after the main area moves on", () => {
    const expansion = new ProjectExpansion();
    expansion.follow(1);
    expansion.toggle(3);

    expansion.follow(2);

    expect([expansion.isExpanded(1), expansion.isExpanded(2), expansion.isExpanded(3)]).toEqual([false, true, true]);
  });

  test("keeps the current project collapsed when the user collapsed it, until the main area moves to another", () => {
    const expansion = new ProjectExpansion();
    expansion.follow(1);
    expansion.toggle(1);

    expansion.follow(null);
    const collapsed = expansion.isExpanded(1);
    expansion.follow(2);
    expansion.follow(1);

    expect([collapsed, expansion.isExpanded(1)]).toEqual([false, true]);
  });
});

describe("Projects section", () => {
  test("shows every project by name, with only the shown session's project expanded", () => {
    const { reins, projectsStore } = testSdk({ current: shownSession("s", { projectId: 2, taskId: null }) });
    mockFetch(() => new Response("[]", { headers: { "Content-Type": "application/json" } }));
    projectsStore.projects = [makeProject(1, "Web"), makeProject(2, "Api"), makeProject(3, "Docs")];
    const section = new ProjectsSection();
    section.reins = reins;

    Reflect.get(section, "willUpdate").call(section);
    const rendered = section.render();

    expect(collectTemplateProperties(rendered, "project").map((project) => Reflect.get(Object(project), "name"))).toEqual(["Api", "Docs", "Web"]);
    expect(collectTemplateProperties(rendered, "expanded")).toEqual([true, false, false]);
  });

  test("renames any of its sessions through the host's dialog", async () => {
    const { reins } = testSdk();
    const renamed: string[] = [];
    const section = new ProjectsSection();
    section.reins = { ...reins, ui: { renameSession: async (sessionId) => { renamed.push(sessionId); return true; } } };

    const [rename] = collectTemplateEventListeners(section.render(), "rename-session");
    rename?.call(section, renameSessionEvent("other-1"));

    expect(renamed).toEqual(["other-1"]);
  });

  test("is the sidebar's Projects section", () => {
    const { reins, sidebar } = testSdk();

    registerProjects(reins);

    expect(sidebar.shown().map(({ id, title }) => ({ id, title }))).toEqual([{ id: "projects", title: "Projects" }]);
  });
});
