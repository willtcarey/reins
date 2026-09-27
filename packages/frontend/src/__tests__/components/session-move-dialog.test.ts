import { describe, expect, mock, test } from "bun:test";
import type { SessionMoveTargetView } from "@backend/routes/sessions.js";
import { SessionMoveDialog } from "../../components/session-move-dialog.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

const session = { id: "session-1", name: null, firstMessage: "Investigate the release" };
const targets: SessionMoveTargetView[] = [
  { nodeId: "internal", name: "Internal", current: true, connected: true },
  { nodeId: "remote", name: "Remote", current: false, connected: false },
];

/** Clicks the target row for `nodeId` (target buttons render in list order, before Cancel). */
function clickTarget(dialog: SessionMoveDialog, nodeId: string) {
  const index = targets.findIndex((target) => target.nodeId === nodeId);
  return collectTemplateEventListeners(dialog.render(), "click")[index + 1]?.(new Event("click"));
}

describe("SessionMoveDialog", () => {
  test("lists the nodes, marking the current one, and moves to the chosen node", async () => {
    const dialog = new SessionMoveDialog();
    const move = mock(async (_nodeId: string) => ({ ok: true as const }));

    const opening = dialog.open(session, { loadTargets: async () => targets, move });
    expect(templateToString(dialog.render())).toContain("Loading nodes…");
    await opening;

    const output = templateToString(dialog.render());
    expect(output).toContain("Investigate the release");
    expect(output).toContain("Internal");
    expect(output).toContain("Current");
    expect(output).toContain("Remote");
    expect(output).toContain("Not connected");

    await clickTarget(dialog, "internal");
    expect(move).not.toHaveBeenCalled();
    await clickTarget(dialog, "remote");
    expect(move).toHaveBeenCalledWith("remote");
  });

  test("shows a failed move and lets the user choose again", async () => {
    const dialog = new SessionMoveDialog();
    const move = mock(async (_nodeId: string) => ({ error: "Session has pending work; try again when it is delivered" }));
    await dialog.open(session, { loadTargets: async () => targets, move });

    await clickTarget(dialog, "remote");

    const output = templateToString(dialog.render());
    expect(output).toContain("Session has pending work; try again when it is delivered");
    expect(output).not.toContain("Moving…");
    await clickTarget(dialog, "remote");
    expect(move).toHaveBeenCalledTimes(2);
  });

  test("explains when the targets cannot be loaded or no other node has the project", async () => {
    const dialog = new SessionMoveDialog();
    const move = mock(async (_nodeId: string) => ({ ok: true as const }));

    await dialog.open(session, { loadTargets: async () => ({ error: "Session not found" }), move });
    expect(templateToString(dialog.render())).toContain("Session not found");

    await dialog.open(session, { loadTargets: async () => [targets[0]!], move });
    expect(templateToString(dialog.render())).toContain("No other node has a source for this project.");
  });
});
