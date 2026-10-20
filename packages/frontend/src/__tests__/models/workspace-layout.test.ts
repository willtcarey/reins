import { expect, test } from "bun:test";
import { WorkspaceLayout } from "../../models/workspace-layout.js";

test("resizes panes while preserving a useful center, persists per device and resets", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const layout = new WorkspaceLayout(storage, "laptop");
  layout.resize("sessions", 500, 900);
  expect(layout.width("sessions", 900)).toBe(400);
  layout.resize("inspector", 500, 900);
  expect(layout.width("inspector", 900)).toBe(180);
  expect(new WorkspaceLayout(storage, "laptop").width("sessions", 900)).toBe(400);
  expect(new WorkspaceLayout(storage, "desktop").width("sessions", 900)).toBe(256);
  layout.reset("sessions");
  expect(layout.width("sessions", 900)).toBe(256);
});

test("lets the Inspector grow wide on a wide window and remembers its width", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const layout = new WorkspaceLayout(storage, "laptop");

  layout.resize("inspector", 900, 2000);

  expect(layout.width("inspector", 2000)).toBe(900);
  expect(new WorkspaceLayout(storage, "laptop").width("inspector", 2000)).toBe(900);
});

test("ignores invalid storage and reserves center width when viewport shrinks", () => {
  const storage = { getItem: () => '{"sessions":-3,"files":99999}', setItem() {} };
  const layout = new WorkspaceLayout(storage, "device");
  expect(layout.width("sessions", 700) + layout.width("inspector", 700)).toBeLessThanOrEqual(380);
  expect(layout.width("sessions", 1200)).toBe(256);
});
