import { registerFileViewer } from "../../components/file-viewer/file-viewer.js";
import { FileReferenceIndex, referenceMount } from "../../extensions/message-file-references/message-file-references.js";
import { Inspector } from "../../models/inspector.js";
import { ProjectFiles } from "../../models/stores/project-files.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { ContainerId, Sessions, Source, View } from "@reins/sdk";
import { CommandRegistry } from "../../sdk-host/commands.js";
import { DecoratorRegistry } from "../../sdk-host/decorators.js";
import { createReinsSdk } from "../../sdk-host/create-sdk.js";
import { ViewRegistry } from "../../sdk-host/view-registry.js";
import { StubClient } from "./stub-client.js";

export interface OpenedView {
  view: View;
  container: ContainerId;
}

export type SessionCall =
  | { compact: string; options: { instructions?: string } }
  | { createBeside: string; options: { prompt?: string } }
  | { open: string };

/** Sessions that record what reaches them: a session created is `new-1`, `new-2`, …; `overrides` replace an operation. */
function recordingSessions(calls: SessionCall[], overrides: Partial<Sessions>): Sessions {
  let created = 0;
  return {
    compact: async (sessionId, options = {}) => { calls.push({ compact: sessionId, options }); },
    createBeside: async (sessionId, options = {}) => { calls.push({ createBeside: sessionId, options }); return `new-${++created}`; },
    open: (sessionId) => { calls.push({ open: sessionId }); },
    ...overrides,
  };
}

/**
 * An SDK over the app's parts, as app-shell builds it. Its files API knows `source` from a session of
 * `projectId` placed on it, `opened` records what `workspace.open` reaches the app with, and
 * `sessionCalls` what reaches its sessions (`sessions` replaces their operations).
 */
export function testSdk({ source = { nodeId: "node", path: "/work" }, projectId = 1, available = true, sessions: sessionOverrides = {} }: {
  source?: Source;
  projectId?: number;
  available?: boolean;
  sessions?: Partial<Sessions>;
} = {}) {
  const client = new StubClient();
  const sessions = new SessionCache();
  sessions.set("placed", { projectId, placement: { available, removed: false, nodeId: source.nodeId, nodeName: "Node", path: source.path } });
  const files = new ProjectFiles(client, sessions);
  const views = new ViewRegistry();
  const decorators = new DecoratorRegistry(views);
  const commands = new CommandRegistry();
  const opened: OpenedView[] = [];
  const sessionCalls: SessionCall[] = [];
  const reins = createReinsSdk(
    { files, views, decorators, commands, open: (view, container) => opened.push({ view, container }) },
    recordingSessions(sessionCalls, sessionOverrides),
  );
  return { client, sessions, files, views, decorators, commands, reins, source, opened, sessionCalls };
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
