import { afterEach, describe, expect, test } from "bun:test";
import type { NodeView } from "@backend/models/node.js";
import type { SourceView } from "@backend/models/sources.js";
import { ProjectForm, type ProjectFormStore } from "../../components/project-form.js";
import { ProjectsStore } from "../../models/stores/projects-store.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { clickButton, collectTemplateEventListeners, collectTemplateProperties, submitDialog, templateToString } from "../helpers/lit-template.js";

const node = (id: string, name: string, connected: boolean): NodeView =>
  ({ id, name, connected, paired: id !== "internal", hostname: null, pairedAt: null, revokedAt: null, sources: [], build: null, failure: null });
const nodes = [node("internal", "Internal", true), node("desktop", "Desktop", true), node("laptop", "Laptop", false)];
const internalSource: SourceView = { id: 1, nodeId: "internal", nodeName: "Internal", connected: true, revoked: false, path: "/home/me/app" };
const project = { id: 7, name: "App", base_branch: "main", created_at: "2026-10-01T09:00:00.000Z", last_opened_at: "2026-10-01T09:00:00.000Z" };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const originalInput = globalThis.HTMLInputElement;
const originalSelect = globalThis.HTMLSelectElement;
class TestField extends EventTarget { value = ""; }

afterEach(() => {
  restoreFetch();
  Reflect.set(globalThis, "HTMLInputElement", originalInput);
  Reflect.set(globalThis, "HTMLSelectElement", originalSelect);
});

/** The form editing `project`, its nodes and sources loaded through the projects store from `respond`. */
async function editForm(respond: (url: string, init?: RequestInit) => Response) {
  mockFetch(respond);
  const projects = new ProjectsStore();
  const form = new ProjectForm();
  const store: ProjectFormStore = {
    listNodes: () => projects.listNodes(),
    listSources: (projectId) => projects.listSources(projectId),
    createProject: (data) => projects.createProject(data),
    updateProject: (projectId, data) => projects.updateProject(projectId, data),
    addSource: (projectId, nodeId, path) => projects.addSource(projectId, nodeId, path),
    moveSource: (projectId, sourceId, path) => projects.moveSource(projectId, sourceId, path),
  };
  form.store = store;
  form.open({ mode: "edit", project });
  // Both lists have loaded: the sources (no longer "Loading") and the nodes.
  for (let i = 0; i < 20 && (text(form).includes("Loading") || Reflect.get(form, "nodes") === null); i++) await Bun.sleep(1);
  return form;
}

/** Types `value` into the new source's field: its node selector (the edit form's only `@change`) or its
 * path (the last `@input`). */
function typeInto(form: ProjectForm, event: "input" | "change", value: string) {
  Reflect.set(globalThis, event === "input" ? "HTMLInputElement" : "HTMLSelectElement", TestField);
  const field = new TestField();
  field.value = value;
  const fired = new Event(event);
  Object.defineProperty(fired, "target", { value: field });
  collectTemplateEventListeners(form.render(), event).at(-1)?.(fired);
}

/** The nodes the new source's selector offers, as [value, selected]. */
function offeredNodes(form: ProjectForm): Array<[string, boolean]> {
  const output = templateToString(form.render());
  return [...output.matchAll(/<option value=(\S+) \?selected=(true)?/g)].map((match) => [match[1]!, match[2] === "true"]);
}

const text = (form: ProjectForm) => templateToString(form.render()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("ProjectForm: adding a source", () => {
  test("offers the nodes the project has no source on, a connected one chosen, and adds the source there: it joins the list", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const form = await editForm((url, init) => {
      if (url === "/api/nodes") return json(nodes);
      if (url === "/api/projects/7/sources" && init?.method === "POST") {
        posts.push({ url, body: init.body });
        return json({ id: 2, nodeId: "laptop", nodeName: "Laptop", connected: false, revoked: false, path: "/srv/app" }, 201);
      }
      return json([internalSource]);
    });

    expect(offeredNodes(form)).toEqual([["desktop", true], ["laptop", false]]);
    typeInto(form, "change", "laptop");
    typeInto(form, "input", "/srv/app");
    clickButton(form.render(), "Add");
    for (let i = 0; i < 20 && posts.length === 0; i++) await Bun.sleep(1);
    await Bun.sleep(1);

    expect(posts).toEqual([{ url: "/api/projects/7/sources", body: JSON.stringify({ nodeId: "laptop", path: "/srv/app" }) }]);
    expect(text(form)).toContain("Internal default");
    expect(text(form)).toContain("Laptop offline");
    // Only Desktop is left to add a source on.
    expect(offeredNodes(form)).toEqual([["desktop", true]]);
  });

  test("a refused source shows the reason under its row and keeps its fields", async () => {
    const form = await editForm((url, init) => {
      if (url === "/api/nodes") return json(nodes);
      if (init?.method === "POST") return json({ error: "Directory does not exist: /srv/missing" }, 400);
      return json([internalSource]);
    });

    typeInto(form, "input", "/srv/missing");
    clickButton(form.render(), "Add");
    for (let i = 0; i < 20 && !text(form).includes("Directory does not exist"); i++) await Bun.sleep(1);

    expect(text(form)).toContain("Add a source");
    expect(text(form)).toContain("Directory does not exist: /srv/missing");
    expect(collectTemplateProperties(form.render(), "value")).toContain("/srv/missing");
    expect(offeredNodes(form)).toEqual([["desktop", true], ["laptop", false]]);
  });

  test("Enter in the new source's path adds it, not the form's Save", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    const form = await editForm((url, init) => {
      requests.push({ url, method: init?.method });
      if (url === "/api/nodes") return json(nodes);
      if (init?.method === "POST") return json({ id: 2, nodeId: "desktop", nodeName: "Desktop", connected: true, revoked: false, path: "/srv/app" }, 201);
      return json([internalSource]);
    });
    typeInto(form, "input", "/srv/app");

    const enter = new Event("keydown", { cancelable: true });
    Object.defineProperty(enter, "key", { value: "Enter" });
    for (const listener of collectTemplateEventListeners(form.render(), "keydown")) listener(enter);
    for (let i = 0; i < 20 && !text(form).includes("Desktop"); i++) await Bun.sleep(1);

    expect(enter.defaultPrevented).toBe(true);
    expect(requests.filter((request) => request.method)).toEqual([{ url: "/api/projects/7/sources", method: "POST" }]);
    expect(collectTemplateProperties(form.render(), "value")).toContain("/srv/app");
  });

  test("Save adds a source left typed in the new source's row", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    const form = await editForm((url, init) => {
      if (init?.method) requests.push({ url, method: init.method });
      if (url === "/api/nodes") return json(nodes);
      if (url === "/api/projects/7" && init?.method) return json(project);
      if (init?.method === "POST") return json({ id: 2, nodeId: "desktop", nodeName: "Desktop", connected: true, revoked: false, path: "/srv/app" }, 201);
      return json([internalSource]);
    });
    typeInto(form, "input", "/srv/app");

    submitDialog(form.render());
    for (let i = 0; i < 20 && requests.length < 2; i++) await Bun.sleep(1);

    expect(requests.map((request) => request.url)).toEqual(["/api/projects/7", "/api/projects/7/sources"]);
  });

  test("a project with a source on every node offers no new source", async () => {
    const form = await editForm((url) => url === "/api/nodes" ? json([nodes[0]]) : json([internalSource]));

    expect(text(form)).not.toContain("Add a source");
  });
});

describe("ProjectForm: sources", () => {
  test("shows each source's node status, a revoked one's path not editable", async () => {
    const revoked: SourceView = { id: 3, nodeId: "old", nodeName: "Old", connected: false, revoked: true, path: "/old/app" };
    const offline: SourceView = { id: 4, nodeId: "laptop", nodeName: "Laptop", connected: false, revoked: false, path: "/srv/app" };
    const form = await editForm((url) => url === "/api/nodes" ? json(nodes) : json([internalSource, revoked, offline]));

    expect(text(form)).toContain("Internal default Old revoked Laptop offline");
    // The three source paths, before the new source's row and the dialog buttons.
    expect([...templateToString(form.render()).matchAll(/\?disabled=(true)?/g)].slice(0, 3).map((match) => match[1] === "true")).toEqual([false, true, false]);
  });

  test("a project's only source is not marked default", async () => {
    const form = await editForm((url) => url === "/api/nodes" ? json(nodes) : json([internalSource]));

    expect(text(form)).toContain("Internal");
    expect(text(form)).not.toContain("Internal default");
  });

  test("a refused move shows the reason under that source and keeps the form open", async () => {
    const form = await editForm((url, init) => {
      if (url === "/api/nodes") return json(nodes);
      if (url === "/api/projects/7" && init?.method) return json(project);
      if (init?.method === "PATCH") return json({ error: "Directory does not exist: /home/me/gone" }, 400);
      return json([internalSource]);
    });
    Reflect.set(globalThis, "HTMLInputElement", TestField);
    const field = new TestField();
    field.value = "/home/me/gone";
    const fired = new Event("input");
    Object.defineProperty(fired, "target", { value: field });
    // The inputs are the name, the base branch, then the source's path.
    collectTemplateEventListeners(form.render(), "input").at(2)?.(fired);

    submitDialog(form.render());
    for (let i = 0; i < 20 && !text(form).includes("Directory does not exist"); i++) await Bun.sleep(1);

    expect(text(form)).toContain("Internal Directory does not exist: /home/me/gone");
    expect(Reflect.get(form, "isOpen")).toBe(true);
  });

  test("a project with no source listed (its nodes removed) says so and offers a new one", async () => {
    const form = await editForm((url) => url === "/api/nodes" ? json(nodes) : json([]));

    expect(text(form)).toContain("No sources: add one on a node to work in this project.");
    expect(text(form)).toContain("Add a source");
  });
});
