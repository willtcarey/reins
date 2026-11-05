import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionView } from "@backend/extensions/host.js";
import { SettingsExtensionDetails } from "../../../components/settings/extension-details.js";
import { SettingsExtensionsSection } from "../../../components/settings/extensions-section.js";
import { Loadable } from "../../../helpers/loadable.js";
import { ExtensionsStore } from "../../../models/stores/extensions-store.js";
import { clickButton, templateToString } from "../../helpers/lit-template.js";

const originalLocation = globalThis.location;
const originalHistory = globalThis.history;
const originalWindow = globalThis.window;
const originalHashChangeEvent = globalThis.HashChangeEvent;

afterEach(() => {
  Reflect.set(globalThis, "location", originalLocation);
  Reflect.set(globalThis, "history", originalHistory);
  Reflect.set(globalThis, "window", originalWindow);
  Reflect.set(globalThis, "HashChangeEvent", originalHashChangeEvent);
});

/** The rendered text as a user reads it: markup stripped, whitespace collapsed. */
function visibleText(element: { render(): unknown }): string {
  return templateToString(element.render()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function backendExtension(name: string, overrides: Partial<ExtensionView> = {}): ExtensionView {
  return {
    name,
    status: "loaded",
    failure: null,
    errors: [],
    registrations: { tools: null, images: null, promptSections: 0, settlementListeners: 0, scriptFunctions: [], httpMethods: [], pages: [] },
    services: [],
    storage: null,
    ...overrides,
  };
}

function loadedStore(extensions: ExtensionView[]): ExtensionsStore {
  const store = new ExtensionsStore();
  store.backend = Loadable.idle<ExtensionView[]>().asLoaded(extensions);
  return store;
}

describe("SettingsExtensionsSection", () => {
  test("a card for each extension, with its status, which opens the extension's details page", () => {
    const location = { hash: "#/settings/extensions" };
    Reflect.set(globalThis, "location", location);
    Reflect.set(globalThis, "history", { replaceState: (_state: unknown, _title: string, url: string) => { location.hash = url; } });
    Reflect.set(globalThis, "window", { dispatchEvent: () => true });
    Reflect.set(globalThis, "HashChangeEvent", class extends Event {});
    const section = new SettingsExtensionsSection();
    section.store = loadedStore([
      backendExtension("notes", { status: "failed", failure: { stage: "migration", message: "no such table: notes" } }),
      backendExtension("audit"),
    ]);

    const text = visibleText(section);
    clickButton(section.render(), "notes failed");

    expect(text).toContain("audit loaded");
    expect(text).toContain("notes failed");
    expect(location.hash).toBe("#/settings/extensions/notes/details");
  });

  test("a card shows each of its services' state", () => {
    const section = new SettingsExtensionsSection();
    section.store = loadedStore([backendExtension("notes", {
      services: [
        { name: "poll", state: "running", since: "2026-01-01T00:00:00.000Z", restarts: 0, nextAttemptAt: null, lastError: null },
        { name: "sync", state: "restarting", since: "2026-01-01T00:00:00.000Z", restarts: 2, nextAttemptAt: "2026-01-01T00:00:04.000Z", lastError: { message: "offline", at: "2026-01-01T00:00:00.000Z" } },
      ],
    })]);

    expect(visibleText(section)).toContain("poll running sync restarting");
  });
});

describe("SettingsExtensionDetails", () => {
  test("shows what it gives agents, its HTTP methods and pages, and what it keeps: its directory, its database's size and how many secrets", () => {
    const details = new SettingsExtensionDetails();
    details.store = loadedStore([backendExtension("notes", {
      registrations: { tools: { title: "Notes tools" }, images: { title: "Notes images" }, promptSections: 1, settlementListeners: 0, scriptFunctions: ["notes.list"], httpMethods: ["list"], pages: ["/extensions/notes/oauth/callback"] },
      storage: {
        dataDir: "/data/extensions/notes",
        databaseBytes: 4096,
        migrations: { applied: [{ id: "001_notes", appliedAt: "2026-01-01T00:00:00.000Z" }], pending: [] },
        secrets: 3,
      },
    })]);
    details.name = "notes";

    const text = visibleText(details);

    expect(text).toContain("For agents Tool providers Notes tools Image providers Notes images System prompt 1 section API functions api.notes.list");
    expect(text).toContain("HTTP Methods POST /api/extensions/notes/list Pages GET /extensions/notes/oauth/callback");
    expect(text).toContain("/data/extensions/notes");
    expect(text).toContain("4.0 KB");
    expect(text).toContain("Secrets 3");
  });

  test("shows each service's state, since when, its restarts, its next attempt and its last error", () => {
    const details = new SettingsExtensionDetails();
    details.store = loadedStore([backendExtension("notes", {
      services: [
        { name: "poll", state: "running", since: "2026-01-01T00:00:00.000Z", restarts: 0, nextAttemptAt: null, lastError: null },
        { name: "sync", state: "restarting", since: "2026-01-01T00:00:00.000Z", restarts: 2, nextAttemptAt: "2026-01-01T00:00:04.000Z", lastError: { message: "offline", at: "2026-01-01T00:00:00.000Z" } },
      ],
    })]);
    details.name = "notes";

    const text = visibleText(details);
    const since = new Date("2026-01-01T00:00:00.000Z").toLocaleString();
    const nextAttempt = new Date("2026-01-01T00:00:04.000Z").toLocaleString();

    expect(text).toContain(`Services poll running since ${since}`);
    expect(text).toContain(`sync restarting since ${since}, 2 restarts, next attempt ${nextAttempt} Last error: offline`);
  });

  test("shows how many listeners of its sessions' run ends it has, when it has any", () => {
    const details = new SettingsExtensionDetails();
    details.store = loadedStore([backendExtension("automation", {
      registrations: { tools: null, images: null, promptSections: 0, settlementListeners: 1, scriptFunctions: [], httpMethods: [], pages: [] },
    })]);
    details.name = "automation";

    expect(visibleText(details)).toContain("Sessions Run ends heard 1 listener");
  });

  test("shows what stopped a failed extension", () => {
    const details = new SettingsExtensionDetails();
    details.store = loadedStore([backendExtension("notes", { status: "failed", failure: { stage: "migration", message: "no such table: notes" } })]);
    details.name = "notes";

    const text = visibleText(details);

    expect(text).toContain("failed");
    expect(text).toContain("Backend: a migration failed: no such table: notes");
  });

  test("an extension the app does not have, once the report is loaded, says so", () => {
    const details = new SettingsExtensionDetails();
    details.store = loadedStore([backendExtension("notes")]);
    details.name = "missing";

    expect(visibleText(details)).toContain("No extension named “missing”.");
  });
});
