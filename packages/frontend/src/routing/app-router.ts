import { html, type TemplateResult } from "lit";
import type { View } from "@reins/sdk";
import type { NewSessionView } from "../components/new-session-page.js";
import type { AppStore } from "../models/stores/app-store.js";
import { FrontendRouter, type Route } from "./router.js";
import { viewOfRouteParams, viewRouteHash } from "./view-route.js";

export interface AppRouteRenderContext {
  app: AppStore;
}

/** The host's own settings sections; each extension with settings has a page too (`/settings/extensions/<name>`).
 * `extensions` (`/settings/extensions`) is the host's list of every extension, one segment shorter than their pages. */
export const SETTINGS_SECTIONS = ["models", "nodes", "sidebar", "extensions"] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section === value);
}

/** An extension's name, as the backend allows it. Whether it is registered is the page's to say. */
const EXTENSION_NAME = /^[a-z][a-z0-9-]*$/;

/** One template for every settings route, so the page stays mounted while sections change. */
function renderSettingsPage(app: AppStore, shown: { section?: SettingsSectionId; extension?: string; extensionDetails?: string }): TemplateResult {
  return html`
    <settings-page
      class="block h-full"
      .store=${app.settingsStore}
      .extensionPages=${app.settingsPages}
      .section=${shown.section ?? null}
      .extension=${shown.extension ?? null}
      .extensionDetails=${shown.extensionDetails ?? null}
    ></settings-page>
  `;
}

/**
 * One template for every workspace route, so the workspace stays mounted while its route changes. It shows a
 * session itself, and any other view as a page.
 */
function renderWorkspacePage(app: AppStore, route: Route): TemplateResult {
  const view = mainViewOf(route);
  return html`
    <app-workspace
      class="block h-full"
      .app=${app}
      .sessionId=${typeof view?.sessionId === "string" && (view.view === "session" || view.view === "session-changes") ? view.sessionId : null}
      .mainView=${view}
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
    name: "session-changes",
    pattern: "/session/:sessionId/changes",
    renderPage: (route, { app }) => renderWorkspacePage(app, route),
  });
  router.register({
    name: "new-session",
    pattern: "/new",
    // A task is of a project, so it is chosen only with one.
    validate: ({ project, task }) => (project === undefined ? task === undefined : ID.test(project) && (task === undefined || ID.test(task))),
    renderPage: (route, { app }) => renderWorkspacePage(app, route),
  });
  // Any other view the main area shows, its URL derived from it (view-route.ts).
  router.register({
    name: "view",
    pattern: "/view/:view",
    validate: ({ view }) => !!view && !hasOwnRoute(view),
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
    renderPage: (_route, { app }) => renderSettingsPage(app, {}),
  });
  router.register({
    name: "settings-section",
    pattern: "/settings/:section",
    validate: ({ section }) => isSettingsSection(section ?? ""),
    renderPage: (route, { app }) => {
      const section = route.params.section ?? "";
      return renderSettingsPage(app, isSettingsSection(section) ? { section } : {});
    },
  });
  router.register({
    name: "settings-extension",
    pattern: "/settings/extensions/:extension",
    validate: ({ extension }) => EXTENSION_NAME.test(extension ?? ""),
    renderPage: (route, { app }) => renderSettingsPage(app, { extension: route.params.extension ?? "" }),
  });
  // Reins' page about an extension, under the Extensions section; the extension's own page stays its content only.
  router.register({
    name: "settings-extension-details",
    pattern: "/settings/extensions/:extension/details",
    validate: ({ extension }) => EXTENSION_NAME.test(extension ?? ""),
    renderPage: (route, { app }) => renderSettingsPage(app, { extensionDetails: route.params.extension ?? "" }),
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
  if (route.name === "view") return viewOfRouteParams(route.params);
  if (route.name === "session" && route.params.sessionId) return { view: "session", sessionId: route.params.sessionId };
  if (route.name === "session-changes" && route.params.sessionId) return { view: "session-changes", sessionId: route.params.sessionId };
  if (route.name !== "new-session") return null;
  const { project, task } = route.params;
  return { view: "new-session", projectId: project ? Number(project) : null, taskId: task ? Number(task) : null } satisfies NewSessionView;
}

/**
 * The app's views with routes of their own, which they had before any view was routed: each gives its view's
 * hash, or null for parameters the view cannot have.
 */
const OWN_ROUTES: Readonly<Record<string, (view: View) => string | null>> = {
  session: ({ sessionId }) => (typeof sessionId === "string" && sessionId ? sessionHash(sessionId) : null),
  "session-changes": ({ sessionId }) => (typeof sessionId === "string" && sessionId ? appRouter.hash("session-changes", { sessionId }) : null),
  "project-history": ({ projectId }) => (typeof projectId === "number" && Number.isInteger(projectId) ? projectHistoryHash(projectId) : null),
  "new-session": ({ projectId, taskId }) => {
    if (!isOptionalId(projectId) || !isOptionalId(taskId) || (projectId == null && taskId != null)) return null;
    return newSessionHash({ projectId, taskId });
  },
};

/** Whether views of the name have a route of their own rather than `#/view/<name>`. */
export function hasOwnRoute(name: string): boolean {
  return Object.hasOwn(OWN_ROUTES, name);
}

/**
 * The route of a view in the main area: the app's views' own, and `#/view/<name>?<parameters>` for any other.
 * Null for an app's view whose parameters it cannot have. Whether the main area can show the view is the main
 * area's to say (`RoutedMainArea`).
 */
export function mainViewHash(view: View): string | null {
  const own = hasOwnRoute(view.view) ? OWN_ROUTES[view.view] : undefined;
  return own ? own(view) : viewRouteHash(view);
}

function isOptionalId(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

export function projectHistoryHash(projectId: number): string {
  return appRouter.hash("project-history", { projectId });
}

export function settingsHash(section?: SettingsSectionId): string {
  return section ? appRouter.hash("settings-section", { section }) : appRouter.hash("settings", {});
}

export function settingsExtensionHash(extension: string): string {
  return appRouter.hash("settings-extension", { extension });
}

export function settingsExtensionDetailsHash(extension: string): string {
  return appRouter.hash("settings-extension-details", { extension });
}

function isSettingsRoute(route: Route): boolean {
  return route.name === "settings" || route.name === "settings-section" || route.name === "settings-extension" || route.name === "settings-extension-details";
}

/** Where closing settings returns to: set when settings is opened from elsewhere in the app. */
let settingsReturnHash: string | null = null;

export function openSettings(section?: SettingsSectionId): void {
  if (!isSettingsRoute(parseHash())) settingsReturnHash = location.hash;
  navigate(settingsHash(section));
}

/** Changing section replaces the history entry, so leaving settings is always one step back. */
export function showSettingsSection(section: SettingsSectionId | null): void {
  navigate(settingsHash(section ?? undefined), true);
}

/** An extension's settings page, replacing the history entry as `showSettingsSection` does. */
export function showSettingsExtension(extension: string): void {
  navigate(settingsExtensionHash(extension), true);
}

/** Reins' details page of an extension, replacing the history entry as `showSettingsSection` does. */
export function showSettingsExtensionDetails(extension: string): void {
  navigate(settingsExtensionDetailsHash(extension), true);
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

/**
 * History API, not `location.hash =`: the WKWebView in macOS Golden Gate sends a hash assignment through the
 * navigation policy as a full load, so the Tauri app reloaded on every session switch.
 */
export function navigate(hash: string, replace = false): void {
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, "", hash);
  else history.pushState(null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
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
