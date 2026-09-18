import { describe, expect, mock, test } from "bun:test";
import { SessionListItem } from "../../components/session-list-item.js";
import type { InfoCardAction } from "../../ui/info-card.js";
import type { SessionListItem as SessionListItemData } from "../../models/ws-client.js";
import { isTemplateResult } from "../helpers/lit-template.js";

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

function infoCardActions(item: SessionListItem): readonly InfoCardAction[] {
  const rendered = item.render();
  if (!isTemplateResult(rendered)) throw new Error("Expected session list item template");
  const index = rendered.strings.findIndex((part) => part.includes(".actions="));
  if (index < 0) throw new Error("Expected info-card actions binding");
  const actions = rendered.values[index];
  if (!Array.isArray(actions)) throw new Error("Expected info-card action list");
  return actions;
}

describe("SessionListItem", () => {
  test("provides read and unread info-card actions", async () => {
    const item = new SessionListItem();
    const setSessionUnread = mock(async () => ({ ok: true }));
    item.onSetSessionUnread = setSessionUnread;
    item.session = session("finished");

    const finishedActions = infoCardActions(item);
    expect(finishedActions.map((action) => action.label)).toEqual([
      "Copy session ID",
      "Mark as read",
    ]);
    const markRead = finishedActions.find((action) => action.label === "Mark as read");
    await markRead?.run();
    expect(setSessionUnread).toHaveBeenCalledWith("session-1", false);

    item.session = session(null);
    const idleActions = infoCardActions(item);
    expect(idleActions.map((action) => action.label)).toEqual([
      "Copy session ID",
      "Mark as unread",
    ]);
    const markUnread = idleActions.find((action) => action.label === "Mark as unread");
    await markUnread?.run();
    expect(setSessionUnread).toHaveBeenCalledWith("session-1", true);
  });

  test("only provides copy while a session is running", () => {
    const item = new SessionListItem();
    item.onSetSessionUnread = mock(async () => ({ ok: true }));
    item.session = session("running");

    expect(infoCardActions(item).map((action) => action.label)).toEqual(["Copy session ID"]);
  });
});
