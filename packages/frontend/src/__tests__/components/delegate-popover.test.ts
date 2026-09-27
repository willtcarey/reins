import { describe, expect, mock, test } from "bun:test";
import { buildDescendantMap, DelegatePopover } from "../../components/delegate-popover.js";
import type { SessionListView as SessionListItem } from "@backend/models/sessions.js";
import {
  collectTemplateEventListeners,
  collectTemplateValues,
  isTemplateResult,
  templateToString,
} from "../helpers/lit-template.js";

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
    pinnedAt: null,
    archivedAt: null,
    location: { state: "server" },
  };
}

function popoverContent(popover: DelegatePopover): unknown {
  const rendered = popover.render();
  const contentIndex = rendered.strings.findIndex((part) => part.includes(".content="));
  const content = rendered.values[contentIndex];
  if (typeof content !== "function") throw new Error("Expected popover content renderer");
  return content();
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

  test("renders delegate sessions through the shared actionable session row", () => {
    const popover = new DelegatePopover();
    const child = childSession("finished");
    const setSessionUnread = mock(async () => ({ ok: true }));
    const updateMetadata = mock(async () => ({ ok: true }));
    popover.childSessions = [child];
    popover.onSetSessionUnread = setSessionUnread;
    popover.onUpdateMetadata = updateMetadata;

    const content = popoverContent(popover);
    const output = templateToString(content);
    const values = collectTemplateValues(content);
    const row = values
      .flatMap((value) => Array.isArray(value) ? value : [])
      .find((value) => isTemplateResult(value) && value.strings.join("").includes("<session-list-item"));
    if (!isTemplateResult(row)) throw new Error("Expected shared session row");

    expect(output).toContain("<session-list-item");
    expect(row.values).toContain(child);
    expect(row.values).toContain(setSessionUnread);
    expect(row.values).toContain(updateMetadata);
  });

  test("marks every unread child as read from the bulk action", () => {
    const popover = new DelegatePopover();
    popover.childSessions = [
      childSession("finished"),
      { ...childSession("finished"), id: "child-2", name: "Other unread work" },
      { ...childSession(null), id: "child-3", name: "Already read" },
      { ...childSession("running"), id: "child-4", name: "Still running" },
    ];
    const setSessionUnread = mock(async (_sessionId: string, _unread: boolean) => ({ ok: true }));
    popover.onSetSessionUnread = setSessionUnread;

    const [markAllRead] = collectTemplateEventListeners(popoverContent(popover), "click");
    markAllRead?.(new Event("click"));

    expect(setSessionUnread).toHaveBeenCalledTimes(2);
    expect(setSessionUnread).toHaveBeenNthCalledWith(1, "child-1", false);
    expect(setSessionUnread).toHaveBeenNthCalledWith(2, "child-2", false);
  });
});
