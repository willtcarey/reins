/** Long-lived application runtime and shared stores. */

import type { ProjectView as ProjectInfo } from "@backend/routes/projects.js";
import { CommandRegistry } from "../../sdk-host/commands.js";
import { SendHandoff } from "../send-handoff.js";
import { DecoratorRegistry } from "../../sdk-host/decorators.js";
import { Extensions } from "../../sdk-host/extensions.js";
import { SettingsPages } from "../../sdk-host/settings-pages.js";
import { SidebarSections, type SidebarLayout, type SidebarLayoutStorage } from "../../sdk-host/sidebar-sections.js";
import { ViewRegistry } from "../../sdk-host/view-registry.js";
import { Inspector } from "../inspector.js";
import type { IAppClient } from "../ws-client.js";
import { SessionOperations } from "../session-operations.js";
import { api } from "../api.js";
import { ConversationsStore } from "./conversations-store.js";
import { NodesStore } from "./nodes-store.js";
import { LocationSkills } from "./location-skills.js";
import { ProjectFiles } from "./project-files.js";
import { ProjectsStore } from "./projects-store.js";
import { SessionCache } from "./session-cache.js";
import { SettingsStore } from "./settings-store.js";

export type AppStoreListener = () => void;

function isStringList(list: unknown): boolean {
  return Array.isArray(list) && list.every((item) => typeof item === "string");
}

function isSidebarLayout(value: unknown): value is SidebarLayout {
  return typeof value === "object" && value !== null && "order" in value && "hidden" in value && isStringList(value.order) && isStringList(value.hidden);
}

/** The sidebar's arrangement, as the server's `sidebar_sections` setting. */
const sidebarLayoutSetting: SidebarLayoutStorage = {
  load: async () => {
    const [entry] = await api.settings.list(["sidebar_sections"]);
    return entry && isSidebarLayout(entry.value) ? entry.value : null;
  },
  save: (layout) => api.settings.put("sidebar_sections", layout),
};
type Reconciler = () => void | Promise<unknown>;

/**
 * Application-lifetime context for transport coordination and shared caches.
 * Route and workspace selection state deliberately live outside this class.
 */
export class AppStore {
  readonly sessionCache: SessionCache;
  readonly activeConversationsStore: ConversationsStore;
  readonly sessionOperations: SessionOperations;
  readonly projectsStore: ProjectsStore;
  readonly settingsStore: SettingsStore;
  /** The nodes: the settings page lists them, and reaching a source's files follows their connections. */
  readonly nodesStore: NodesStore;
  readonly files: ProjectFiles;
  readonly views = new ViewRegistry();
  readonly decorators = new DecoratorRegistry(this.views);
  readonly commands = new CommandRegistry();
  /** The extensions' Settings pages, which the settings page lists after its own sections. */
  readonly settingsPages = new SettingsPages();
  /** The sidebar's sections, in the order the user gave them (Settings → Sidebar). */
  readonly sidebar: SidebarSections;
  /** The frontend extensions app-shell activated, and what each registered in the registries above. */
  readonly extensions: Extensions;
  /** When this browser last opened each session: the sidebar's Recent. */
  readonly inspector = new Inspector(this.views);
  /** A message the new session page sent, which the session's chat panel animates into its conversation. */
  readonly sendHandoff = new SendHandoff();
  /** The skills of each location, for the composers' `/name` suggestions. */
  readonly locationSkills = new LocationSkills();

  connected = false;

  private listeners = new Set<AppStoreListener>();
  private reconcilers = new Set<Reconciler>();
  private unsubscribers: Array<() => void> = [];
  private removeBrowserResumeHandlers: (() => void) | null = null;
  private serverReconcileInFlight: Promise<void> | null = null;

  constructor(readonly client: IAppClient, sidebarLayout: SidebarLayoutStorage | null = sidebarLayoutSetting) {
    this.sidebar = new SidebarSections(sidebarLayout);
    this.extensions = new Extensions(this);
    this.sessionCache = new SessionCache();
    this.activeConversationsStore = new ConversationsStore({
      sessionCache: this.sessionCache,
      eventSource: client,
    });
    this.sessionOperations = new SessionOperations({ conversations: this.activeConversationsStore });
    this.projectsStore = new ProjectsStore(this.sessionCache, client);
    this.nodesStore = new NodesStore(client);
    this.settingsStore = new SettingsStore(this.nodesStore, this.extensions, this.sidebar);
    this.files = new ProjectFiles(client, this.sessionCache, this.nodesStore);

    this.unsubscribers = [
      this.projectsStore.subscribe(() => this.notify()),
      this.settingsStore.subscribe(() => this.notify()),
    ];

    client.onConnection((connected) => {
      this.connected = connected;
      this.notify();
      if (connected) void this.reconcileFromServer();
    });
  }

  get projects(): ProjectInfo[] { return this.projectsStore.projects; }
  get activitySummary(): { running: number; finished: number } { return this.projectsStore.activitySummary; }

  subscribe(listener: AppStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerReconciler(reconciler: Reconciler): () => void {
    this.reconcilers.add(reconciler);
    return () => this.reconcilers.delete(reconciler);
  }

  connect(): void {
    this.removeBrowserResumeHandlers ??= this.installBrowserResumeHandlers();
    this.client.connect();
  }

  disconnect(): void { this.client.disconnect(); }

  dispose(): void {
    this.removeBrowserResumeHandlers?.();
    this.removeBrowserResumeHandlers = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.activeConversationsStore.dispose();
    this.projectsStore.dispose();
    this.settingsStore.dispose();
    this.files.dispose();
    this.nodesStore.dispose();
    this.decorators.dispose();
    this.extensions.dispose();
    this.listeners.clear();
    this.reconcilers.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async reconcileFromServer(): Promise<void> {
    await Promise.allSettled([
      this.requestServerReconcile(),
      this.nodesStore.load(),
      this.sidebar.load(),
      ...[...this.reconcilers].map((reconcile) => Promise.resolve().then(reconcile)),
    ]);
  }

  private requestServerReconcile(): Promise<void> {
    if (this.serverReconcileInFlight) return this.serverReconcileInFlight;
    this.serverReconcileInFlight = this.projectsStore.refreshFromServer()
      .then(() => { this.activeConversationsStore.pruneInactive(); })
      .finally(() => { this.serverReconcileInFlight = null; });
    return this.serverReconcileInFlight;
  }

  private installBrowserResumeHandlers(): () => void {
    const reconcile = () => { void this.reconcileFromServer(); };
    const reconcileWhenVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    window.addEventListener("pageshow", reconcile);
    document.addEventListener("visibilitychange", reconcileWhenVisible);
    return () => {
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      window.removeEventListener("pageshow", reconcile);
      document.removeEventListener("visibilitychange", reconcileWhenVisible);
    };
  }
}
