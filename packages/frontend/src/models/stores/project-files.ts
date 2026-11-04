/**
 * The project files API, the SDK's `files` (`Files` in `@reins/sdk`): features keep their own
 * state on top of it (docs/dev/frontend-architecture.md *Store map*).
 */

import { fileKind, ReinsHttpError } from "@reins/client";
import { Loadable } from "../../helpers/loadable.js";
import { formatBytes } from "../../helpers/format-bytes.js";
import type { DirectoryEntry, Files, FileText, Source } from "@reins/sdk";
import { api } from "../api.js";
import type { InboundEventSource } from "../ws-client.js";
import type { NodesStore } from "./nodes-store.js";
import type { SessionCache } from "./session-cache.js";

export class FileReadError extends Error {
  constructor(readonly notFound: boolean) {
    super(notFound ? "File not found" : "Failed to load file");
    this.name = "FileReadError";
  }
}

const FILE_MODIFYING_TOOLS = new Set(["write", "edit", "bash"]);
// Changes are announced this long after the first event that may make one, so a burst of tool calls
// refreshes once.
const SETTLE_MS = 500;
const NO_LISTING = Loadable.idle<readonly string[]>();
// The viewed session's source and the file browser's, which can differ. Fewer would make the two
// drop and reload each other's listing on every render.
const KEPT_LISTINGS = 2;

interface Listing {
  source: Source;
  state: Loadable<readonly string[]>;
  request: number;
  /** The server said its node is offline (503) or unknown (404): it lists nothing. */
  unavailable: boolean;
  /** Its node's connection as the node list last said, null while the list does not have it. */
  nodeConnected: boolean | null;
  /** Its files may have changed, or its node has connected or disconnected, since it loaded: the next ask reloads it. */
  stale: boolean;
}

function sourceKey({ nodeId, path }: Source): string {
  return JSON.stringify([nodeId, path]);
}

function sameFiles(a: readonly string[] | null, b: readonly string[]): boolean {
  return a != null && a.length === b.length && a.every((file, index) => file === b[index]);
}

/**
 * Application-lifetime: listings are cached for the sources asked for last, and reloaded only when
 * asked for, so a source nobody shows costs neither memory nor requests. A source is read by its node
 * and path (the node file routes), whether or not a session works there. Every read is tried: the
 * server says when the node cannot be reached, and the node list says when to try a listing again.
 */
export class ProjectFiles implements Files {
  private listings = new Map<string, Listing>();
  private listeners = new Set<() => void>();
  private changeListeners = new Set<(source: Source) => void>();
  private pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribers: Array<() => void>;

  /** `sessions` places sessions: a session's events change its source's files. `nodes` names nodes and says
   * when one connects or disconnects. */
  constructor(events: InboundEventSource, sessions: Pick<SessionCache, "get">, private nodes: Pick<NodesStore, "get" | "subscribe">) {
    this.unsubscribers = [
      events.subscribe({
        event: ({ sessionId, event }) => {
          const changesFiles = (event.type === "tool_execution_end" && FILE_MODIFYING_TOOLS.has(event.toolName))
            || event.type === "agent_end";
          const placement = changesFiles ? sessions.get(sessionId)?.placement : null;
          if (placement) this.filesMayHaveChanged({ nodeId: placement.nodeId, path: placement.path });
        },
      }),
      nodes.subscribe(() => this.nodesChanged()),
    ];
  }

  listing(source: Source | null): Loadable<readonly string[]> {
    if (!source) return NO_LISTING;
    const key = sourceKey(source);
    const listing = this.listings.get(key)
      ?? { source: { nodeId: source.nodeId, path: source.path }, state: Loadable.idle(), request: 0, unavailable: false, nodeConnected: this.nodeConnected(source), stale: false };
    // Kept in the order asked for, so the first is the one asked for longest ago.
    this.listings.delete(key);
    this.listings.set(key, listing);
    for (const [oldKey, old] of this.listings) {
      if (this.listings.size <= KEPT_LISTINGS) break;
      old.request += 1;
      this.listings.delete(oldKey);
    }
    if (listing.state.status === "idle" || listing.stale) this.load(listing);
    return listing.unavailable ? NO_LISTING : listing.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFilesChanged(listener: (source: Source) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Rejects with a `FileReadError`. */
  async read(source: Source, path: string): Promise<FileText> {
    try {
      const response = await api.files.content(source, path);
      // The server says how a file is shown; a binary file's body is already its description.
      switch (fileKind(response)) {
        case "text": return { text: await response.text(), isBinary: false };
        case "binary": return { text: await response.text(), isBinary: true };
        case "preview": return { text: `Binary file (${formatBytes((await response.blob()).size)})`, isBinary: true };
      }
    } catch (error) {
      throw new FileReadError(error instanceof ReinsHttpError && error.status === 404);
    }
  }

  async listDirectory(source: Source, path: string): Promise<DirectoryEntry[]> {
    return (await api.files.tree(source, path)).entries;
  }

  contentUrl(source: Source, path: string, { download = false } = {}): string {
    return api.files.contentUrl(source, path, { download });
  }

  async upload(source: Source, files: FileList | readonly File[], { folder = ".", onProgress }: { folder?: string; onProgress?: (percent: number) => void } = {}): Promise<string[]> {
    const { uploaded } = await api.files.upload(source, files, { path: folder === "." ? undefined : folder, ...(onProgress ? { onProgress } : {}) });
    this.announceChanged(source);
    return uploaded;
  }

  nodeName(source: Source): string | null {
    return this.nodes.get(source.nodeId)?.name ?? null;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const timer of this.pendingChanges.values()) clearTimeout(timer);
    this.pendingChanges.clear();
    this.listeners.clear();
    this.changeListeners.clear();
  }

  /** A source's node connecting or disconnecting makes the next ask reload its listing, which then lists
   * its files or nothing, as the server says. A renamed node changes its name. */
  private nodesChanged(): void {
    for (const listing of this.listings.values()) {
      const connected = this.nodeConnected(listing.source);
      if (listing.nodeConnected !== null && connected !== listing.nodeConnected) listing.stale = true;
      listing.nodeConnected = connected;
    }
    this.notify();
  }

  private nodeConnected(source: Source): boolean | null {
    return this.nodes.get(source.nodeId)?.connected ?? null;
  }

  private filesMayHaveChanged(source: Source): void {
    const key = sourceKey(source);
    if (this.pendingChanges.has(key)) return;
    this.pendingChanges.set(key, setTimeout(() => {
      this.pendingChanges.delete(key);
      this.announceChanged(source);
    }, SETTLE_MS));
  }

  private announceChanged(source: Source): void {
    const listing = this.listings.get(sourceKey(source));
    // Whoever shows it asks for it again on hearing this, which reloads it.
    if (listing && !listing.unavailable) {
      listing.stale = true;
      this.notify();
    }
    for (const listener of this.changeListeners) listener(source);
  }

  private load(listing: Listing): void {
    const request = ++listing.request;
    listing.stale = false;
    listing.state = listing.state.asLoading();
    api.files.list(listing.source).then(
      ({ files }) => {
        if (request !== listing.request) return;
        listing.unavailable = false;
        listing.state = listing.state.asLoaded(sameFiles(listing.state.data, files) ? listing.state.data ?? files : files);
        this.notify();
      },
      (error: unknown) => {
        if (request !== listing.request) return;
        listing.unavailable = error instanceof ReinsHttpError && (error.status === 503 || error.status === 404);
        listing.state = listing.state.asError("Failed to load the file list");
        this.notify();
      },
    );
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
