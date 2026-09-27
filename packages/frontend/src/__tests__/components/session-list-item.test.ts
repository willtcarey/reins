import { describe, expect, mock, test } from "bun:test";
import { SessionListItem } from "../../components/session-list-item.js";
import type { InfoCardAction } from "../../ui/info-card.js";
import type { SessionListView as SessionListItemData } from "@backend/models/sessions.js";
import { collectTemplateEventListeners, isTemplateResult, templateToString } from "../helpers/lit-template.js";

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
    pinnedAt: null,
    archivedAt: null,
    placement: { status: "server", error: null, available: true, nodeId: "laptop", nodeName: "Laptop" },
  };
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
    item.session = { ...session("running"), pinnedAt: "2026-01-02T00:00:00Z" };
    item.childSessions = [{ ...session(null), id: "child-session", parentSessionId: "session-1" }];

    const titlePrefix = templateToString(infoCardBinding(item, "titlePrefix"));
    const trailing = templateToString(infoCardBinding(item, "trailing"));

    expect(titlePrefix).toContain('aria-label="Pinned"');
    expect(titlePrefix).toContain("<title>Pinned</title>");
    expect(trailing).not.toContain('aria-label="Pinned"');
    expect(trailing).toContain("activity-dot");
    expect(trailing).toContain("delegate-popover");
  });

  test("provides read and unread info-card actions", async () => {
    const item = new SessionListItem();
    const setSessionUnread = mock(async () => ({ ok: true }));
    item.onSetSessionUnread = setSessionUnread;
    item.session = session("finished");

    const finishedActions = infoCardActions(item);
    expect(finishedActions.map((action) => action.label)).toEqual([
      "Copy session ID",
      "Mark as read",
      "Move to node…",
    ]);
    const markRead = finishedActions.find((action) => action.label === "Mark as read");
    await markRead?.run();
    expect(setSessionUnread).toHaveBeenCalledWith("session-1", false);

    item.session = session(null);
    const idleActions = infoCardActions(item);
    expect(idleActions.map((action) => action.label)).toEqual([
      "Copy session ID",
      "Mark as unread",
      "Move to node…",
    ]);
    const markUnread = idleActions.find((action) => action.label === "Mark as unread");
    await markUnread?.run();
    expect(setSessionUnread).toHaveBeenCalledWith("session-1", true);
  });

  test("provides rename, pin, and archive actions through the shared desktop/mobile action list", async () => {
    const item = new SessionListItem();
    const updateMetadata = mock(async () => ({ ok: true }));
    const renameRequests: string[] = [];
    item.addEventListener("rename-session", (event) => renameRequests.push(event.detail.sessionId));
    item.onUpdateMetadata = updateMetadata;
    item.session = session(null);

    expect(infoCardActions(item).map((action) => action.label)).toEqual([
      "Copy session ID",
      "Move to node…",
      "Rename",
      "Pin",
      "Archive",
    ]);
    await infoCardActions(item).find((action) => action.label === "Rename")?.run();
    await infoCardActions(item).find((action) => action.label === "Pin")?.run();
    await infoCardActions(item).find((action) => action.label === "Archive")?.run();
    expect(renameRequests).toEqual(["session-1"]);
    expect(updateMetadata).toHaveBeenNthCalledWith(1, "session-1", { pinned: true });
    expect(updateMetadata).toHaveBeenNthCalledWith(2, "session-1", { archived: true });

    item.session = { ...session(null), pinnedAt: "2026-01-02T00:00:00Z", archivedAt: "2026-01-03T00:00:00Z" };
    expect(infoCardActions(item).map((action) => action.label)).toEqual([
      "Copy session ID",
      "Move to node…",
      "Rename",
      "Unpin",
      "Unarchive",
    ]);
  });

  test("offers a move to another node, naming where the session is, and requests the move dialog", async () => {
    const item = new SessionListItem();
    const moveRequests: string[] = [];
    item.addEventListener("move-session", (event) => moveRequests.push(event.detail.sessionId));
    item.session = { ...session(null), placement: { status: "provisioned", error: null, available: true, nodeId: "internal", nodeName: "Internal" } };

    const move = infoCardActions(item).find((action) => action.label === "Move to node…");
    expect(move).toMatchObject({ detail: "Node: Internal", disabled: false });
    await move?.run();
    expect(moveRequests).toEqual(["session-1"]);

    // At rest on the server it still names the node it will run on.
    item.session = session(null);
    expect(infoCardActions(item).find((action) => action.label === "Move to node…")?.detail).toBe("Node: Laptop");
  });

  test("disables the move only while the session runs or moves", () => {
    const item = new SessionListItem();
    const moveAction = () => infoCardActions(item).find((action) => action.label === "Move to node…");

    item.session = session("running");
    expect(moveAction()).toMatchObject({ disabled: true, detail: "Unavailable while the session is running" });

    item.session = { ...session(null), placement: { status: "moving", error: null, available: true, nodeId: "internal", nodeName: "Internal" } };
    expect(moveAction()).toMatchObject({ disabled: true, detail: "Moving to Internal…" });
    expect(templateToString(infoCardBinding(item, "subtitle"))).toContain("Moving to Internal…");

    item.session = { ...session("finished"), placement: { status: "provisioned", error: null, available: true, nodeId: "internal", nodeName: "Internal" } };
    expect(moveAction()).toMatchObject({ disabled: false, detail: "Node: Internal" });
  });

  test("shows provisioning and move states from the session's placement instead of its message count", () => {
    const item = new SessionListItem();
    const subtitle = () => templateToString(infoCardBinding(item, "subtitle"));
    const placed = (placement: Omit<SessionListItemData["placement"], "nodeId" | "nodeName"> & { nodeName?: string }) => {
      item.session = { ...session(null), placement: { nodeId: "internal", nodeName: "Internal", ...placement } };
    };

    placed({ status: "provisioned", error: null, available: true });
    expect(subtitle()).toContain("2 messages");
    placed({ status: "provisioning", error: null, available: true });
    expect(subtitle()).toContain("Provisioning ·");
    expect(subtitle()).not.toContain("messages");
    placed({ status: "provisioning", error: null, available: false });
    expect(subtitle()).toContain("Provisioning · source unavailable");
    placed({ status: "provision_failed", error: "Model not found: a/b", available: true });
    expect(subtitle()).toContain("Provisioning failed: Model not found: a/b");
    placed({ status: "moving", error: null, available: true, nodeName: "Laptop" });
    expect(subtitle()).toContain("Moving to Laptop…");
    // A failed move returns the session to where it rested and keeps the reason.
    placed({ status: "server", error: "digest mismatch", available: true });
    expect(subtitle()).toContain("Move failed: digest mismatch");
    placed({ status: "provisioned", error: "node gone", available: true });
    expect(subtitle()).toContain("Move failed: node gone");
    placed({ status: "server", error: null, available: true });
    expect(subtitle()).toContain("2 messages");
  });

  test("omits the read toggle while a session is running", () => {
    const item = new SessionListItem();
    item.onSetSessionUnread = mock(async () => ({ ok: true }));
    item.onUpdateMetadata = mock(async () => ({ ok: true }));
    item.session = session("running");

    expect(infoCardActions(item).map((action) => action.label)).toEqual([
      "Copy session ID",
      "Move to node…",
      "Rename",
      "Pin",
      "Archive",
    ]);
  });
});
