import { afterEach, describe, expect, test } from "bun:test";
import type { NodeView } from "@backend/models/node.js";
import type { ProjectView } from "@backend/routes/projects.js";
import { ProjectForm, type ProjectFormStore } from "../../components/project-form.js";
import { ProjectsStore } from "../../models/stores/projects-store.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import { collectTemplateEventListeners, collectTemplateProperties, submitDialog, templateToString } from "../helpers/lit-template.js";

const node = (id: string, name: string, connected: boolean): NodeView =>
  ({ id, name, connected, paired: id !== "internal", hostname: null, pairedAt: null, revokedAt: null, sources: [], build: null, failure: null });
const nodes = [node("internal", "Internal", true), node("desktop", "Desktop", true), node("laptop", "Laptop", false)];
const project: ProjectView = {
  id: 7, name: "App", base_branch: "main", default_source_id: 3, created_at: "2026-10-01T09:00:00.000Z", last_opened_at: "2026-10-01T09:00:00.000Z",
  defaultSource: { nodeId: "laptop", path: "/srv/app" },
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const originalInput = globalThis.HTMLInputElement;
const originalSelect = globalThis.HTMLSelectElement;
class TestField extends EventTarget { value = ""; }

afterEach(() => {
  restoreFetch();
  Reflect.set(globalThis, "HTMLInputElement", originalInput);
  Reflect.set(globalThis, "HTMLSelectElement", originalSelect);
});

/** The form, its nodes loaded through the projects store from `respond`, opened as `open` says. */
async function openForm(respond: (url: string, init?: RequestInit) => Response, open: Parameters<ProjectForm["open"]>[0]) {
  mockFetch(respond);
  const projects = new ProjectsStore();
  const form = new ProjectForm();
  const store: ProjectFormStore = {
    listNodes: () => projects.listNodes(),
    createProject: (data) => projects.createProject(data),
    updateProject: (projectId, data) => projects.updateProject(projectId, data),
  };
  form.store = store;
  form.open(open);
  for (let i = 0; i < 20 && Reflect.get(form, "nodes") === null; i++) await Bun.sleep(1);
  return form;
}

/** Types `value` into the default source's node selector (the form's only `@change`) or its path (the last `@input`). */
function typeInto(form: ProjectForm, event: "input" | "change", value: string) {
  Reflect.set(globalThis, event === "input" ? "HTMLInputElement" : "HTMLSelectElement", TestField);
  const field = new TestField();
  field.value = value;
  const fired = new Event(event);
  Object.defineProperty(fired, "target", { value: field });
  collectTemplateEventListeners(form.render(), event).at(-1)?.(fired);
}

/** The nodes the default source's selector offers, as [value, selected]. */
function offeredNodes(form: ProjectForm): Array<[string, boolean]> {
  const output = templateToString(form.render());
  return [...output.matchAll(/<option value=(\S+) \?selected=(true)?/g)].map((match) => [match[1]!, match[2] === "true"]);
}

const text = (form: ProjectForm) => templateToString(form.render()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

async function until(condition: () => boolean) {
  for (let i = 0; i < 50 && !condition(); i++) await Bun.sleep(1);
}

describe("ProjectForm: the project's default source", () => {
  test("a new project is created with its default source on the node and path chosen, a connected node offered first", async () => {
    const posts: unknown[] = [];
    const form = await openForm((url, init) => {
      if (url === "/api/nodes") return json(nodes);
      if (url === "/api/projects" && init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return json({ ...project, id: 8 }, 201); }
      return json([]);
    }, { mode: "create" });

    expect(offeredNodes(form)).toEqual([["internal", true], ["desktop", false], ["laptop", false]]);
    typeInto(form, "input", "/srv/new");
    Reflect.set(form, "name", "New");
    submitDialog(form.render());
    await until(() => posts.length > 0);

    expect(posts).toEqual([{ name: "New", path: "/srv/new", nodeId: "internal", base_branch: "main" }]);
  });

  test("editing shows the default source; Save changes it only when it changed", async () => {
    const patches: unknown[] = [];
    const respond = (url: string, init?: RequestInit) => {
      if (url === "/api/nodes") return json(nodes);
      if (url === "/api/projects/7" && init?.method === "PATCH") { patches.push(JSON.parse(String(init.body))); return json(project); }
      return json([]);
    };
    const unchanged = await openForm(respond, { mode: "edit", project });
    expect(offeredNodes(unchanged)).toEqual([["internal", false], ["desktop", false], ["laptop", true]]);
    expect(collectTemplateProperties(unchanged.render(), "value")).toContain("/srv/app");
    submitDialog(unchanged.render());
    await until(() => patches.length > 0);

    const moved = await openForm(respond, { mode: "edit", project });
    typeInto(moved, "change", "desktop");
    typeInto(moved, "input", "/home/me/app");
    submitDialog(moved.render());
    await until(() => patches.length > 1);

    expect(patches).toEqual([
      { name: "App", base_branch: "main" },
      { name: "App", base_branch: "main", defaultSource: { nodeId: "desktop", path: "/home/me/app" } },
    ]);
  });

  test("a default source the node refuses shows why and keeps the form open", async () => {
    const form = await openForm((url, init) => {
      if (url === "/api/nodes") return json(nodes);
      if (init?.method === "PATCH") return json({ error: "Directory does not exist: /srv/missing" }, 400);
      return json([]);
    }, { mode: "edit", project });

    typeInto(form, "input", "/srv/missing");
    submitDialog(form.render());
    await until(() => text(form).includes("Directory does not exist"));

    expect(text(form)).toContain("Directory does not exist: /srv/missing");
    expect(Reflect.get(form, "isOpen")).toBe(true);
  });
});
