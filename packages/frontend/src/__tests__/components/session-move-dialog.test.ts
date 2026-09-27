import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionMoveTargetView } from "@backend/routes/sessions.js";
import { SessionMoveDialog } from "../../components/session-move-dialog.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

const session = { id: "session-1", name: null, firstMessage: "Investigate the release" };
const targets: SessionMoveTargetView[] = [
  { nodeId: "remote", name: "Remote", connected: false, eligible: true },
  { nodeId: "laptop", name: "Laptop", connected: true, eligible: true },
  { nodeId: "alpha", name: "Alpha", connected: false, eligible: false, reason: "no_source" },
  { nodeId: "internal", name: "Internal", connected: true, eligible: false, reason: "current" },
];

const originalHtmlSelectElement = globalThis.HTMLSelectElement;

class TestSelectElement extends EventTarget {
  value = "";
}

afterEach(() => {
  Reflect.set(globalThis, "HTMLSelectElement", originalHtmlSelectElement);
});

/** The rendered node options, in order, as [value, disabled, label]. */
function options(dialog: SessionMoveDialog): Array<[string, boolean, string]> {
  const output = templateToString(dialog.render());
  return [...output.matchAll(/<option value=(\S+) \?disabled=(true)?[^>]*>([^<]*)<\/option>/g)]
    .map((match) => [match[1]!, match[2] === "true", match[3]!.trim()]);
}

function select(dialog: SessionMoveDialog, nodeId: string) {
  Reflect.set(globalThis, "HTMLSelectElement", TestSelectElement);
  const element = new TestSelectElement();
  element.value = nodeId;
  const event = new Event("change");
  Object.defineProperty(event, "target", { value: element });
  collectTemplateEventListeners(dialog.render(), "change")[0]?.(event);
}

/** Clicks the Move button (the last button in the dialog). */
function clickMove(dialog: SessionMoveDialog) {
  const clicks = collectTemplateEventListeners(dialog.render(), "click");
  return clicks[clicks.length - 1]?.(new Event("click"));
}

describe("SessionMoveDialog", () => {
  test("loads the nodes when opened and offers every node in the server's order, disabling ineligible ones with their reason", async () => {
    const dialog = new SessionMoveDialog();
    const loadTargets = mock(async () => targets);

    const opening = dialog.open(session, { loadTargets, move: async () => ({ ok: true as const }) });
    expect(templateToString(dialog.render())).toContain("Loading nodes…");
    await opening;

    expect(loadTargets).toHaveBeenCalledTimes(1);
    expect(templateToString(dialog.render())).toContain("Investigate the release");
    expect(options(dialog)).toEqual([
      ["remote", false, "Remote (offline)"],
      ["laptop", false, "Laptop"],
      ["alpha", true, "Alpha (offline) — no project source"],
      ["internal", true, "Internal — current"],
    ]);
  });

  test("preselects the first eligible node and moves to the chosen one", async () => {
    const dialog = new SessionMoveDialog();
    const move = mock(async (_nodeId: string) => ({ ok: true as const }));
    await dialog.open(session, { loadTargets: async () => targets, move });

    await clickMove(dialog);
    expect(move).toHaveBeenLastCalledWith("remote");

    await dialog.open(session, { loadTargets: async () => targets, move });
    select(dialog, "laptop");
    await clickMove(dialog);
    expect(move).toHaveBeenLastCalledWith("laptop");
  });

  test("shows Moving… while the move is requested, then a refused move inline, and lets the user try again", async () => {
    const dialog = new SessionMoveDialog();
    let refuse!: (result: { error: string }) => void;
    const move = mock((_nodeId: string) => new Promise<{ error: string }>((resolve) => { refuse = resolve; }));
    await dialog.open(session, { loadTargets: async () => targets, move });

    const moving = clickMove(dialog);
    expect(templateToString(dialog.render())).toContain("Moving…");
    await clickMove(dialog);
    expect(move).toHaveBeenCalledTimes(1);
    refuse({ error: "Session has pending work; try again when it is delivered" });
    await moving;

    const output = templateToString(dialog.render());
    expect(output).toContain("Session has pending work; try again when it is delivered");
    expect(output).not.toContain("Moving…");
    void clickMove(dialog);
    expect(move).toHaveBeenCalledTimes(2);
  });

  test("disables Move and says why when no node is eligible, and shows a failed load", async () => {
    const dialog = new SessionMoveDialog();
    const move = mock(async (_nodeId: string) => ({ ok: true as const }));

    await dialog.open(session, { loadTargets: async () => targets.filter((target) => !target.eligible), move });
    expect(templateToString(dialog.render())).toContain("No other node has a source for this project.");
    expect(templateToString(dialog.render())).toMatch(/\?disabled=true\s*>Move<\/button>/);
    await clickMove(dialog);
    expect(move).not.toHaveBeenCalled();

    await dialog.open(session, { loadTargets: async () => ({ error: "Session not found" }), move });
    expect(templateToString(dialog.render())).toContain("Session not found");
  });
});
