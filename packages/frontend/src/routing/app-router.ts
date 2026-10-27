import { html, type TemplateResult } from "lit";
import type { View } from "@reins/sdk";
import type { NewSessionView } from "../components/new-session-page.js";
import type { AppStore } from "../models/stores/app-store.js";
import { FrontendRouter, type Route } from "./router.js";

export interface AppRouteRenderContext {
  app: AppStore;
}

export const SETTINGS_SECTIONS = ["models", "nodes"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section === value);
}

/** One template for every settings route, so the page stays mounted while sections change. */
function renderSettingsPage(app: AppStore, section: SettingsSection | null): TemplateResult {
  return html`
    <settings-page class="block h-full" .store=${app.settingsStore} .section=${section}></settings-page>
  `;
}

/** One template for every workspace route, so the workspace stays mounted while its route changes. */
function renderWorkspacePage(app: AppStore, route: Route): TemplateResult {
  const view = mainViewOf(route);
  return html`
    <app-workspace
      class="block h-full"
      .app=${app}
      .sessionId=${view?.view === "session" ? view.sessionId : null}
      .newSession=${view?.view === "new-session" ? view : null}
    ></app-workspace>
  `;
}

const ID = /^\d+$/;

export function createAppRouter(): FrontendRouter<AppRouteRenderContext, TemplateResult> {
  const router = new FrontendRouter<AppRouteRenderContext, TemplateResult>();
  router.register({
    name: "empty",
    pattern: "/",
    renderPage: (route, { app }) => renderWorkspacePage(app, route),
  });
  router.register({
    name: "session",
    pattern: "/session/:sessionId",
    renderPage: (route, { app }) => renderWorkspacePage(app, route),
  });
  router.register({
    name: "new-session",
    pattern: "/new",
    // A task is of a project, so it is chosen only with one.
    validate: ({ project, task }) => (project === undefined ? task === undefined : ID.test(project) && (task === undefined || ID.test(task))),
    renderPage: (route, { app }) => renderWorkspacePage(app, route),
  });
  router.register({
    name: "project-history",
    pattern: "/projects/:projectId/history",
    validate: ({ projectId }) => /^\d+$/.test(projectId ?? ""),
    renderPage: (route, { app }) => {
      const projectId = Number(route.params.projectId);
      const project = app.projects.find((candidate) => candidate.id === projectId);
      return html`
        <project-history
          class="block h-full"
          .projectId=${projectId}
          .projectName=${project?.name ?? "Project"}
        ></project-history>
      `;
    },
  });
  router.register({
    name: "settings",
    pattern: "/settings",
    renderPage: (_route, { app }) => renderSettingsPage(app, null),
  });
  router.register({
    name: "settings-section",
    pattern: "/settings/:section",
    validate: ({ section }) => isSettingsSection(section ?? ""),
    renderPage: (route, { app }) => {
      const section = route.params.section ?? "";
      return renderSettingsPage(app, isSettingsSection(section) ? section : null);
    },
  });
  return router;
}

export const appRouter = createAppRouter();

export function parseHash(): Route {
  return appRouter.resolve(location.hash);
}

const LAST_HASH_KEY = "reins:last-hash";

export function getLastHash(): string | null {
  try {
    return localStorage.getItem(LAST_HASH_KEY) || null;
  } catch {
    return null;
  }
}

export function saveHash(hash: string): void {
  try {
    localStorage.setItem(LAST_HASH_KEY, hash);
  } catch { /* ignore unavailable storage */ }
}

export function sessionHash(sessionId: string): string {
  return appRouter.hash("session", { sessionId });
}

export function newSessionHash({ projectId, taskId }: { projectId: number | null; taskId: number | null }): string {
  return appRouter.hash("new-session", {
    ...(projectId != null ? { project: projectId } : {}),
    ...(projectId != null && taskId != null ? { task: taskId } : {}),
  });
}

const mainViews = new WeakMap<Route, View | null>();

/**
 * The view the main area shows for a route, or null for a page that is not one. The same object for
 * the same route object, which the app keeps until the URL changes: as for any view, a new object is
 * a new open of it, so the app rendering the route again is not one.
 */
export function mainViewOf(route: Route): View | null {
  let view = mainViews.get(route);
  if (view === undefined) {
    view = viewOfRoute(route);
    mainViews.set(route, view);
  }
  return view;
}

function viewOfRoute(route: Route): View | null {
  if (route.name === "session" && route.params.sessionId) return { view: "session", sessionId: route.params.sessionId };
  if (route.name !== "new-session") return null;
  const { project, task } = route.params;
  return { view: "new-session", projectId: project ? Number(project) : null, taskId: task ? Number(task) : null } satisfies NewSessionView;
}

/** The route of a view the main area can show, or null for any other. */
export function mainViewHash(view: View): string | null {
  if (view.view === "session") return typeof view.sessionId === "string" && view.sessionId ? sessionHash(view.sessionId) : null;
  if (view.view !== "new-session") return null;
  const { projectId, taskId } = view;
  if (!isOptionalId(projectId) || !isOptionalId(taskId) || (projectId == null && taskId != null)) return null;
  return newSessionHash({ projectId, taskId });
}

function isOptionalId(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

export function projectHistoryHash(projectId: number): string {
  return appRouter.hash("project-history", { projectId });
}

export function settingsHash(section?: SettingsSection): string {
  return section ? appRouter.hash("settings-section", { section }) : appRouter.hash("settings", {});
}

function isSettingsRoute(route: Route): boolean {
  return route.name === "settings" || route.name === "settings-section";
}

/** Where closing settings returns to: set when settings is opened from elsewhere in the app. */
let settingsReturnHash: string | null = null;

export function openSettings(section?: SettingsSection): void {
  if (!isSettingsRoute(parseHash())) settingsReturnHash = location.hash;
  navigate(settingsHash(section));
}

/** Changing section replaces the history entry, so leaving settings is always one step back. */
export function showSettingsSection(section: SettingsSection | null): void {
  navigate(settingsHash(section ?? undefined), true);
}

export function closeSettings(): void {
  if (settingsReturnHash !== null && isSettingsRoute(parseHash())) {
    settingsReturnHash = null;
    history.back();
    return;
  }
  settingsReturnHash = null;
  navigate("#/", true);
}

export function navigate(hash: string, replace = false): void {
  if (location.hash === hash) return;
  if (replace) {
    history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = hash;
  }
}

export function navigateToSession(sessionId: string, replace = false): void {
  navigate(sessionHash(sessionId), replace);
}

export function navigateToProjectHistory(projectId: number, replace = false): void {
  navigate(projectHistoryHash(projectId), replace);
}

export function renderRoutePage(route: Route, context: AppRouteRenderContext): TemplateResult {
  const page = appRouter.renderPage(route, context);
  if (!page) throw new Error(`Route '${route.name}' has no registered page renderer`);
  return page;
}
