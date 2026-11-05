import { afterEach, describe, expect, test } from "bun:test";
import type { SessionSummary } from "@reins/sdk";
import { buildDescendantMap, DelegatePopover } from "../../../../extensions/sidebar/projects/delegate-popover.js";
import { makeSessionListItem, makeSessionSummary } from "../../../helpers/fixtures.js";
import {
  collectTemplateEventListeners,
  collectTemplateValues,
  isTemplateResult,
  templateToString,
} from "../../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../../helpers/mock-fetch.js";
import { testSdk } from "../../../helpers/reins-sdk.js";

afterEach(restoreFetch);

function childSession(activity: SessionSummary["activity"]): SessionSummary {
  return makeSessionSummary("child-1", { taskId: 2, parentSessionId: "parent-1", name: "Investigation", activity });
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
      ...childSession("unread"),
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
    const child = childSession("unread");
    const { reins } = testSdk();
    popover.childSessions = [child];
    popover.sessions = reins.sessions;

    const content = popoverContent(popover);
    const output = templateToString(content);
    const values = collectTemplateValues(content);
    const row = values
      .flatMap((value) => Array.isArray(value) ? value : [])
      .find((value) => isTemplateResult(value) && value.strings.join("").includes("<session-list-item"));
    if (!isTemplateResult(row)) throw new Error("Expected shared session row");

    expect(output).toContain("<session-list-item");
    expect(row.values).toContain(child);
    expect(row.values).toContain(reins.sessions);
  });

  test("marks every unread child as read from the bulk action", () => {
    const { reins, sessions } = testSdk();
    sessions.setMany([
      makeSessionListItem("child-1", { activityState: "finished" }),
      makeSessionListItem("child-2", { activityState: "finished" }),
      makeSessionListItem("child-3"),
      makeSessionListItem("child-4", { activityState: "running" }),
    ]);
    const writes: string[] = [];
    mockFetch((url, init) => {
      writes.push(`${init?.method} ${url} ${init?.body}`);
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    });
    const popover = new DelegatePopover();
    popover.childSessions = [
      childSession("unread"),
      { ...childSession("unread"), id: "child-2", name: "Other unread work" },
      { ...childSession(null), id: "child-3", name: "Already read" },
      { ...childSession("running"), id: "child-4", name: "Still running" },
    ];
    popover.sessions = reins.sessions;

    const [markAllRead] = collectTemplateEventListeners(popoverContent(popover), "click");
    markAllRead?.(new Event("click"));

    expect(writes).toEqual([
      'PATCH /api/sessions/child-1/activity {"unread":false}',
      'PATCH /api/sessions/child-2/activity {"unread":false}',
    ]);
  });
});
