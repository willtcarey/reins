import { afterEach, describe, expect, mock, test } from "bun:test";
import { AppShell } from "../../components/app.js";
import { collectTemplateValues, templateToString } from "../helpers/lit-template.js";

const originalLocation = globalThis.location;

function fullOutput(value: unknown): string {
  return `${templateToString(value)}\n${templateToString(collectTemplateValues(value))}`;
}

function installLocation() {
  Reflect.set(globalThis, "location", { protocol: "http:", host: "localhost:3000" });
}

function installStore(shell: AppShell, route: { name: string; params: Record<string, string> }) {
  Reflect.set(shell, "currentRoute", route);
  Reflect.set(shell, "appStore", {
    connected: true,
    projects: [{ id: 42, name: "Reins" }],
    projectsStore: {},
    settingsStore: {},
  });
}

afterEach(() => {
  Reflect.set(globalThis, "location", originalLocation);
});

describe("AppShell route outlet", () => {
  test("owns route selection and records session visits", () => {
    installLocation();
    const shell = new AppShell();
    const routes = Reflect.get(shell, "routes");
    const quickOpenStore = Reflect.get(shell, "quickOpenStore");

    routes.applyRoute({ name: "session", params: { sessionId: "s1" } });

    expect(Reflect.get(shell, "currentRoute")).toEqual({
      name: "session",
      params: { sessionId: "s1" },
    });
    expect(quickOpenStore.recentIds[0]).toBe("s1");
  });

  test("renders the registered workspace page for session routes", () => {
    installLocation();
    const shell = new AppShell();
    installStore(shell, { name: "session", params: { sessionId: "s1" } });

    const output = fullOutput(shell.render());

    expect(output).toContain("<app-workspace");
    expect(output).not.toContain("<project-history");
  });

  test("renders the registered full-screen History page without workspace-specific branching", () => {
    installLocation();
    const shell = new AppShell();
    installStore(shell, { name: "project-history", params: { projectId: "42" } });

    const output = fullOutput(shell.render());

    expect(output).toContain("<project-history");
    expect(output).toContain("Reins");
    expect(output).not.toContain("<app-workspace");
  });

  test("opens files and browser overlays with explicit project scope", () => {
    installLocation();
    const shell = new AppShell();
    const openFile = mock(() => {});
    Object.defineProperty(shell, "fileBrowser", { value: { openFile }, configurable: true });

    Reflect.get(shell, "handleOpenInBrowser")(new CustomEvent("open-in-browser", {
      detail: { projectId: 42, path: "src/index.ts", startLine: 2, endLine: 4 },
    }));

    expect(openFile).toHaveBeenCalledWith(42, "src/index.ts", { startLine: 2, endLine: 4 }, undefined);
  });

  test("keeps global overlays outside the routed page", () => {
    installLocation();
    const shell = new AppShell();
    installStore(shell, { name: "empty", params: {} });

    const output = fullOutput(shell.render());

    expect(output).toContain("<quick-open");
    expect(output).toContain("<file-search");
    expect(output).toContain("<file-browser");
    expect(output).toContain("<settings-panel");
  });
});
