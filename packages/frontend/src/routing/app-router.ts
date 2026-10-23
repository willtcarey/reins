import { html, type TemplateResult } from "lit";
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

export function createAppRouter(): FrontendRouter<AppRouteRenderContext, TemplateResult> {
  const router = new FrontendRouter<AppRouteRenderContext, TemplateResult>();
  router.register({
    name: "empty",
    pattern: "/",
    renderPage: (_route, { app }) => html`
      <app-workspace class="block h-full" .app=${app} .sessionId=${null}></app-workspace>
    `,
  });
  router.register({
    name: "session",
    pattern: "/session/:sessionId",
    renderPage: (route, { app }) => html`
      <app-workspace class="block h-full" .app=${app} .sessionId=${route.params.sessionId ?? null}></app-workspace>
    `,
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
