import { afterEach, describe, expect, test } from "bun:test";
import { PartType, type PartInfo } from "lit/directive.js";
import { SidebarProject } from "../../components/sidebar-project.js";
import { SpringCollapseDirective } from "../../directives/spring-collapse.js";
import { ProjectStore } from "../../models/stores/project-store.js";
import { collectTemplateValues, templateToString } from "../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";

interface DirectiveResult {
  _$litDirective$: typeof SpringCollapseDirective;
  values: Parameters<SpringCollapseDirective["render"]>;
}

function renderCollapse(project: SidebarProject): string {
  const collapse = collectTemplateValues(project.render()).find((value): value is DirectiveResult => (
    typeof value === "object"
      && value !== null
      && "_$litDirective$" in value
      && value._$litDirective$ === SpringCollapseDirective
  ));
  if (!collapse) throw new Error("Expected spring collapse directive");

  const childPart: PartInfo = { type: PartType.CHILD };
  return templateToString(new SpringCollapseDirective(childPart).render(...collapse.values));
}

afterEach(restoreFetch);

describe("SidebarProject", () => {
  test("updates when its project data finishes loading", async () => {
    mockFetch(() => Response.json([]));
    const project = new SidebarProject();
    const store = new ProjectStore(7);
    let updates = 0;
    project.requestUpdate = () => { updates += 1; };
    project.projectStore = store;
    const updatesAfterAssignment = updates;

    await store.fetchLists();

    expect(updates - updatesAfterAssignment).toBe(2);
  });

  test("lazily renders the project task list while expanded", () => {
    const project = new SidebarProject();
    project.project = {
      id: 7,
      name: "Reins",
      path: "/work/reins",
      base_branch: "master",
      created_at: "2026-01-01T00:00:00Z",
      last_opened_at: "2026-01-01T00:00:00Z",
    };
    project.expanded = false;

    expect(renderCollapse(project)).not.toContain("<task-list");

    project.expanded = true;

    expect(renderCollapse(project)).toContain("<task-list");
  });
});
