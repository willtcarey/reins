import type { ReactiveController, ReactiveControllerHost } from "lit";
import { getLastHash, parseHash, saveHash } from "../models/router.js";
import type { Route } from "../models/router.js";

interface AppRouteStore {
  projectId: number | null;
  sessionId: string;
  setRoute(sessionId: string | null): Promise<void>;
}

interface AppRouteControllerOptions {
  store: AppRouteStore;
  onSessionChange?: () => void;
  onProjectChange?: () => void;
  onSessionVisit?: (sessionId: string) => void;
}

/**
 * Owns app-shell hash routing and route-derived UI callbacks.
 *
 * The controller is started explicitly from AppShell after the shell has
 * installed its AppStore subscription, so the initial route application cannot
 * race ahead of app-level store side effects.
 */
export class AppRouteController implements ReactiveController {
  private connected = false;
  private readonly host: ReactiveControllerHost;
  private readonly store: AppRouteStore;
  private readonly onSessionChange: () => void;
  private readonly onProjectChange: () => void;
  private readonly onSessionVisit: (sessionId: string) => void;

  constructor(host: ReactiveControllerHost, options: AppRouteControllerOptions) {
    this.host = host;
    this.store = options.store;
    this.onSessionChange = options.onSessionChange ?? (() => {});
    this.onProjectChange = options.onProjectChange ?? (() => {});
    this.onSessionVisit = options.onSessionVisit ?? (() => {});
    host.addController(this);
  }

  connect() {
    if (this.connected) return;
    this.connected = true;
    this.applyInitialRoute();
    window.addEventListener("hashchange", this.handleHashChange);
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    window.removeEventListener("hashchange", this.handleHashChange);
  }

  hostDisconnected() {
    this.disconnect();
  }

  private applyInitialRoute() {
    const route = parseHash();
    if (!route.sessionId) {
      const lastHash = getLastHash();
      if (lastHash) {
        // Replace so we don't push an empty-hash entry into history.
        history.replaceState(null, "", lastHash);
        void this.applyRoute(parseHash());
      } else {
        void this.applyRoute(route);
      }
      return;
    }

    void this.applyRoute(route);
  }

  private handleHashChange = () => {
    saveHash(location.hash);
    const previousProjectId = this.store.projectId;
    this.applyRoute(parseHash(), previousProjectId);
  };

  async applyRoute(route: Route, previousProjectId?: number | null) {
    const previousSessionId = this.store.sessionId;
    const nextSessionId = route.sessionId ?? "";

    // Show the chat shell immediately; session metadata and messages hydrate
    // through the active store subscription.
    if (nextSessionId && nextSessionId !== previousSessionId) {
      this.onSessionChange();
      this.host.requestUpdate();
    }

    await this.store.setRoute(route.sessionId);

    // Reset UI state derived from project-local data when the route changes
    // to a session in a different project.
    if (previousProjectId !== undefined && this.store.projectId !== previousProjectId) {
      this.onProjectChange();
    }

    // Track session visit for quick-open recency ordering.
    if (this.store.sessionId) {
      this.onSessionVisit(this.store.sessionId);
    }

    this.host.requestUpdate();
  }
}
