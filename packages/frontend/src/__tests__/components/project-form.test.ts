import { afterEach, describe, expect, test } from "bun:test";
import type { NodeView } from "@backend/models/node.js";
import type { SourceView } from "@backend/models/sources.js";
import { ProjectForm, type ProjectFormStore } from "../../components/project-form.js";
import { ProjectsStore } from "../../models/stores/projects-store.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { clickButton, collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

const node = (id: string, name: string, connected: boolean): NodeView =>
  ({ id, name, connected, paired: id !== "internal", hostname: null, pairedAt: null, revokedAt: null, sources: [], build: null });
const nodes = [node("internal", "Internal", true), node("desktop", "Desktop", true), node("laptop", "Laptop", false)];
const internalCheckout: SourceView = { id: 1, nodeId: "internal", nodeName: "Internal", connected: true, path: "/home/me/app" };
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

/** The form editing `project`, its nodes and checkouts loaded through the projects store from `respond`. */
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
  for (let i = 0; i < 20 && !templateToString(form.render()).includes("Path on"); i++) await Bun.sleep(1);
  return form;
}

/** Types `value` into the new checkout's field: its node selector (the edit form's only `@change`) or its
 * path (the last `@input` before the base branch's). */
function typeInto(form: ProjectForm, event: "input" | "change", value: string) {
  Reflect.set(globalThis, event === "input" ? "HTMLInputElement" : "HTMLSelectElement", TestField);
  const field = new TestField();
  field.value = value;
  const fired = new Event(event);
  Object.defineProperty(fired, "target", { value: field });
  collectTemplateEventListeners(form.render(), event).at(event === "input" ? -2 : -1)?.(fired);
}

/** The nodes the new checkout's selector offers, as [value, selected]. */
function offeredNodes(form: ProjectForm): Array<[string, boolean]> {
  const output = templateToString(form.render());
  return [...output.matchAll(/<option value=(\S+) \?selected=(true)?/g)].map((match) => [match[1]!, match[2] === "true"]);
}

const text = (form: ProjectForm) => templateToString(form.render()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("ProjectForm: Add checkout", () => {
  test("offers the nodes the project has no checkout on, a connected one chosen, and adds the checkout there: it joins the list", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const form = await editForm((url, init) => {
      if (url === "/api/nodes") return json(nodes);
      if (url === "/api/projects/7/sources" && init?.method === "POST") {
        posts.push({ url, body: init.body });
        return json({ id: 2, nodeId: "laptop", nodeName: "Laptop", connected: false, path: "/srv/app" }, 201);
      }
      return json([internalCheckout]);
    });

    clickButton(form.render(), "Add checkout");
    expect(offeredNodes(form)).toEqual([["desktop", true], ["laptop", false]]);
    typeInto(form, "change", "laptop");
    typeInto(form, "input", "/srv/app");
    clickButton(form.render(), "Add");
    for (let i = 0; i < 20 && !text(form).includes("Path on Laptop"); i++) await Bun.sleep(1);

    expect(posts).toEqual([{ url: "/api/projects/7/sources", body: JSON.stringify({ nodeId: "laptop", path: "/srv/app" }) }]);
    expect(text(form)).toContain("Path on Internal");
    expect(text(form)).toContain("Path on Laptop (offline)");
    expect(text(form)).toContain("Add checkout");
  });

  test("a refused checkout shows the reason, naming the node, and keeps the new checkout's fields", async () => {
    const form = await editForm((url, init) => {
      if (url === "/api/nodes") return json(nodes);
      if (init?.method === "POST") return json({ error: "Directory does not exist: /srv/missing" }, 400);
      return json([internalCheckout]);
    });

    clickButton(form.render(), "Add checkout");
    typeInto(form, "input", "/srv/missing");
    clickButton(form.render(), "Add");
    for (let i = 0; i < 20 && !text(form).includes("Directory does not exist"); i++) await Bun.sleep(1);

    expect(text(form)).toContain("Desktop: Directory does not exist: /srv/missing");
    expect(text(form)).not.toContain("Path on Desktop");
    expect(offeredNodes(form)).toEqual([["desktop", true], ["laptop", false]]);
  });

  test("Enter in the new checkout's path adds it, not the form's Save", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    const form = await editForm((url, init) => {
      requests.push({ url, method: init?.method });
      if (url === "/api/nodes") return json(nodes);
      if (init?.method === "POST") return json({ id: 2, nodeId: "desktop", nodeName: "Desktop", connected: true, path: "/srv/app" }, 201);
      return json([internalCheckout]);
    });
    clickButton(form.render(), "Add checkout");
    typeInto(form, "input", "/srv/app");

    const enter = new Event("keydown", { cancelable: true });
    Object.defineProperty(enter, "key", { value: "Enter" });
    for (const listener of collectTemplateEventListeners(form.render(), "keydown")) listener(enter);
    for (let i = 0; i < 20 && !text(form).includes("Path on Desktop"); i++) await Bun.sleep(1);

    expect(enter.defaultPrevented).toBe(true);
    expect(requests.filter((request) => request.method)).toEqual([{ url: "/api/projects/7/sources", method: "POST" }]);
    expect(text(form)).toContain("Path on Desktop");
  });

  test("a project with a checkout on every node offers no Add checkout", async () => {
    const form = await editForm((url) => url === "/api/nodes" ? json([nodes[0]]) : json([internalCheckout]));
    // Both lists have loaded (each a single fetch).
    await Bun.sleep(5);

    expect(text(form)).not.toContain("Add checkout");
  });
});
