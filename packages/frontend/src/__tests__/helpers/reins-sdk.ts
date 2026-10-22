import { FileReferenceIndex } from "../../models/file-references.js";
import { ProjectFiles } from "../../models/stores/project-files.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { ContainerId, Source, View } from "../../reins-sdk/contract.js";
import { ReinsHost } from "../../reins-sdk/host.js";
import { StubClient } from "./stub-client.js";

export interface OpenedView {
  view: View;
  container: ContainerId;
  projectId: number | null;
}

/**
 * A host whose files API knows `source` from a session of `projectId` placed on it, and a mounted
 * workspace that records what `workspace.open` reaches it with.
 */
export function placedHost({ source = { nodeId: "node", path: "/work" }, projectId = 1, available = true }: {
  source?: Source;
  projectId?: number;
  available?: boolean;
} = {}) {
  const client = new StubClient();
  const sessions = new SessionCache();
  sessions.set("placed", { projectId, placement: { available, removed: false, nodeId: source.nodeId, nodeName: "Node", path: source.path } });
  const files = new ProjectFiles(client, sessions);
  const host = new ReinsHost(files);
  const opened: OpenedView[] = [];
  host.mountWorkspace({ open: (view, container, openedProjectId) => opened.push({ view, container, projectId: openedProjectId }) });
  return { client, sessions, files, host, sdk: host.sdk, source, opened };
}

/** Decorations of messages of a checkout whose listing is `files`, applying file references, and what activating them opened. */
export function referenceDecorations(files: readonly string[], checkoutPath = "/work/project") {
  const placed = placedHost({ source: { nodeId: "node", path: checkoutPath } });
  const index = new FileReferenceIndex(files, checkoutPath);
  placed.sdk.messages.registerDecorator({
    decorate: (text) => index.find(text),
    decorateCode: (code) => index.resolveCode(code),
    onChange: () => () => {},
  });
  const decorations = placed.host.decorations(placed.source);
  if (!decorations) throw new Error("Expected decorations");
  return { decorations, opened: placed.opened };
}
