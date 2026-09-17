import { describe, expect, mock, test } from "bun:test";
import { buildDescendantMap, DelegatePopover } from "../../components/delegate-popover.js";
import type { SessionListItem } from "../../models/ws-client.js";
import { templateToString } from "../helpers/lit-template.js";

function childSession(activityState: SessionListItem["activityState"]): SessionListItem {
  return {
    id: "child-1",
    projectId: 1,
    taskId: 2,
    parentSessionId: "parent-1",
    name: "Investigation",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    messageCount: 2,
    firstMessage: "Investigate",
    activityState,
  };
}

function renderPopoverContent(popover: DelegatePopover): string {
  const render: unknown = Reflect.get(popover, "renderPopoverContent");
  if (typeof render !== "function") throw new Error("Expected popover content renderer");
  return templateToString(Reflect.apply(render, popover, []));
}

function renderChildActivityActions(popover: DelegatePopover, child: SessionListItem): string {
  const render: unknown = Reflect.get(popover, "renderChildActivityActions");
  if (typeof render !== "function") throw new Error("Expected child activity action renderer");
  return templateToString(Reflect.apply(render, popover, [child]));
}

describe("DelegatePopover", () => {
  test("includes nested descendants in their top-level session's popover", () => {
    const parent = { ...childSession(null), id: "parent-1", parentSessionId: null };
    const child = childSession(null);
    const grandchild = {
      ...childSession("finished"),
      id: "grandchild-1",
      parentSessionId: child.id,
      name: "Unread nested work",
    };

    const descendantMap = buildDescendantMap([parent, child, grandchild]);

    expect(descendantMap.get(parent.id)?.map((session) => session.id)).toEqual([
      child.id,
      grandchild.id,
    ]);
    expect(descendantMap.get(child.id)?.map((session) => session.id)).toEqual([
      grandchild.id,
    ]);
  });

  test("shows completed child session activity", () => {
    const popover = new DelegatePopover();
    popover.childSessions = [childSession("finished")];

    expect(renderPopoverContent(popover)).not.toContain(".runningOnly=true");
  });

  test("offers a bulk read control for completed children", () => {
    const popover = new DelegatePopover();
    popover.childSessions = [
      childSession("finished"),
      { ...childSession(null), id: "child-2", name: "Already read" },
    ];
    popover.onSetSessionUnread = mock(async () => ({ ok: true }));

    const output = renderPopoverContent(popover);
    expect(output).toContain("Mark all as read");
    expect(output).toContain("<popover-menu");
    expect(output).not.toContain("Mark as unread");
    expect(renderChildActivityActions(popover, popover.childSessions[0]!)).toContain("Mark as read");
    expect(renderChildActivityActions(popover, popover.childSessions[1]!)).toContain("Mark as unread");
  });
});
