import { describe, expect, mock, test } from "bun:test";
import { SessionListItem } from "../../components/session-list-item.js";
import type { SessionListItem as SessionListItemData } from "../../models/ws-client.js";
import { templateToString } from "../helpers/lit-template.js";

function renderActivityActions(item: SessionListItem): string {
  const render: unknown = Reflect.get(item, "renderActivityActions");
  if (typeof render !== "function") throw new Error("Expected activity action renderer");
  return templateToString(Reflect.apply(render, item, []));
}

function session(activityState: SessionListItemData["activityState"]): SessionListItemData {
  return {
    id: "session-1",
    projectId: 1,
    taskId: 2,
    parentSessionId: null,
    name: "Investigation",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    messageCount: 2,
    firstMessage: "Investigate",
    activityState,
  };
}

describe("SessionListItem", () => {
  test("offers read and unread controls from an overflow menu", () => {
    const item = new SessionListItem();
    item.onSetSessionUnread = mock(async () => ({ ok: true }));
    item.session = session("finished");
    item.activityState = "finished";

    expect(templateToString(item.render())).not.toContain("Mark as read");
    expect(renderActivityActions(item)).toContain("Mark as read");

    item.session = session(null);
    item.activityState = null;

    expect(renderActivityActions(item)).toContain("Mark as unread");
  });

  test("opens activity actions from the session context menu without an overflow trigger", () => {
    const item = new SessionListItem();
    item.onSetSessionUnread = mock(async () => ({ ok: true }));
    item.session = session("finished");
    item.activityState = "finished";
    const preventDefault = mock(() => {});
    const openContextMenu: unknown = Reflect.get(item, "openContextMenu");

    if (typeof openContextMenu !== "function") throw new Error("Expected context-menu handler");
    Reflect.apply(openContextMenu, item, [{ preventDefault, clientX: 50, clientY: 60 }]);

    const output = templateToString(item.render());
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(output).toContain("Mark as read");
    expect(output).not.toContain("<popover-menu");
  });

  test("does not offer a read control while a session is running", () => {
    const item = new SessionListItem();
    item.onSetSessionUnread = mock(async () => ({ ok: true }));
    item.session = session("running");
    item.activityState = "running";

    const output = templateToString(item.render());
    expect(output).not.toContain("Mark as read");
    expect(output).not.toContain("Mark as unread");
  });
});
