import { expect, test } from "bun:test";
import { WorkspaceLayout } from "../../models/workspace-layout.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("resizes panes while preserving a useful center, persists per device and resets", () => {
  const storage = memoryStorage();
  const layout = new WorkspaceLayout(storage, "laptop");
  layout.showInspectorView("file", 640);
  layout.resize("sessions", 500, 900);
  expect(layout.width("sessions", 900)).toBe(400);
  layout.resize("inspector", 500, 900);
  expect(layout.width("inspector", 900)).toBe(180);
  expect(new WorkspaceLayout(storage, "laptop").width("sessions", 900)).toBe(400);
  expect(new WorkspaceLayout(storage, "desktop").width("sessions", 900)).toBe(256);
  layout.reset("sessions");
  expect(layout.width("sessions", 900)).toBe(256);
});

test("gives the Inspector the width of its shown view, each view name keeping and resetting its own", () => {
  const storage = memoryStorage();
  const layout = new WorkspaceLayout(storage, "laptop");

  layout.showInspectorView("diff-file-tree", 240);
  expect(layout.width("inspector", 2000)).toBe(240);
  layout.resize("inspector", 180, 2000);
  layout.showInspectorView("file", 640);
  expect(layout.width("inspector", 2000)).toBe(640);
  layout.resize("inspector", 900, 2000);
  layout.showInspectorView("diff-file-tree", 240);
  expect(layout.width("inspector", 2000)).toBe(180);

  const restored = new WorkspaceLayout(storage, "laptop");
  restored.showInspectorView("file", 640);
  expect(restored.width("inspector", 2000)).toBe(900);
  restored.showInspectorView("diff-file-tree", 240);
  expect(restored.width("inspector", 2000)).toBe(180);

  restored.reset("inspector");
  expect(restored.width("inspector", 2000)).toBe(240);
  restored.showInspectorView("file", 640);
  expect(restored.width("inspector", 2000)).toBe(900);
});

test("a view that asks for no width gets the Inspector's default, and one asking too much its maximum", () => {
  const layout = new WorkspaceLayout(memoryStorage(), "laptop");
  layout.showInspectorView("plain");
  expect(layout.width("inspector", 2000)).toBe(320);
  layout.showInspectorView("huge", 5000);
  expect(layout.width("inspector", 2000)).toBe(960);
});

test("ignores invalid storage and reserves center width when viewport shrinks", () => {
  const storage = { getItem: () => '{"sessions":-3,"inspector":{"file":99999,"diff-file-tree":"wide"}}', setItem() {} };
  const layout = new WorkspaceLayout(storage, "device");
  layout.showInspectorView("file", 640);
  expect(layout.width("inspector", 2000)).toBe(640);
  layout.showInspectorView("diff-file-tree", 240);
  expect(layout.width("inspector", 2000)).toBe(240);
  expect(layout.width("sessions", 700) + layout.width("inspector", 700)).toBeLessThanOrEqual(380);
  expect(layout.width("sessions", 1200)).toBe(256);
});
