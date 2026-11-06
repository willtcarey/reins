/**
 * The main area as the SDK sees it (`workspace.open(view, { in: "main" })`, `current`, `onDidChange`): it shows
 * a view by going to its route, so the URL stays the main area's state and Back, reload and links work.
 */

import type { CurrentView, Disposer, View } from "@reins/sdk";
import type { MainArea } from "../sdk-host/create-sdk.js";
import type { ViewRegistry } from "../sdk-host/view-registry.js";
import { appRouter, hasOwnRoute, mainViewHash, mainViewOf, navigate } from "./app-router.js";

/** Where the main area's routes are: the browser's history, in the app. */
export interface MainHistory {
  /** The route shown now. */
  readonly hash: string;
  /** Goes to `hash`, in place of the entry shown with `replace`; going to the route shown opens its view again. */
  go(hash: string, replace: boolean): void;
}

/** What renders the main area's routes: the workspace, which knows what the view on screen is about. */
export interface MainPage {
  current(): CurrentView | null;
  /** Brings the main area forward on a phone. */
  revealMain(): void;
}

const browserHistory: MainHistory = {
  get hash() {
    return location.hash;
  },
  go(hash, replace) {
    // The route shown is resolved again, which gives a new view object: an open of the view shown.
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
    else navigate(hash, replace);
  },
};

export class RoutedMainArea implements MainArea {
  private listeners = new Set<() => void>();
  /** What the main area showed when its listeners were last told, to tell them only of a change. */
  private told: string;

  constructor(
    private readonly views: Pick<ViewRegistry, "rendererFor" | "keyOf">,
    private readonly page: () => MainPage | null,
    private readonly history: MainHistory = browserHistory,
  ) {
    this.told = JSON.stringify(this.current());
  }

  current(): CurrentView | null {
    return this.page()?.current() ?? null;
  }

  /**
   * Goes to the view's route. The app's views (a session, the new session page, a project's history) have their
   * own routes; any other needs a pane presentation, as in any container. The same view as the one shown (its renderer's key) replaces
   * it in place, without a history entry.
   */
  open(view: View): void {
    if (!hasOwnRoute(view.view) && !this.views.rendererFor(view)?.pane) {
      throw new Error(`The "${view.view}" view has no pane presentation, so the main area cannot show it`);
    }
    const hash = mainViewHash(view);
    if (!hash) throw new Error(`The main area cannot show this "${view.view}" view`);
    const shown = mainViewOf(appRouter.resolve(this.history.hash));
    this.history.go(hash, shown != null && this.isShown(shown, view));
    // On a phone, opening what the workspace already shows still brings its page forward.
    this.page()?.revealMain();
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tells listeners if the view shown, or what it is about, changed; the app calls it after the main area renders. */
  changed(): void {
    const shown = JSON.stringify(this.current());
    if (shown === this.told) return;
    this.told = shown;
    for (const listener of this.listeners) listener();
  }

  /** A registered view is shown when its renderer's key is; the app's views without a renderer only when their route is. */
  private isShown(shown: View, view: View): boolean {
    return shown.view === view.view && this.views.rendererFor(view)?.pane != null && this.views.keyOf(shown) === this.views.keyOf(view);
  }
}
