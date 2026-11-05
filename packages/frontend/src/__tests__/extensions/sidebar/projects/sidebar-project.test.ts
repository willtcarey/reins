import { afterEach, describe, expect, mock, test } from "bun:test";
import { PartType, type PartInfo } from "lit/directive.js";
import type { Project } from "@reins/sdk";
import { moveSessionEvent } from "../../../../components/events.js";
import { SidebarProject } from "../../../../extensions/sidebar/projects/sidebar-project.js";
import { SpringCollapseDirective } from "../../../../directives/spring-collapse.js";
import { makeSessionListItem } from "../../../helpers/fixtures.js";
import {
  collectTemplateEventListeners,
  collectTemplateValues,
  isTemplateResult,
  templateToString,
} from "../../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../../helpers/mock-fetch.js";
import { testSdk } from "../../../helpers/reins-sdk.js";

interface DirectiveResult {
  _$litDirective$: typeof SpringCollapseDirective;
  values: Parameters<SpringCollapseDirective["render"]>;
}

const project: Project = { id: 7, name: "Reins", activity: null, baseBranch: "master", defaultSource: { nodeId: "internal", path: "/home/me/reins" } };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Project 7 loaded, with `sessions` cached; what reaches the server is recorded, answered by `respond`. */
function loadedProject(sessions: ReturnType<typeof makeSessionListItem>[] = [], respond: (url: string, init?: RequestInit) => Response = () => json({})) {
  const sdk = testSdk();
  sdk.sessions.setMany(sessions);
  sdk.projectsStore.getStore(7).loaded = true;
  const writes: string[] = [];
  mockFetch((url, init) => {
    if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url} ${init.body ?? ""}`.trim());
    return respond(url, init);
  });
  const element = new SidebarProject();
  element.project = project;
  element.reins = sdk.reins;
  return { element, writes, sdk };
}

const session = (id: string, overrides: Parameters<typeof makeSessionListItem>[1] = {}) => makeSessionListItem(id, { projectId: 7, name: id, firstMessage: id, ...overrides });

function renderCollapse(element: SidebarProject) {
  const collapse = collectTemplateValues(element.render()).find((value): value is DirectiveResult => (
    typeof value === "object"
      && value !== null
      && "_$litDirective$" in value
      && value._$litDirective$ === SpringCollapseDirective
  ));
  if (!collapse) throw new Error("Expected spring collapse directive");

  const childPart: PartInfo = { type: PartType.CHILD };
  return new SpringCollapseDirective(childPart).render(...collapse.values);
}

afterEach(restoreFetch);

describe("SidebarProject", () => {
  test("lazily renders the project task list while expanded", () => {
    const { element } = loadedProject();
    element.expanded = false;

    expect(templateToString(renderCollapse(element))).not.toContain("<task-list");

    element.expanded = true;

    expect(templateToString(renderCollapse(element))).toContain("<task-list");
  });

  test("shows Loading until the project's tasks and conversations have loaded", () => {
    mockFetch(() => new Promise<Response>(() => {}));
    const element = new SidebarProject();
    element.project = project;
    element.reins = testSdk().reins;
    element.expanded = true;

    expect(templateToString(renderCollapse(element))).toContain("Loading...");
  });

  test("renders its assistant's conversations, pinned first, through the shared actionable session row", () => {
    const { element } = loadedProject([
      session("recent", { updatedAt: "2026-01-03T00:00:00Z" }),
      session("pinned", { pinnedAt: "2026-01-02T00:00:00Z" }),
    ]);
    element.activeSessionId = "recent";
    element.expanded = true;

    const rendered = renderCollapse(element);
    const rows = collectTemplateValues(rendered)
      .flatMap((value) => Array.isArray(value) ? value : [])
      .filter((value) => isTemplateResult(value) && value.strings.join("").includes("<session-list-item"));

    expect(templateToString(rendered)).toContain("Assistant");
    expect(rows.map((row) => isTemplateResult(row) ? Reflect.get(Object(row.values[0]), "id") : null)).toEqual(["pinned", "recent"]);
    expect(isTemplateResult(rows[1]) && rows[1].values).toContain(true);
  });

  test("renders the empty state and dispatches new sessions for the project", () => {
    const { element } = loadedProject();
    element.expanded = true;
    const newSessionDetails: unknown[] = [];
    element.addEventListener("new-session", (event) => {
      if (event instanceof CustomEvent) newSessionDetails.push(event.detail);
    });

    const rendered = renderCollapse(element);
    const clicks = collectTemplateEventListeners(rendered, "click");
    clicks[0]?.call(element, new CustomEvent("click"));
    clicks[1]?.call(element, new CustomEvent("click"));

    expect(templateToString(rendered)).toContain("Start a conversation");
    expect(newSessionDetails).toEqual([{ projectId: 7 }, { projectId: 7 }]);
  });

  test("moves its project's sessions to a node", async () => {
    const targets = [{ nodeId: "internal", name: "Internal", connected: true, current: false, paths: ["/home/me/reins"] }];
    const { element, writes } = loadedProject([session("own-session"), session("other-session", { projectId: 8 })], (url) => url.endsWith("/move-targets")
      ? json(targets)
      : json({ available: true, removed: false, nodeId: "internal", nodeName: "Internal", path: "/home/me/reins" }));
    const dialog = { open: mock(async (_options: { heading: string; loadTargets: () => Promise<unknown>; choose: (nodeId: string, path: string) => Promise<unknown> }) => {}) };
    Object.defineProperty(element, "moveDialog", { value: dialog });
    const [openMove] = collectTemplateEventListeners(element.render(), "move-session");

    await openMove?.call(element, moveSessionEvent("other-session"));
    expect(dialog.open).not.toHaveBeenCalled();
    await openMove?.call(element, moveSessionEvent("own-session"));

    const [actions] = dialog.open.mock.calls[0]!;
    expect(actions).toMatchObject({ heading: "Move Session" });
    expect(await actions.loadTargets()).toEqual(targets);
    expect(await actions.choose("internal", "/home/me/reins")).toEqual({ ok: true });
    expect(writes).toEqual(['POST /api/sessions/own-session/move {"nodeId":"internal","path":"/home/me/reins"}']);
  });
});
