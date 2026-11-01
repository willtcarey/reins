import { registerFileViewer } from "../../components/file-viewer/file-viewer.js";
import { FileReferenceIndex, referenceMount } from "../../extensions/message-file-references/message-file-references.js";
import { Inspector } from "../../models/inspector.js";
import { ProjectFiles } from "../../models/stores/project-files.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import { ReinsClient } from "@reins/client";
import type { ContainerId, CurrentView, ExtensionInfo, HttpApi, SessionCreation, Sessions, Source, Subject, View } from "@reins/sdk";
import { mainViewHash } from "../../routing/app-router.js";
import { CommandRegistry } from "../../sdk-host/commands.js";
import { DecoratorRegistry } from "../../sdk-host/decorators.js";
import { Extensions } from "../../sdk-host/extensions.js";
import { createReinsSdk, type SdkHost } from "../../sdk-host/create-sdk.js";
import { SettingsPages } from "../../sdk-host/settings-pages.js";
import { ViewRegistry } from "../../sdk-host/view-registry.js";
import { StubClient } from "./stub-client.js";

export interface OpenedView {
  view: View;
  container: ContainerId;
}

export type SessionCall =
  | { compact: string; instructions?: string }
  | { send: string; message: string }
  | { create: SessionCreation };

/** Sessions that record what reaches them: none is known (`get` rejects), and a session created is `new-1`,
 * `new-2`, …; `overrides` replace an operation. */
function recordingSessions(calls: SessionCall[], overrides: Partial<Sessions>): Sessions {
  let created = 0;
  return {
    get: async (sessionId) => { throw new Error(`Session ${sessionId} not found`); },
    send: async (sessionId, message) => { calls.push({ send: sessionId, message }); },
    compact: async (sessionId, instructions) => { calls.push(instructions === undefined ? { compact: sessionId } : { compact: sessionId, instructions }); },
    create: async (options) => { calls.push({ create: options }); return `new-${++created}`; },
    ...overrides,
  };
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

/**
 * An SDK over the app's parts, as app-shell builds it, for `extension`. Its files API knows `source` from a session of
 * `projectId` placed on it, `opened` records what `workspace.open` reaches the app with, `shownViews` the
 * views it shows in the main area, and `sessionCalls` what reaches its sessions (`sessions` replaces their operations).
 * The main area shows `current` until another view is shown there, about nothing; it shows the views the app has routes for.
 * Requests go to `fetch` (`mockFetch`); messages and the connection come from `client` (`fireMessage`, `fireConnection`).
 * `sdkFor` builds another extension's SDK over the same app, and `extensions` activates extensions there.
 */
export function testSdk<A extends HttpApi = HttpApi>({ source = { nodeId: "node", path: "/work" }, projectId = 1, available = true, sessions: sessionOverrides = {}, current = null, extension = { name: "test", label: "Test" } }: {
  source?: Source;
  projectId?: number;
  available?: boolean;
  sessions?: Partial<Sessions>;
  current?: CurrentView | null;
  extension?: ExtensionInfo;
} = {}) {
  const client = new StubClient();
  const sessions = new SessionCache();
  sessions.set("placed", { projectId, placement: { available, removed: false, nodeId: source.nodeId, nodeName: "Node", path: source.path } });
  const files = new ProjectFiles(client, sessions);
  const views = new ViewRegistry();
  const decorators = new DecoratorRegistry(views);
  const commands = new CommandRegistry();
  const settingsPages = new SettingsPages();
  const extensions = new Extensions({ views, decorators, commands, settingsPages });
  const opened: OpenedView[] = [];
  const shownViews: View[] = [];
  const sessionCalls: SessionCall[] = [];
  let shown = current;
  const host: SdkHost = {
    app: { files, views, decorators, commands, settingsPages, open: (view, container) => opened.push({ view, container }) },
    sessions: recordingSessions(sessionCalls, sessionOverrides),
    main: {
      current: () => shown,
      show: (view) => {
        if (!mainViewHash(view)) return false;
        shownViews.push(view);
        shown = { view, subject: [] };
        return true;
      },
    },
    http: new ReinsClient(),
    socket: client,
  };
  const reins = createReinsSdk<A>(extension, host);
  const sdkFor = (other: ExtensionInfo) => createReinsSdk(other, host);
  return { client, sessions, files, views, decorators, commands, settingsPages, extensions, reins, sdkFor, source, opened, shownViews, sessionCalls };
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
