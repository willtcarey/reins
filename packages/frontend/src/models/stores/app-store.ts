/** Long-lived application runtime and shared stores. */

import type { Project as ProjectInfo } from "@backend/project-store.js";
import type { ContainerId, View } from "@reins/sdk";
import { CommandRegistry } from "../../sdk-host/commands.js";
import { DecoratorRegistry } from "../../sdk-host/decorators.js";
import { ViewRegistry } from "../../sdk-host/view-registry.js";
import { Inspector } from "../inspector.js";
import type { IAppClient } from "../ws-client.js";
import { SessionOperations } from "../session-operations.js";
import { ConversationsStore } from "./conversations-store.js";
import { ProjectFiles } from "./project-files.js";
import { ProjectsStore } from "./projects-store.js";
import { SessionCache } from "./session-cache.js";
import { SettingsStore } from "./settings-store.js";

export type AppStoreListener = () => void;
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
  readonly files: ProjectFiles;
  readonly views = new ViewRegistry();
  readonly decorators = new DecoratorRegistry(this.views);
  readonly commands = new CommandRegistry();
  readonly inspector = new Inspector(this.views);

  connected = false;

  private listeners = new Set<AppStoreListener>();
  private reconcilers = new Set<Reconciler>();
  private unsubscribers: Array<() => void> = [];
  private removeBrowserResumeHandlers: (() => void) | null = null;
  private serverReconcileInFlight: Promise<void> | null = null;

  constructor(readonly client: IAppClient) {
    this.sessionCache = new SessionCache();
    this.activeConversationsStore = new ConversationsStore({
      sessionCache: this.sessionCache,
      eventSource: client,
    });
    this.sessionOperations = new SessionOperations({ conversations: this.activeConversationsStore });
    this.projectsStore = new ProjectsStore(this.sessionCache, client);
    this.settingsStore = new SettingsStore(client);
    this.files = new ProjectFiles(client, this.sessionCache);

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

  /** Shows a view in a container: the SDK's `workspace.open`. */
  open(view: View, container: ContainerId): void {
    switch (container) {
      case "inspector":
        this.inspector.open(view);
        break;
    }
  }

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
    this.decorators.dispose();
    this.listeners.clear();
    this.reconcilers.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async reconcileFromServer(): Promise<void> {
    await Promise.allSettled([
      this.requestServerReconcile(),
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
