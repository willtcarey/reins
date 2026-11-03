import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionMoveTargetView } from "@backend/routes/sessions.js";
import { LocationDialog, type LocationDialogOptions } from "../../components/location-dialog.js";
import { collectTemplateEventListeners, collectTemplateProperties, submitDialog, templateToString } from "../helpers/lit-template.js";

/** The dialog as the session list opens it to move a session. */
function moving({ loadTargets, move }: Pick<LocationDialogOptions, "loadTargets"> & { move: LocationDialogOptions["choose"] }): LocationDialogOptions {
  return { heading: "Move Session", subtitle: "Investigate the release", confirmLabel: "Move", busyLabel: "Moving…", loadTargets, choose: move };
}
const targets: SessionMoveTargetView[] = [
  { nodeId: "alpha", name: "Alpha", connected: false, current: false, paths: [] },
  { nodeId: "internal", name: "Internal", connected: true, current: true, paths: ["/home/me/app"] },
  { nodeId: "laptop", name: "Laptop", connected: true, current: false, paths: ["/work/app", "/work/old-app"] },
];

const originalSelect = globalThis.HTMLSelectElement;
const originalInput = globalThis.HTMLInputElement;
class TestField extends EventTarget { value = ""; }

afterEach(() => {
  Reflect.set(globalThis, "HTMLSelectElement", originalSelect);
  Reflect.set(globalThis, "HTMLInputElement", originalInput);
});

/** The rendered node options, in order, as [value, label]. */
function options(dialog: LocationDialog): Array<[string, string]> {
  const output = templateToString(dialog.render());
  return [...output.matchAll(/<option value=(\S+) \?selected=[^>]*>([^<]*)<\/option>/g)].map((match) => [match[1]!, match[2]!.trim()]);
}

/** The paths suggested for the chosen node. */
function suggestions(dialog: LocationDialog): string[] {
  return [...templateToString(dialog.render()).matchAll(/<option value=(\S+)><\/option>/g)].map((match) => match[1]!);
}

const path = (dialog: LocationDialog) => collectTemplateProperties(dialog.render(), "value").at(-1);

function change(dialog: LocationDialog, event: "change" | "input", value: string) {
  Reflect.set(globalThis, event === "change" ? "HTMLSelectElement" : "HTMLInputElement", TestField);
  const field = new TestField();
  field.value = value;
  const fired = new Event(event);
  Object.defineProperty(fired, "target", { value: field });
  collectTemplateEventListeners(dialog.render(), event)[0]?.(fired);
}

describe("LocationDialog", () => {
  test("loads the nodes when opened and offers every one, the current one marked, first another where the project has worked", async () => {
    const dialog = new LocationDialog();
    const loadTargets = mock(async () => targets);

    const opening = dialog.open(moving({ loadTargets, move: async () => ({ ok: true as const }) }));
    expect(templateToString(dialog.render())).toContain("Loading nodes…");
    await opening;

    expect(loadTargets).toHaveBeenCalledTimes(1);
    expect(templateToString(dialog.render())).toContain("Investigate the release");
    expect(options(dialog)).toEqual([["alpha", "Alpha (offline)"], ["internal", "Internal — current"], ["laptop", "Laptop"]]);
    expect(Reflect.get(dialog, "selectedNodeId")).toBe("laptop");
    expect(path(dialog)).toBe("/work/app");
    expect(suggestions(dialog)).toEqual(["/work/app", "/work/old-app"]);
  });

  test("moves to the node and path chosen: choosing a node offers its paths, and any path can be typed", async () => {
    const dialog = new LocationDialog();
    const move = mock(async (_nodeId: string, _path: string) => ({ ok: true as const }));
    await dialog.open(moving({ loadTargets: async () => targets, move }));

    submitDialog(dialog.render());
    await Bun.sleep(0);
    expect(move).toHaveBeenLastCalledWith("laptop", "/work/app");

    await dialog.open(moving({ loadTargets: async () => targets, move }));
    change(dialog, "change", "alpha");
    expect(suggestions(dialog)).toEqual([]);
    expect(templateToString(dialog.render())).toMatch(/\?disabled=true[^>]*>Move<\/button>/);
    change(dialog, "input", "/srv/new-checkout");
    submitDialog(dialog.render());
    await Bun.sleep(0);
    expect(move).toHaveBeenLastCalledWith("alpha", "/srv/new-checkout");
  });

  test("shows Moving… while the move is requested, then a refused move inline, and lets the user try again", async () => {
    const dialog = new LocationDialog();
    let refuse!: (result: { error: string }) => void;
    const move = mock((_nodeId: string, _path: string) => new Promise<{ error: string }>((resolve) => { refuse = resolve; }));
    await dialog.open(moving({ loadTargets: async () => targets, move }));

    submitDialog(dialog.render());
    expect(templateToString(dialog.render())).toContain("Moving…");
    submitDialog(dialog.render());
    expect(move).toHaveBeenCalledTimes(1);
    refuse({ error: "Directory does not exist: /work/app" });
    await Bun.sleep(0);

    const output = templateToString(dialog.render());
    expect(output).toContain("Directory does not exist: /work/app");
    expect(output).not.toContain("Moving…");
    submitDialog(dialog.render());
    expect(move).toHaveBeenCalledTimes(2);
  });

  test("opened with a location, selects it, its path as given", async () => {
    const dialog = new LocationDialog();
    await dialog.open({ ...moving({ loadTargets: async () => targets, move: async () => ({ ok: true as const }) }), initial: { nodeId: "laptop", path: "/work/old-app" } });

    expect(Reflect.get(dialog, "selectedNodeId")).toBe("laptop");
    expect(path(dialog)).toBe("/work/old-app");
  });

  test("shows a failed load", async () => {
    const dialog = new LocationDialog();
    await dialog.open(moving({ loadTargets: async () => ({ error: "Session not found" }), move: async () => ({ ok: true as const }) }));
    expect(templateToString(dialog.render())).toContain("Session not found");
  });
});
