/**
 * Builds the Reins SDK (`@reins/sdk`) over the app's state (docs/dev/reins-sdk.md): one for each extension, which
 * app-shell gives to its register function; nothing else holds it.
 */

import type { ExtensionClient } from "@reins/client";
import type {
  Commands, ContainerId, CurrentView, Disposer, ExtensionInfo, Files, HttpApi, HttpCallArgs, HttpOutput, Messages, OpenOptions, ReinsSdk, Sessions, SettingsPage, Subject,
  SubjectTypes, View, Views,
} from "@reins/sdk";
import type { IAppClient } from "../models/ws-client.js";
import type { SettingsPages } from "./settings-pages.js";

/** What the SDK is built over: `AppStore` in the app, its parts in tests. */
export interface SdkBacking {
  readonly files: Files;
  readonly views: Views;
  readonly decorators: Messages;
  readonly commands: Commands;
  readonly settingsPages: SettingsPages;
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
 * What every extension's SDK is built over. `sessions` (`SdkSessions` in the app) uses more of the app than the
 * backing. The main area (in the app, the workspace it shows and the router) is apart from it because it
 * navigates, which `AppStore` does not. `http` and `socket` are the server's HTTP API and its WebSocket.
 */
export interface SdkHost {
  app: SdkBacking;
  sessions: Sessions;
  main: MainArea;
  http: { extension(name: string): ExtensionClient };
  socket: Pick<IAppClient, "subscribe" | "onConnection">;
}

/** `A` is the extension's HTTP API, which only types `http.call`: the host calls any method by its name. */
export function createReinsSdk<A extends HttpApi = HttpApi>(extension: ExtensionInfo, { app, sessions, main, http, socket }: SdkHost): ReinsSdk<A> {
  /** Registered views have no route yet (workspace-inspector.md, slice 4), so one is refused rather than dropped. */
  const showInMain = (view: View) => {
    if (!main.show(view)) throw new Error(`The main area cannot show the "${view.view}" view`);
  };
  const currentSubject = <K extends keyof SubjectTypes>(type: K): SubjectTypes[K] | null => {
    const found = main.current()?.subject.find((subject): subject is Subject & { type: K; id: SubjectTypes[K] } => subject.type === type);
    return found ? found.id : null;
  };
  const api = http.extension(extension.name);
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
    settings: Object.freeze({ register: (page: SettingsPage) => app.settingsPages.register(extension, page) }),
    http: Object.freeze({
      call: <K extends keyof A & string>(method: K, ...[input, options]: HttpCallArgs<A[K]>) => api.call<HttpOutput<A[K]>>(method, input, options),
    }),
    onMessage: (listener: (message: object) => void): Disposer => socket.subscribe({
      extension: ({ extension: sender, message }) => {
        if (sender === extension.name) listener(message);
      },
    }),
    onReconnect: (listener: () => void): Disposer => {
      // The client tells a lost connection only after it was connected, so the first connect is not a return.
      let lost = false;
      return socket.onConnection((connected) => {
        if (!connected) lost = true;
        else if (lost) {
          lost = false;
          listener();
        }
      });
    },
  } satisfies ReinsSdk<A>);
}
