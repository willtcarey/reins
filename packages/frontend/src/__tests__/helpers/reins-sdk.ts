import { registerFileViewer } from "../../components/file-viewer/file-viewer.js";
import { FileReferenceIndex, referenceMount } from "../../extensions/message-file-references/message-file-references.js";
import { Inspector } from "../../models/inspector.js";
import { ProjectFiles } from "../../models/stores/project-files.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { ContainerId, Source, View } from "@reins/sdk";
import { DecoratorRegistry } from "../../sdk-host/decorators.js";
import { createReinsSdk } from "../../sdk-host/create-sdk.js";
import { ViewRegistry } from "../../sdk-host/view-registry.js";
import { StubClient } from "./stub-client.js";

export interface OpenedView {
  view: View;
  container: ContainerId;
}

/**
 * An SDK over the app's parts, as app-shell builds it. Its files API knows `source` from a session of
 * `projectId` placed on it, and `opened` records what `workspace.open` reaches the app with.
 */
export function testSdk({ source = { nodeId: "node", path: "/work" }, projectId = 1, available = true }: {
  source?: Source;
  projectId?: number;
  available?: boolean;
} = {}) {
  const client = new StubClient();
  const sessions = new SessionCache();
  sessions.set("placed", { projectId, placement: { available, removed: false, nodeId: source.nodeId, nodeName: "Node", path: source.path } });
  const files = new ProjectFiles(client, sessions);
  const views = new ViewRegistry();
  const decorators = new DecoratorRegistry(views);
  const opened: OpenedView[] = [];
  const reins = createReinsSdk({ files, views, decorators, open: (view, container) => opened.push({ view, container }) });
  return { client, sessions, files, views, decorators, reins, source, opened };
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
