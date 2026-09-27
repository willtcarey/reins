import { describe, expect, test } from "bun:test";
import { PartType, type PartInfo } from "lit/directive.js";
import { TaskListItemElement } from "../../components/task-list-item.js";
import { SpringCollapseDirective } from "../../directives/spring-collapse.js";
import type { SessionListView as SessionListItem } from "@backend/models/sessions.js";
import { makeTask } from "../helpers/fixtures.js";
import { collectTemplateValues, templateToString } from "../helpers/lit-template.js";

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
    item.task = makeTask({ session_count: 1 });
    item.expanded = false;

    expect(renderCollapse(item)).not.toContain("Loading…");

    item.expanded = true;

    expect(renderCollapse(item)).toContain("Loading…");
  });

  test("keeps a child visible when its archived parent is absent from the active list", () => {
    const child: SessionListItem = {
      id: "child",
      projectId: 1,
      taskId: 1,
      parentSessionId: "archived-parent",
      name: "Independent child",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      pinnedAt: null,
      archivedAt: null,
      placement: { status: "server", error: null, available: true, nodeId: "internal", nodeName: "Internal" },
      messageCount: 1,
      firstMessage: "Continue independently",
      activityState: null,
    };
    const item = new TaskListItemElement();
    item.task = makeTask({ id: 1, session_count: 2 });
    item.sessions = [child];
    item.expanded = true;

    expect(renderCollapse(item)).toContain("<session-list-item");
  });
});
