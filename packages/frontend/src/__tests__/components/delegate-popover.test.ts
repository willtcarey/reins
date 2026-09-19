import { describe, expect, mock, test } from "bun:test";
import { buildDescendantMap, DelegatePopover } from "../../components/delegate-popover.js";
import type { SessionListItem } from "../../models/ws-client.js";
import type { InfoCardAction } from "../../ui/info-card.js";
import {
  collectTemplateEventListeners,
  isTemplateResult,
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
  };
}

function popoverContent(popover: DelegatePopover): unknown {
  const rendered = popover.render();
  const contentIndex = rendered.strings.findIndex((part) => part.includes(".content="));
  const content = rendered.values[contentIndex];
  if (typeof content !== "function") throw new Error("Expected popover content renderer");
  return content();
}

function infoCardActions(value: unknown): readonly InfoCardAction[][] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => infoCardActions(entry));
  }
  if (!isTemplateResult(value)) return [];

  const actions: InfoCardAction[][] = [];
  for (let index = 0; index < value.values.length; index += 1) {
    const entry = value.values[index];
    if (value.strings[index]?.includes(".actions=") && Array.isArray(entry)) {
      actions.push(entry);
    }
    actions.push(...infoCardActions(entry));
  }
  return actions;
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

  test("selects a child session when its card is activated", () => {
    const popover = new DelegatePopover();
    popover.childSessions = [childSession("finished")];
    const selected = mock((_event: Event) => {});
    popover.addEventListener("select-session", selected);

    const [activate] = collectTemplateEventListeners(
      popoverContent(popover),
      "info-card-activate",
    );
    activate?.(new Event("info-card-activate"));

    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected.mock.calls[0]?.[0]).toMatchObject({
      detail: { sessionId: "child-1" },
    });
  });

  test("marks idle child sessions read or unread through card actions", async () => {
    const popover = new DelegatePopover();
    popover.childSessions = [
      childSession("finished"),
      { ...childSession(null), id: "child-2", name: "Already read" },
      { ...childSession("running"), id: "child-3", name: "Still running" },
    ];
    const setSessionUnread = mock(async (_sessionId: string, _unread: boolean) => ({ ok: true }));
    popover.onSetSessionUnread = setSessionUnread;

    const actions = infoCardActions(popoverContent(popover));
    expect(actions.map((cardActions) => cardActions.map((action) => action.label))).toEqual([
      ["Mark as read"],
      ["Mark as unread"],
      [],
    ]);

    await actions[0]?.[0]?.run();
    await actions[1]?.[0]?.run();

    expect(setSessionUnread).toHaveBeenNthCalledWith(1, "child-1", false);
    expect(setSessionUnread).toHaveBeenNthCalledWith(2, "child-2", true);
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
