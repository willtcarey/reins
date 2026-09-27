import { afterEach, describe, expect, mock, test } from "bun:test";
import { PartType, type PartInfo } from "lit/directive.js";
import { moveSessionEvent, renameSessionEvent, saveSessionNameEvent } from "../../components/events.js";
import { SidebarProject } from "../../components/sidebar-project.js";
import { SpringCollapseDirective } from "../../directives/spring-collapse.js";
import { ProjectStore } from "../../models/stores/project-store.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { SessionListView as SessionListItem } from "@backend/models/sessions.js";
import type { SessionMoveTargetView } from "@backend/routes/sessions.js";
import type { Project as ProjectInfo } from "@backend/project-store.js";
import {
  collectTemplateEventListeners,
  collectTemplateValues,
  isTemplateResult,
  templateToString,
} from "../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";

interface DirectiveResult {
  _$litDirective$: typeof SpringCollapseDirective;
  values: Parameters<SpringCollapseDirective["render"]>;
}

const projectInfo: ProjectInfo = {
  id: 7,
  name: "Reins",
  path: "/work/reins",
  base_branch: "master",
  created_at: "2026-01-01T00:00:00Z",
  last_opened_at: "2026-01-01T00:00:00Z",
};

function session(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    projectId: 7,
    taskId: null,
    parentSessionId: null,
    name: id,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    messageCount: 1,
    firstMessage: id,
    activityState: null,
    pinnedAt: null,
    archivedAt: null,
    location: { state: "server" },
    ...overrides,
  };
}

function renderCollapse(project: SidebarProject) {
  const collapse = collectTemplateValues(project.render()).find((value): value is DirectiveResult => (
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
  test("updates when its project data finishes loading", async () => {
    mockFetch(() => Response.json([]));
    const project = new SidebarProject();
    const store = new ProjectStore(7);
    let updates = 0;
    project.requestUpdate = () => { updates += 1; };
    project.projectStore = store;
    const updatesAfterAssignment = updates;

    await store.fetchLists();

    expect(updates - updatesAfterAssignment).toBe(2);
  });

  test("lazily renders the project task list while expanded", () => {
    const project = new SidebarProject();
    project.project = projectInfo;
    project.expanded = false;

    expect(templateToString(renderCollapse(project))).not.toContain("<task-list");

    project.expanded = true;

    expect(templateToString(renderCollapse(project))).toContain("<task-list");
  });

  test("renders ordered scratch sessions through the shared actionable session row", () => {
    const cache = new SessionCache();
    const recent = session("recent", { updatedAt: "2026-01-03T00:00:00Z" });
    const pinned = session("pinned", {
      pinnedAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    cache.setMany([recent, pinned]);
    const store = new ProjectStore(7, cache);
    store.sessionIds = [recent.id, pinned.id];
    store.setSessionUnread = mock(async () => ({ ok: true as const }));
    store.updateSessionMetadata = mock(async () => ({ ok: true as const }));
    const project = new SidebarProject();
    project.project = projectInfo;
    project.projectStore = store;
    project.activeSessionId = recent.id;
    project.expanded = true;

    const rendered = renderCollapse(project);
    const rows = collectTemplateValues(rendered)
      .flatMap((value) => Array.isArray(value) ? value : [])
      .filter((value) => isTemplateResult(value) && value.strings.join("").includes("<session-list-item"));

    expect(templateToString(rendered)).toContain("Assistant");
    expect(templateToString(rendered).match(/<session-list-item/g)?.length).toBe(2);
    expect(rows[0]?.values[0]).toMatchObject({ id: pinned.id });
    expect(rows[1]?.values[0]).toMatchObject({ id: recent.id });
    expect(rows[1]?.values).toContain(true);
    expect(rows[0]?.values.filter((value: unknown) => typeof value === "function")).toHaveLength(2);
  });

  test("renders the scratch-session empty state and dispatches new sessions for the project", () => {
    const project = new SidebarProject();
    project.project = projectInfo;
    project.projectStore = new ProjectStore(7, new SessionCache());
    project.expanded = true;
    const newSessionDetails: unknown[] = [];
    project.addEventListener("new-session", (event) => {
      if (event instanceof CustomEvent) newSessionDetails.push(event.detail);
    });

    const rendered = renderCollapse(project);
    const clicks = collectTemplateEventListeners(rendered, "click");
    clicks[0]?.call(project, new CustomEvent("click"));
    clicks[1]?.call(project, new CustomEvent("click"));

    expect(templateToString(rendered)).toContain("Start a conversation");
    expect(newSessionDetails).toEqual([
      { projectId: 7 },
      { projectId: 7 },
    ]);
  });

  test("renames scratch, task, and delegate sessions through its project store", async () => {
    const cache = new SessionCache();
    const sessions = [
      session("scratch-1", { name: "Scratch", firstMessage: "Scratch prompt" }),
      session("task-1", { taskId: 42, name: "Task", firstMessage: "Task prompt" }),
      session("delegate-1", { parentSessionId: "task-1", name: "Delegate", firstMessage: "Delegate prompt" }),
    ];
    cache.setMany(sessions);
    const store = new ProjectStore(7, cache);
    const updateSessionMetadata = mock(async () => ({ ok: true as const }));
    store.updateSessionMetadata = updateSessionMetadata;
    const project = new SidebarProject();
    project.project = projectInfo;
    project.projectStore = store;
    const dialog = { open: mock(() => {}), saveComplete: mock(() => {}) };
    Object.defineProperty(project, "sessionRenameDialog", { value: dialog });
    const rendered = project.render();
    const [openRename] = collectTemplateEventListeners(rendered, "rename-session");
    const [saveRename] = collectTemplateEventListeners(rendered, "save-session-name");

    for (const candidate of sessions) {
      await openRename?.call(project, renameSessionEvent(candidate.id));
    }
    await saveRename?.call(project, saveSessionNameEvent({ sessionId: "delegate-1", name: "Research" }));

    expect(dialog.open).toHaveBeenNthCalledWith(1, expect.objectContaining(sessions[0]));
    expect(dialog.open).toHaveBeenNthCalledWith(2, expect.objectContaining(sessions[1]));
    expect(dialog.open).toHaveBeenNthCalledWith(3, expect.objectContaining(sessions[2]));
    expect(updateSessionMetadata).toHaveBeenCalledWith("delegate-1", { name: "Research" });
    expect(dialog.saveComplete).toHaveBeenCalledWith(undefined);
  });

  test("keeps rename handling scoped to its project and reports save errors", async () => {
    const cache = new SessionCache();
    cache.setMany([
      session("own-session"),
      session("other-session", { projectId: 8 }),
    ]);
    const store = new ProjectStore(7, cache);
    store.updateSessionMetadata = mock(async () => ({ error: "Rename failed" }));
    const project = new SidebarProject();
    project.project = projectInfo;
    project.projectStore = store;
    const dialog = { open: mock(() => {}), saveComplete: mock(() => {}) };
    Object.defineProperty(project, "sessionRenameDialog", { value: dialog });
    const rendered = project.render();
    const [openRename] = collectTemplateEventListeners(rendered, "rename-session");
    const [saveRename] = collectTemplateEventListeners(rendered, "save-session-name");

    await openRename?.call(project, renameSessionEvent("other-session"));
    await saveRename?.call(project, saveSessionNameEvent({ sessionId: "own-session", name: "New name" }));

    expect(dialog.open).not.toHaveBeenCalled();
    expect(store.updateSessionMetadata).toHaveBeenCalledWith("own-session", { name: "New name" });
    expect(dialog.saveComplete).toHaveBeenCalledWith("Rename failed");
  });

  test("moves its project's sessions to a node through its project store", async () => {
    const cache = new SessionCache();
    cache.setMany([session("own-session"), session("other-session", { projectId: 8 })]);
    const store = new ProjectStore(7, cache);
    const targets: SessionMoveTargetView[] = [{ nodeId: "internal", name: "Internal", connected: true, eligible: true }];
    store.loadMoveTargets = mock(async () => targets);
    store.moveSession = mock(async () => ({ ok: true as const }));
    const project = new SidebarProject();
    project.project = projectInfo;
    project.projectStore = store;
    const dialog = { open: mock(async (_session: unknown, _actions: { loadTargets: () => Promise<unknown>; move: (nodeId: string) => Promise<unknown> }) => {}) };
    Object.defineProperty(project, "sessionMoveDialog", { value: dialog });
    const [openMove] = collectTemplateEventListeners(project.render(), "move-session");

    await openMove?.call(project, moveSessionEvent("other-session"));
    expect(dialog.open).not.toHaveBeenCalled();
    await openMove?.call(project, moveSessionEvent("own-session"));

    const [opened, actions] = dialog.open.mock.calls[0]!;
    expect(opened).toMatchObject({ id: "own-session" });
    expect(await actions.loadTargets()).toEqual(targets);
    await actions.move("internal");
    expect(store.loadMoveTargets).toHaveBeenCalledWith("own-session");
    expect(store.moveSession).toHaveBeenCalledWith("own-session", "internal");
  });
});
