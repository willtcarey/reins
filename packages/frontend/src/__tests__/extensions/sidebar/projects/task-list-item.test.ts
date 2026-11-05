import { describe, expect, test } from "bun:test";
import { PartType, type PartInfo } from "lit/directive.js";
import { TaskListItemElement } from "../../../../extensions/sidebar/projects/task-list-item.js";
import { SpringCollapseDirective } from "../../../../directives/spring-collapse.js";
import { makeSessionSummary, makeTaskSummary } from "../../../helpers/fixtures.js";
import { collectTemplateValues, templateToString } from "../../../helpers/lit-template.js";

interface DirectiveResult {
  _$litDirective$: typeof SpringCollapseDirective;
  values: Parameters<SpringCollapseDirective["render"]>;
}

function renderCollapse(item: TaskListItemElement): string {
  const collapse = collectTemplateValues(item.render()).find((value): value is DirectiveResult => (
    typeof value === "object"
      && value !== null
      && "_$litDirective$" in value
      && value._$litDirective$ === SpringCollapseDirective
  ));
  if (!collapse) throw new Error("Expected spring collapse directive");

  const childPart: PartInfo = { type: PartType.CHILD };
  return templateToString(new SpringCollapseDirective(childPart).render(...collapse.values));
}

describe("TaskListItemElement", () => {
  test("lazily renders its session body only while expanded", () => {
    const item = new TaskListItemElement();
    item.task = makeTaskSummary({ sessionCount: 1 });
    item.expanded = false;

    expect(renderCollapse(item)).not.toContain("Loading…");

    item.expanded = true;

    expect(renderCollapse(item)).toContain("Loading…");
  });

  test("keeps a child visible when its archived parent is absent from the active list", () => {
    const child = makeSessionSummary("child", { taskId: 1, parentSessionId: "archived-parent", name: "Independent child" });
    const item = new TaskListItemElement();
    item.task = makeTaskSummary({ id: 1, sessionCount: 2 });
    item.sessions = [child];
    item.expanded = true;

    expect(renderCollapse(item)).toContain("<session-list-item");
  });
});
