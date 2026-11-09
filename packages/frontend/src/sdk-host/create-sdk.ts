/**
 * Builds the Reins SDK (`@reins/sdk`) over the app's state (docs/dev/reins-sdk.md): one for each extension, which
 * app-shell gives to its register function; nothing else holds it.
 */

import type { ExtensionClient } from "@reins/client";
import type {
  Command, Commands, ContainerId, CurrentView, Disposer, ExtensionInfo, Files, HttpApi, HttpCallArgs, HttpOutput, MessageDecorator, Messages, Nodes, OpenOptions, PanePresentation, Projects,
  ReinsSdk, Sessions, SettingsPage, SidebarSection, Subject, SubjectTypes, Tasks, Ui, View, ViewRenderer, Views, ViewTypes,
} from "@reins/sdk";
import { SCOPE_ATTRIBUTE } from "@reins/sdk";
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
}

/** A container of the workspace, as `workspace.open(view, { in })` reaches it: each says what opening does there. */
export interface Container {
  /** Shows the view there; throws for a view it cannot show. */
  open(view: View): void;
}

/**
 * The main area, which shows a view's route or a page that is not a view (`RoutedMainArea` in the app). Opening
 * goes to the view's route, or shows the new view in place of the same one shown.
 */
export interface MainArea extends Container {
  /** The view shown and what it is about, as the view tells; null on a page that is not a view. */
  current(): CurrentView | null;
  /** Listens for the view shown, or what it is about, changing. */
  subscribe(listener: () => void): Disposer;
}

/** The workspace's containers by ID; the main area also answers `workspace.current` and `onDidChange`. */
export interface SdkContainers extends Readonly<Record<ContainerId, Container>> {
  readonly main: MainArea;
  /** Also closes a view's tab (`workspace.close`). */
  readonly inspector: Container & { closeView(view: View): void };
}

/**
 * What every extension's SDK is built over. `sessions`, `projects`, `tasks` and `nodes` (`SdkSessions`, `SdkProjects`,
 * `SdkTasks`, `SdkNodes` in the app) use more of the app than the backing. `containers` are the Inspector (`AppStore.inspector`)
 * and the main area (the workspace it shows and the router, apart from `AppStore` because it navigates). `http` and `socket` are the server's HTTP API and its WebSocket.
 */
export interface SdkHost {
  app: SdkBacking;
  sessions: Sessions;
  projects: Projects;
  tasks: Tasks;
  nodes: Nodes;
  ui: Ui;
  containers: SdkContainers;
  http: { extension(name: string): ExtensionClient };
  socket: Pick<IAppClient, "subscribe" | "onConnection">;
}

/** What each SDK object's registrations and subscriptions return, so its extension's disposal can undo them. */
const owned = new WeakMap<object, Disposer[]>();

/** The disposers of everything made through `sdk` so far: its registrations and its listeners. */
export function sdkDisposers(sdk: object): Disposer[] {
  return owned.get(sdk) ?? [];
}

/**
 * `A` is the extension's HTTP API, which only types `http.call`: the host calls any method by its name.
 * `scope`: mount each of its views in an element with `SCOPE_ATTRIBUTE`, where its scoped stylesheet applies.
 */
export function createReinsSdk<A extends HttpApi = HttpApi>(
  extension: ExtensionInfo,
  { app, sessions, projects, tasks, nodes, ui, containers, http, socket }: SdkHost,
  { scope }: { scope?: string } = {},
): ReinsSdk<A> {
  const scoped = <T extends { mount: (target: HTMLElement, ...rest: never[]) => unknown }>(mountable: T): T =>
    scope ? { ...mountable, mount: inScope(mountable.mount.bind(mountable), scope) } : mountable;
  const scopedPane = <V extends View>(pane: PanePresentation<V>): PanePresentation<V> => ({
    ...scoped(pane),
    icon: scoped(pane.icon),
    ...(pane.toolbar ? { toolbar: scoped(pane.toolbar) } : {}),
  });
  const { main } = containers;
  const disposers: Disposer[] = [];
  const own = (dispose: Disposer): Disposer => {
    disposers.push(dispose);
    return dispose;
  };
  const currentSubject = <K extends keyof SubjectTypes>(type: K): SubjectTypes[K] | null => {
    const found = main.current()?.subject.find((subject): subject is Subject & { type: K; id: SubjectTypes[K] } => subject.type === type);
    return found ? found.id : null;
  };
  const api = http.extension(extension.name);
  const sdk = Object.freeze({
    files: app.files,
    workspace: Object.freeze({
      open: (view: View, { in: container = "inspector" }: OpenOptions = {}) => containers[container].open(view),
      close: (view: View) => containers.inspector.closeView(view),
      current: () => main.current(),
      currentSubject,
      onDidChange: (listener: () => void) => own(main.subscribe(listener)),
    }),
    views: Object.freeze({
      register: <K extends keyof ViewTypes>(name: K, renderer: ViewRenderer<ViewTypes[K]>) => own(app.views.register(name, scope ? {
        ...renderer,
        ...(renderer.pane ? { pane: scopedPane(renderer.pane) } : {}),
        ...(renderer.inline ? { inline: scoped(renderer.inline) } : {}),
      } : renderer, extension.name)),
    } satisfies Views),
    messages: Object.freeze({ registerDecorator: (decorator: MessageDecorator) => own(app.decorators.registerDecorator(decorator, extension.name)) } satisfies Messages),
    commands: Object.freeze({ register: (command: Command) => own(app.commands.register(command, extension.name)) } satisfies Commands),
    projects: Object.freeze({
      list: () => projects.list(),
      onDidChange: (listener: Parameters<Projects["onDidChange"]>[0]) => own(projects.onDidChange(listener)),
      create: projects.create.bind(projects),
      update: projects.update.bind(projects),
      remove: projects.remove.bind(projects),
    } satisfies Projects),
    tasks: Object.freeze({
      list: tasks.list.bind(tasks),
      loaded: tasks.loaded.bind(tasks),
      onDidChange: (listener: Parameters<Tasks["onDidChange"]>[0]) => own(tasks.onDidChange(listener)),
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
      onDidChange: (listener: Parameters<Sessions["onDidChange"]>[0]) => own(sessions.onDidChange(listener)),
      setUnread: sessions.setUnread.bind(sessions),
      setPinned: sessions.setPinned.bind(sessions),
      setArchived: sessions.setArchived.bind(sessions),
      setName: sessions.setName.bind(sessions),
      moveTargets: sessions.moveTargets.bind(sessions),
      move: sessions.move.bind(sessions),
    } satisfies Sessions),
    nodes: Object.freeze({ list: () => nodes.list() } satisfies Nodes),
    sidebar: Object.freeze({ registerSection: (section: SidebarSection) => own(app.sidebar.register(scoped(section), extension.name)) }),
    ui: Object.freeze({ renameSession: ui.renameSession.bind(ui) } satisfies Ui),
    settings: Object.freeze({ register: (page: SettingsPage) => own(app.settingsPages.register(extension, scoped(page))) }),
    http: Object.freeze({
      call: <K extends keyof A & string>(method: K, ...[input, options]: HttpCallArgs<A[K]>) => api.call<HttpOutput<A[K]>>(method, input, options),
    }),
    onMessage: (listener: (message: object) => void): Disposer => own(socket.subscribe({
      extension: ({ extension: sender, message }) => {
        if (sender === extension.name) listener(message);
      },
    })),
    onReconnect: (listener: () => void): Disposer => {
      // The client tells a lost connection only after it was connected, so the first connect is not a return.
      let lost = false;
      return own(socket.onConnection((connected) => {
        if (!connected) lost = true;
        else if (lost) {
          lost = false;
          listener();
        }
      }));
    },
  } satisfies ReinsSdk<A>);
  owned.set(sdk, disposers);
  return sdk;
}

/** Mounts into a `display: contents` element of its own with the scope, which the host's own content around it never has. */
function inScope<R extends unknown[], T>(mount: (target: HTMLElement, ...rest: R) => T, scope: string) {
  return (target: HTMLElement, ...rest: R): T => {
    const element = target.ownerDocument.createElement("div");
    element.setAttribute(SCOPE_ATTRIBUTE, scope);
    element.style.display = "contents";
    target.append(element);
    return mount(element, ...rest);
  };
}
