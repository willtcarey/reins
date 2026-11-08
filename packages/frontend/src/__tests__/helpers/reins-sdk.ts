import { registerFileViewer } from "../../components/file-viewer/file-viewer.js";
import { FileReferenceIndex, referenceMount } from "../../extensions/message-file-references/message-file-references.js";
import { Inspector } from "../../models/inspector.js";
import { NodesStore } from "../../models/stores/nodes-store.js";
import { Loadable } from "../../helpers/loadable.js";
import { ProjectFiles } from "../../models/stores/project-files.js";
import type { NodeView } from "@backend/models/node.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import { ProjectsStore } from "../../models/stores/projects-store.js";
import { ConversationsStore } from "../../models/stores/conversations-store.js";
import { SessionOperations } from "../../models/session-operations.js";
import { ReinsClient } from "@reins/client";
import type { ContainerId, CurrentView, ExtensionInfo, HttpApi, PaneContext, SessionCreation, Sessions, Source, Subject, View } from "@reins/sdk";
import { appRouter, mainViewHash, mainViewOf } from "../../routing/app-router.js";
import { RoutedMainArea, type MainHistory } from "../../routing/main-area.js";
import { CommandRegistry } from "../../sdk-host/commands.js";
import { DecoratorRegistry } from "../../sdk-host/decorators.js";
import { ExtensionHost } from "../../extension-system/host.js";
import { createReinsSdk, type SdkHost } from "../../sdk-host/create-sdk.js";
import { SettingsPages } from "../../sdk-host/settings-pages.js";
import { SdkSessions } from "../../sdk-host/sessions.js";
import { SdkUi } from "../../sdk-host/ui.js";
import { SdkNodes, SdkProjects, SdkTasks } from "../../sdk-host/projects.js";
import { SidebarSections, type SidebarLayout, type SidebarLayoutStorage } from "../../sdk-host/sidebar-sections.js";
import { ViewRegistry } from "../../sdk-host/view-registry.js";
import { StubClient } from "./stub-client.js";

/** A pane's context in `container`, whose subject changes are not listened to. */
export function paneContext(container: ContainerId): PaneContext {
  return { container, subjectChanged: () => {} };
}

export interface OpenedView {
  view: View;
  container: ContainerId;
}

export type SessionCall =
  | { compact: string; instructions?: string }
  | { send: string; message: string }
  | { create: SessionCreation };

/** Sessions whose operations record what reaches them: `get` answers for a session the app has (`cache`), as the
 * app does, and rejects for any other without asking a server; a session created is `new-1`, `new-2`, …; their
 * lists and actions are the app's (`live`), over its stores. `overrides` replace any. */
function recordingSessions(calls: SessionCall[], live: SdkSessions, cache: SessionCache, overrides: Partial<Sessions>): Sessions {
  let created = 0;
  return {
    get: async (sessionId) => {
      if (!cache.get(sessionId)?.placement) throw new Error(`Session ${sessionId} not found`);
      return live.get(sessionId);
    },
    send: async (sessionId, message) => { calls.push({ send: sessionId, message }); },
    compact: async (sessionId, instructions) => { calls.push(instructions === undefined ? { compact: sessionId } : { compact: sessionId, instructions }); },
    create: async (options) => { calls.push({ create: options }); return `new-${++created}`; },
    list: (query) => live.list(query),
    onDidChange: (listener) => live.onDidChange(listener),
    setUnread: (sessionId, unread) => live.setUnread(sessionId, unread),
    setPinned: (sessionId, pinned) => live.setPinned(sessionId, pinned),
    setArchived: (sessionId, archived) => live.setArchived(sessionId, archived),
    setName: (sessionId, name) => live.setName(sessionId, name),
    moveTargets: (sessionId) => live.moveTargets(sessionId),
    move: (sessionId, to) => live.move(sessionId, to),
    ...overrides,
  };
}

/** A sidebar layout kept in memory, as the server's setting would keep it; `saved` is each layout saved. */
export function memoryLayout(initial: SidebarLayout | null = null) {
  let stored = initial;
  const saved: SidebarLayout[] = [];
  const storage: SidebarLayoutStorage = {
    load: async () => stored,
    save: async (layout) => { stored = layout; saved.push(layout); },
  };
  return { storage, saved };
}

/** The main area showing session `sessionId`: about it, then its task and project once its details are known. */
export function shownSession(sessionId: string, details?: { projectId: number; taskId: number | null }): CurrentView {
  const subject: Subject[] = [{ type: "session", id: sessionId }];
  if (details?.taskId != null) subject.push({ type: "task", id: details.taskId });
  if (details) subject.push({ type: "project", id: details.projectId });
  return { view: { view: "session", sessionId }, subject };
}

/** The main area showing the new session page: about the task and project chosen on it. */
export function shownNewSession(projectId: number | null, taskId: number | null = null): CurrentView {
  const subject: Subject[] = [];
  if (taskId != null) subject.push({ type: "task", id: taskId });
  if (projectId != null) subject.push({ type: "project", id: projectId });
  return { view: { view: "new-session", projectId, taskId }, subject };
}

/** A node as `node_updated` carries it. */
export function testNode(id: string, name: string, connected = true): NodeView {
  return { id, name, connected, paired: true, hostname: null, pairedAt: null, revokedAt: null, sources: [], build: null, failure: null };
}

/**
 * An SDK over the app's parts, as app-shell builds it, for `extension`. Its node list has `source`'s node, "Node",
 * connected when `available` (another node is listed once a `node_updated` names it), and a session of `projectId`
 * is placed on `source`. `opened` records what `workspace.open` reaches the app with, `shownViews` the views it shows
 * in the main area (the app's main area, over a history kept in `mainHistory`), and `sessionCalls` what reaches its sessions (`sessions` replaces their operations).
 * The main area shows `current` until another view is shown there, about nothing.
 * Requests go to `fetch` (`mockFetch`); messages and the connection come from `client` (`fireMessage`, `fireConnection`).
 * Projects, tasks and sessions are the app's over a real `ProjectsStore` (`projectsStore`) and session cache
 * (`sessions`), which a test fills; `showMain` changes what the main area shows. `sidebar` is the sidebar's
 * sections, its layout kept in `sidebarLayout` (`memoryLayout`; none by default).
 * `sdkFor` builds another extension's SDK over the same app, and `extensionHost` activates extensions there.
 */
export function testSdk<A extends HttpApi = HttpApi>({ source = { nodeId: "node", path: "/work" }, projectId = 1, available = true, sessions: sessionOverrides = {}, current = null, extension = { name: "test", label: "Test" }, sidebarLayout = null }: {
  source?: Source;
  projectId?: number;
  available?: boolean;
  sessions?: Partial<Sessions>;
  current?: CurrentView | null;
  extension?: ExtensionInfo;
  sidebarLayout?: SidebarLayoutStorage | null;
} = {}) {
  const client = new StubClient();
  const sessions = new SessionCache();
  sessions.set("placed", { projectId, placement: { available, removed: false, nodeId: source.nodeId, nodeName: "Node", path: source.path } });
  const nodes = new NodesStore(client);
  nodes.nodes = Loadable.idle<NodeView[]>().asLoaded([testNode(source.nodeId, "Node", available)]);
  const files = new ProjectFiles(client, sessions, nodes);
  const views = new ViewRegistry();
  const decorators = new DecoratorRegistry(views);
  const commands = new CommandRegistry();
  const settingsPages = new SettingsPages();
  const sidebar = new SidebarSections(sidebarLayout);
  const extensionHost = new ExtensionHost({ views, decorators, commands, settingsPages, sidebar });
  const projectsStore = new ProjectsStore(sessions, client);
  const live = new SdkSessions({ sessionCache: sessions, projectsStore, sessionOperations: new SessionOperations({ conversations: new ConversationsStore({ sessionCache: sessions }) }) });
  const opened: OpenedView[] = [];
  const shownViews: View[] = [];
  const sessionCalls: SessionCall[] = [];
  let shown = current;
  /** The main area's history entries, the last the one shown, starting at `current`'s route. */
  const mainHistory = [current ? mainViewHash(current.view) ?? "#/" : "#/"];
  /** Navigates as the browser would: each view a route shows is a new object, about nothing. */
  const history: MainHistory = {
    get hash() { return mainHistory.at(-1) ?? ""; },
    go(hash, replace) {
      if (replace) mainHistory[mainHistory.length - 1] = hash;
      else if (hash !== history.hash) mainHistory.push(hash);
      const view = mainViewOf(appRouter.resolve(hash));
      if (view) shownViews.push(view);
      showMain(view && { view, subject: [] });
    },
  };
  const main = new RoutedMainArea(views, () => ({ current: () => shown, revealMain() {} }), history);
  /** Shows `view` in the main area, as navigating there would, and tells `workspace.onDidChange` listeners. */
  const showMain = (view: CurrentView | null) => {
    shown = view;
    main.changed();
  };
  const recorded = recordingSessions(sessionCalls, live, sessions, sessionOverrides);
  const host: SdkHost = {
    app: { files, views, decorators, commands, settingsPages, sidebar },
    sessions: recorded,
    ui: new SdkUi(sessions, recorded),
    projects: new SdkProjects(projectsStore),
    tasks: new SdkTasks(projectsStore),
    nodes: new SdkNodes(projectsStore),
    containers: { inspector: { open: (view) => opened.push({ view, container: "inspector" }) }, main },
    http: new ReinsClient(),
    socket: client,
  };
  const reins = createReinsSdk<A>(extension, host);
  const sdkFor = (other: ExtensionInfo, scope?: string) => createReinsSdk(other, host, { scope });
  return { client, sessions, projectsStore, files, views, decorators, commands, settingsPages, sidebar, extensionHost, reins, sdkFor, source, opened, shownViews, mainHistory, sessionCalls, showMain };
}

/** An Inspector over views that know the file viewer's `file` view, as the app's do. */
export function testInspector(): Inspector {
  const { reins, views } = testSdk();
  registerFileViewer(reins);
  return new Inspector(views);
}

/** Decorations of messages of a checkout whose listing is `files`, applying file references, and what activating them opened. */
export function referenceDecorators(files: readonly string[], checkoutPath = "/work/project") {
  const sdk = testSdk({ source: { nodeId: "node", path: checkoutPath } });
  const index = new FileReferenceIndex(files, sdk.source);
  sdk.reins.views.register("file-reference", { inline: { mount: referenceMount(sdk.reins.workspace) } });
  sdk.reins.messages.registerDecorator({
    decorate: (text) => index.find(text),
    decorateCode: (code) => index.resolveCode(code),
    onChange: () => () => {},
  });
  const decorators = sdk.decorators.bind(sdk.source);
  if (!decorators) throw new Error("Expected decorators");
  return { decorators, opened: sdk.opened, source: sdk.source };
}
