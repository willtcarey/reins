/**
 * Builds the Reins SDK (`@reins/sdk`) over the app's state (docs/dev/reins-sdk.md): one for each extension, which
 * app-shell gives to its register function; nothing else holds it.
 */

import type { ExtensionClient } from "@reins/client";
import type {
  Command, Commands, ContainerId, CurrentView, Disposer, ExtensionInfo, Files, HttpApi, HttpCallArgs, HttpOutput, MessageDecorator, Messages, Nodes, OpenOptions, Projects,
  ReinsSdk, Sessions, SettingsPage, SidebarSection, Subject, SubjectTypes, Tasks, Ui, View, ViewRenderer, Views, ViewTypes,
} from "@reins/sdk";
import type { IAppClient } from "../models/ws-client.js";
import type { CommandRegistry } from "./commands.js";
import type { DecoratorRegistry } from "./decorators.js";
import type { SettingsPages } from "./settings-pages.js";
import type { SidebarSections } from "./sidebar-sections.js";
import type { ViewRegistry } from "./view-registry.js";

/** What the SDK is built over: `AppStore` in the app, its parts in tests. The registries record each
 * registration with the extension whose SDK made it. */
export interface SdkBacking {
  readonly files: Files;
  readonly views: ViewRegistry;
  readonly decorators: DecoratorRegistry;
  readonly commands: CommandRegistry;
  readonly settingsPages: SettingsPages;
  readonly sidebar: SidebarSections;
  open(view: View, container: Exclude<ContainerId, "main">): void;
}

/** The main area, which shows a view's route or a page that is not a view. */
export interface MainArea {
  /** The view shown and what it is about, as the view tells; null on a page that is not a view. */
  current(): CurrentView | null;
  /** Goes to the view's route; false for a view that has none. */
  show(view: View): boolean;
  /** Listens for the view shown, or what it is about, changing. */
  subscribe(listener: () => void): Disposer;
}

/**
 * What every extension's SDK is built over. `sessions`, `projects`, `tasks` and `nodes` (`SdkSessions`, `SdkProjects`,
 * `SdkTasks`, `SdkNodes` in the app) use more of the app than the backing. The main area (in the app, the workspace it shows and the router) is apart from it because it
 * navigates, which `AppStore` does not. `http` and `socket` are the server's HTTP API and its WebSocket.
 */
export interface SdkHost {
  app: SdkBacking;
  sessions: Sessions;
  projects: Projects;
  tasks: Tasks;
  nodes: Nodes;
  ui: Ui;
  main: MainArea;
  http: { extension(name: string): ExtensionClient };
  socket: Pick<IAppClient, "subscribe" | "onConnection">;
}

/** `A` is the extension's HTTP API, which only types `http.call`: the host calls any method by its name. */
export function createReinsSdk<A extends HttpApi = HttpApi>(extension: ExtensionInfo, { app, sessions, projects, tasks, nodes, ui, main, http, socket }: SdkHost): ReinsSdk<A> {
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
      onDidChange: (listener: () => void) => main.subscribe(listener),
    }),
    views: Object.freeze({
      register: <K extends keyof ViewTypes>(name: K, renderer: ViewRenderer<ViewTypes[K]>) => app.views.register(name, renderer, extension.name),
    } satisfies Views),
    messages: Object.freeze({ registerDecorator: (decorator: MessageDecorator) => app.decorators.registerDecorator(decorator, extension.name) } satisfies Messages),
    commands: Object.freeze({ register: (command: Command) => app.commands.register(command, extension.name) } satisfies Commands),
    projects: Object.freeze({
      list: () => projects.list(),
      onDidChange: projects.onDidChange.bind(projects),
      create: projects.create.bind(projects),
      update: projects.update.bind(projects),
      remove: projects.remove.bind(projects),
    } satisfies Projects),
    tasks: Object.freeze({
      list: tasks.list.bind(tasks),
      loaded: tasks.loaded.bind(tasks),
      onDidChange: tasks.onDidChange.bind(tasks),
      create: tasks.create.bind(tasks),
      update: tasks.update.bind(tasks),
      remove: tasks.remove.bind(tasks),
    } satisfies Tasks),
    sessions: Object.freeze({
      get: sessions.get.bind(sessions),
      create: sessions.create.bind(sessions),
      send: sessions.send.bind(sessions),
      compact: sessions.compact.bind(sessions),
      list: sessions.list.bind(sessions),
      onDidChange: sessions.onDidChange.bind(sessions),
      setUnread: sessions.setUnread.bind(sessions),
      setPinned: sessions.setPinned.bind(sessions),
      setArchived: sessions.setArchived.bind(sessions),
      setName: sessions.setName.bind(sessions),
      moveTargets: sessions.moveTargets.bind(sessions),
      move: sessions.move.bind(sessions),
    } satisfies Sessions),
    nodes: Object.freeze({ list: () => nodes.list() } satisfies Nodes),
    sidebar: Object.freeze({ registerSection: (section: SidebarSection) => app.sidebar.register(section, extension.name) }),
    ui: Object.freeze({ renameSession: ui.renameSession.bind(ui) } satisfies Ui),
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
