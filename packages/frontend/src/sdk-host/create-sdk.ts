/**
 * Builds the Reins SDK (`@reins/sdk`) over the app's state (docs/dev/reins-sdk.md). app-shell builds one and gives
 * it to the built-ins' register functions; nothing else holds it.
 */

import type { Commands, ContainerId, CurrentView, Files, Messages, OpenOptions, ReinsSdk, Sessions, Subject, SubjectTypes, View, Views } from "@reins/sdk";

/** What the SDK is built over: `AppStore` in the app, its parts in tests. */
export interface SdkBacking {
  readonly files: Files;
  readonly views: Views;
  readonly decorators: Messages;
  readonly commands: Commands;
  open(view: View, container: Exclude<ContainerId, "main">): void;
}

/** The main area, which shows a view's route or a page that is not a view. */
export interface MainArea {
  /** The view shown and what it is about, as the view tells; null on a page that is not a view. */
  current(): CurrentView | null;
  /** Goes to the view's route; false for a view that has none. */
  show(view: View): boolean;
}

/**
 * `sessions` (`SdkSessions` in the app) uses more of the app than the backing. The main area (in the
 * app, the workspace it shows and the router) is apart from it because it navigates, which `AppStore` does not.
 */
export function createReinsSdk(app: SdkBacking, sessions: Sessions, main: MainArea): ReinsSdk {
  /** Registered views have no route yet (workspace-inspector.md, slice 4), so one is refused rather than dropped. */
  const showInMain = (view: View) => {
    if (!main.show(view)) throw new Error(`The main area cannot show the "${view.view}" view`);
  };
  const currentSubject = <K extends keyof SubjectTypes>(type: K): SubjectTypes[K] | null => {
    const found = main.current()?.subject.find((subject): subject is Subject & { type: K; id: SubjectTypes[K] } => subject.type === type);
    return found ? found.id : null;
  };
  return Object.freeze({
    files: app.files,
    workspace: Object.freeze({
      open: (view: View, { in: container = "inspector" }: OpenOptions = {}) => (container === "main" ? showInMain(view) : app.open(view, container)),
      current: () => main.current(),
      currentSubject,
    }),
    views: Object.freeze({ register: app.views.register.bind(app.views) }),
    messages: Object.freeze({ registerDecorator: app.decorators.registerDecorator.bind(app.decorators) }),
    commands: Object.freeze({ register: app.commands.register.bind(app.commands) }),
    sessions: Object.freeze({
      get: sessions.get.bind(sessions),
      create: sessions.create.bind(sessions),
      send: sessions.send.bind(sessions),
      compact: sessions.compact.bind(sessions),
    }),
  });
}
