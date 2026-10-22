import { reins } from "reins-sdk";
import { FileReferenceIndex } from "../../models/file-references.js";
import { ProjectFiles } from "../../models/stores/project-files.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { ContainerId, Disposer, Source, View } from "../../reins-sdk/contract.js";
import { ReinsHost, installHost } from "../../reins-sdk/host.js";
import { StubClient } from "./stub-client.js";

export interface OpenedView {
  view: View;
  container: ContainerId;
  projectId: number | null;
}

let uninstall: Disposer | null = null;

/** Run after every test by the test preload (test-setup.ts), so no test leaves its host to the next. */
export function uninstallTestHost(): void {
  uninstall?.();
  uninstall = null;
}

/**
 * Installs a host as the page's, the one `reins` reaches, until the test ends. Its files API knows
 * `source` from a session of `projectId` placed on it, and a mounted workspace records what
 * `workspace.open` reaches it with.
 */
export function installTestHost({ source = { nodeId: "node", path: "/work" }, projectId = 1, available = true }: {
  source?: Source;
  projectId?: number;
  available?: boolean;
} = {}) {
  const client = new StubClient();
  const sessions = new SessionCache();
  sessions.set("placed", { projectId, placement: { available, removed: false, nodeId: source.nodeId, nodeName: "Node", path: source.path } });
  const files = new ProjectFiles(client, sessions);
  const host = new ReinsHost(files);
  uninstallTestHost();
  uninstall = installHost(host);
  const opened: OpenedView[] = [];
  host.mountWorkspace({ open: (view, container, openedProjectId) => opened.push({ view, container, projectId: openedProjectId }) });
  return { client, sessions, files, host, source, opened };
}

/** Decorations of messages of a checkout whose listing is `files`, applying file references, and what activating them opened. */
export function referenceDecorations(files: readonly string[], checkoutPath = "/work/project") {
  const installed = installTestHost({ source: { nodeId: "node", path: checkoutPath } });
  const index = new FileReferenceIndex(files, checkoutPath);
  reins.messages.registerDecorator({
    decorate: (text) => index.find(text),
    decorateCode: (code) => index.resolveCode(code),
    onChange: () => () => {},
  });
  const decorations = installed.host.decorations(installed.source);
  if (!decorations) throw new Error("Expected decorations");
  return { decorations, opened: installed.opened };
}
