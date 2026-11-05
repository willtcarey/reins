import { afterEach, describe, expect, test } from "bun:test";
import type { SessionSummary } from "@reins/sdk";
import { SessionListItem } from "../../../../extensions/sidebar/projects/session-list-item.js";
import type { InfoCardAction } from "../../../../ui/info-card.js";
import { makeSessionListItem, makeSessionSummary } from "../../../helpers/fixtures.js";
import { collectTemplateEventListeners, isTemplateResult, templateToString } from "../../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../../helpers/mock-fetch.js";
import { testSdk } from "../../../helpers/reins-sdk.js";

afterEach(restoreFetch);

function session(activity: SessionSummary["activity"]): SessionSummary {
  return makeSessionSummary("session-1", { taskId: 2, name: "Investigation", messageCount: 2, firstMessage: "Investigate", activity, nodeName: "Laptop" });
}

/** The SDK's sessions over a cache that has `session-1` with `activityState`, recording what reaches the server. */
function recordingSessions(activityState: "running" | "finished" | null = null) {
  const sdk = testSdk();
  sdk.sessions.setMany([makeSessionListItem("session-1", { taskId: 2, activityState })]);
  const writes: string[] = [];
  mockFetch((url, init) => {
    writes.push(`${init?.method} ${url} ${init?.body}`);
    return new Response(JSON.stringify(makeSessionListItem("session-1")), { headers: { "Content-Type": "application/json" } });
  });
  return { sessions: sdk.reins.sessions, writes };
}

function infoCardBinding(item: SessionListItem, binding: "actions" | "titlePrefix" | "trailing" | "subtitle"): unknown {
  const rendered = item.render();
  if (!isTemplateResult(rendered)) throw new Error("Expected session list item template");
  const index = rendered.strings.findIndex((part) => part.includes(`.${binding}=`));
  if (index < 0) throw new Error(`Expected info-card ${binding} binding`);
  return rendered.values[index];
}

function infoCardActions(item: SessionListItem): readonly InfoCardAction[] {
  const actions = infoCardBinding(item, "actions");
  if (!Array.isArray(actions)) throw new Error("Expected info-card action list");
  return actions;
}

describe("SessionListItem", () => {
  test("selecting a delegate does not activate its containing parent row", () => {
    const child = new SessionListItem();
    child.session = { ...session(null), id: "child-1", parentSessionId: "session-1" };
    const selected: string[] = [];
    child.addEventListener("select-session", (event) => {
      if (event instanceof CustomEvent) selected.push(event.detail.sessionId);
    });
    const [activate] = collectTemplateEventListeners(child.render(), "info-card-activate");
    const event = new Event("info-card-activate", { bubbles: true, composed: true });

    activate?.(event);

    expect(selected).toEqual(["child-1"]);
    expect(event.cancelBubble).toBe(true);
  });

  test("binds the accessible pin to the title line and keeps activity and delegates trailing", () => {
    const item = new SessionListItem();
    item.session = { ...session("running"), pinned: true };
    item.childSessions = [{ ...session(null), id: "child-session", parentSessionId: "session-1" }];

    const titlePrefix = templateToString(infoCardBinding(item, "titlePrefix"));
    const trailing = templateToString(infoCardBinding(item, "trailing"));

    expect(titlePrefix).toContain('aria-label="Pinned"');
    expect(titlePrefix).toContain("<title>Pinned</title>");
    expect(trailing).not.toContain('aria-label="Pinned"');
    expect(trailing).toContain("activity-dot");
    expect(trailing).toContain("delegate-popover");
  });

  test("without sessions to act through, offers only copying its ID and moving it", () => {
    const item = new SessionListItem();
    item.session = session("unread");

    expect(infoCardActions(item).map((action) => action.label)).toEqual(["Copy session ID", "Move session…"]);
  });

  test("marks an unread session read, and a read one unread", async () => {
    const { sessions, writes } = recordingSessions("finished");
    const item = new SessionListItem();
    item.sessions = sessions;
    item.session = session("unread");

    await infoCardActions(item).find((action) => action.label === "Mark as read")?.run();
    item.session = session(null);
    await infoCardActions(item).find((action) => action.label === "Mark as unread")?.run();

    expect(writes).toEqual([
      'PATCH /api/sessions/session-1/activity {"unread":false}',
      'PATCH /api/sessions/session-1/activity {"unread":true}',
    ]);
  });

  test("provides rename, pin, and archive actions through the shared desktop/mobile action list", async () => {
    const { sessions, writes } = recordingSessions();
    const item = new SessionListItem();
    const renameRequests: string[] = [];
    item.addEventListener("rename-session", (event) => renameRequests.push(event.detail.sessionId));
    item.sessions = sessions;
    item.session = session(null);

    expect(infoCardActions(item).map((action) => action.label)).toEqual([
      "Copy session ID",
      "Mark as unread",
      "Move session…",
      "Rename",
      "Pin",
      "Archive",
    ]);
    await infoCardActions(item).find((action) => action.label === "Rename")?.run();
    await infoCardActions(item).find((action) => action.label === "Pin")?.run();
    await infoCardActions(item).find((action) => action.label === "Archive")?.run();
    expect(renameRequests).toEqual(["session-1"]);
    expect(writes).toEqual([
      'PATCH /api/sessions/session-1/metadata {"pinned":true}',
      'PATCH /api/sessions/session-1/metadata {"archived":true}',
    ]);

    item.session = { ...session(null), pinned: true, archived: true };
    expect(infoCardActions(item).map((action) => action.label)).toEqual([
      "Copy session ID",
      "Mark as unread",
      "Move session…",
      "Rename",
      "Unpin",
      "Unarchive",
    ]);
  });

  test("offers a move to another node, naming where the session is, and requests the move dialog", async () => {
    const item = new SessionListItem();
    const moveRequests: string[] = [];
    item.addEventListener("move-session", (event) => moveRequests.push(event.detail.sessionId));
    item.session = { ...session(null), nodeName: "Internal" };

    const move = infoCardActions(item).find((action) => action.label === "Move session…");
    expect(move).toMatchObject({ detail: "Node: Internal", disabled: false });
    await move?.run();
    expect(moveRequests).toEqual(["session-1"]);

  });

  test("marks a node that was removed, from which the session can still move", () => {
    const item = new SessionListItem();
    item.session = { ...session(null), nodeRemoved: true };

    expect(infoCardActions(item).find((action) => action.label === "Move session…")).toMatchObject({ detail: "Node: Laptop (removed)", disabled: false });
  });

  test("disables the move only while the session runs", () => {
    const item = new SessionListItem();
    const moveAction = () => infoCardActions(item).find((action) => action.label === "Move session…");

    item.session = session("running");
    expect(moveAction()).toMatchObject({ disabled: true, detail: "Unavailable while the session is running" });

    item.session = { ...session("unread"), nodeName: "Internal" };
    expect(moveAction()).toMatchObject({ disabled: false, detail: "Node: Internal" });
  });

  test("omits the read toggle while a session is running", () => {
    const item = new SessionListItem();
    item.sessions = recordingSessions("running").sessions;
    item.session = session("running");

    expect(infoCardActions(item).map((action) => action.label)).toEqual([
      "Copy session ID",
      "Move session…",
      "Rename",
      "Pin",
      "Archive",
    ]);
  });
});
