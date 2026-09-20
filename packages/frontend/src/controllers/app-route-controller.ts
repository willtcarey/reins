import type { ReactiveController, ReactiveControllerHost } from "lit";
import { getLastHash, parseHash, saveHash } from "../routing/app-router.js";
import type { Route } from "../routing/router.js";

interface AppRouteControllerOptions {
  onRouteChange?: (route: Route) => void;
}

/** Adapts browser hash changes to Lit's reactive lifecycle. */
export class AppRouteController implements ReactiveController {
  private connected = false;
  private readonly onRouteChange: (route: Route) => void;

  constructor(
    private readonly host: ReactiveControllerHost,
    options: AppRouteControllerOptions,
  ) {
    this.onRouteChange = options.onRouteChange ?? (() => {});
    host.addController(this);
  }

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.applyInitialRoute();
    window.addEventListener("hashchange", this.handleHashChange);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    window.removeEventListener("hashchange", this.handleHashChange);
  }

  hostDisconnected(): void { this.disconnect(); }

  applyRoute(route: Route): void {
    this.onRouteChange(route);
    this.host.requestUpdate();
  }

  private applyInitialRoute(): void {
    const route = parseHash();
    if (route.name === "empty") {
      const lastHash = getLastHash();
      if (lastHash) {
        history.replaceState(null, "", lastHash);
        this.applyRoute(parseHash());
        return;
      }
    }
    this.applyRoute(route);
  }

  private handleHashChange = () => {
    saveHash(location.hash);
    this.applyRoute(parseHash());
  };
}
