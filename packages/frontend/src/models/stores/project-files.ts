/**
 * The project files API, the SDK's `files` (`Files` in `@reins/sdk`): features keep their own
 * state on top of it (docs/dev/frontend-architecture.md *Store map*).
 */

import { ReinsHttpError } from "@reins/client";
import { Loadable } from "../../helpers/loadable.js";
import type { DirectoryEntry, Files, FileText, Source } from "@reins/sdk";
import { api } from "../api.js";
import type { InboundEventSource } from "../ws-client.js";
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

/** How a source is reached today, and whether its node is connected. */
interface Route {
  projectId: number;
  available: boolean;
}

interface Listing {
  source: Source;
  state: Loadable<readonly string[]>;
  request: number;
  available: boolean;
  /** Its files may have changed, or its node has come back, since it loaded: the next ask reloads it. */
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
 * asked for, so a source nobody shows costs neither memory nor requests. Sessions carry no source
 * ID, so a source is named by its node and path, and the sessions known on it say how to reach it:
 * today through their project's file routes, which read the project's default source
 * (node-contract.md *Which checkout a call works in*), whichever source is named. Only this changes
 * once a route reads a source by node and path.
 */
export class ProjectFiles implements Files {
  private listings = new Map<string, Listing>();
  private routes = new Map<string, Route | null>();
  private listeners = new Set<() => void>();
  private changeListeners = new Set<(source: Source) => void>();
  private pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribers: Array<() => void>;

  /** `sessions` places sessions: a session's events change its source's files, and its placement says how to reach that source. */
  constructor(events: InboundEventSource, private sessions: Pick<SessionCache, "get" | "entries" | "subscribeAll">) {
    this.unsubscribers = [
      events.subscribe({
        event: ({ sessionId, event }) => {
          const changesFiles = (event.type === "tool_execution_end" && FILE_MODIFYING_TOOLS.has(event.toolName))
            || event.type === "agent_end";
          const placement = changesFiles ? sessions.get(sessionId)?.placement : null;
          if (placement) this.filesMayHaveChanged({ nodeId: placement.nodeId, path: placement.path });
        },
      }),
      sessions.subscribeAll(() => this.sessionsChanged()),
    ];
  }

  listing(source: Source | null): Loadable<readonly string[]> {
    if (!source) return NO_LISTING;
    const key = sourceKey(source);
    const listing = this.listings.get(key)
      ?? { source: { nodeId: source.nodeId, path: source.path }, state: Loadable.idle(), request: 0, available: false, stale: false };
    // Kept in the order asked for, so the first is the one asked for longest ago.
    this.listings.delete(key);
    this.listings.set(key, listing);
    for (const [oldKey, old] of this.listings) {
      if (this.listings.size <= KEPT_LISTINGS) break;
      old.request += 1;
      this.listings.delete(oldKey);
    }
    listing.available = this.route(source)?.available ?? false;
    if (!listing.available) return NO_LISTING;
    if (listing.state.status === "idle" || listing.stale) this.load(listing);
    return listing.state;
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
    const route = this.route(source);
    if (!route) throw new FileReadError(false);
    try {
      const response = await api.files.content(route.projectId, path);
      const contentType = response.headers.get("content-type") || "";
      if (isTextMimeType(contentType)) return { text: await response.text(), isBinary: false };
      return { text: `Binary file (${formatSize((await response.blob()).size)})`, isBinary: true };
    } catch (error) {
      throw new FileReadError(error instanceof ReinsHttpError && error.status === 404);
    }
  }

  async listDirectory(source: Source, path: string): Promise<DirectoryEntry[]> {
    const route = this.route(source);
    if (!route) throw new Error("Unknown source");
    return (await api.files.tree(route.projectId, path)).entries;
  }

  contentUrl(source: Source, path: string, { download = false } = {}): string | null {
    const route = this.route(source);
    return route ? api.files.contentUrl(route.projectId, path, { download }) : null;
  }

  /** The project a source belongs to, from the sessions known on it. */
  projectOf(source: Source): number | null {
    return this.route(source)?.projectId ?? null;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const timer of this.pendingChanges.values()) clearTimeout(timer);
    this.pendingChanges.clear();
    this.listeners.clear();
    this.changeListeners.clear();
  }

  // Looked up on every listing asked for while rendering, so it is cached until sessions change.
  private route(source: Source): Route | null {
    const key = sourceKey(source);
    const cached = this.routes.get(key);
    if (cached !== undefined) return cached;
    const placed = this.sessions.entries().filter(({ projectId, placement }) => projectId != null
      && placement?.nodeId === source.nodeId && placement.path === source.path);
    const projectId = placed[0]?.projectId;
    const route = projectId == null ? null : {
      projectId,
      available: placed.some(({ placement }) => placement != null && placement.available && !placement.removed),
    };
    this.routes.set(key, route);
    return route;
  }

  /** A source's node going offline empties its listing; coming back makes the next ask reload it. */
  private sessionsChanged(): void {
    this.routes.clear();
    let changed = false;
    for (const listing of this.listings.values()) {
      const available = this.route(listing.source)?.available ?? false;
      if (available === listing.available) continue;
      listing.available = available;
      listing.stale ||= available;
      changed = true;
    }
    if (changed) this.notify();
  }

  private filesMayHaveChanged(source: Source): void {
    const key = sourceKey(source);
    if (this.pendingChanges.has(key)) return;
    this.pendingChanges.set(key, setTimeout(() => {
      this.pendingChanges.delete(key);
      const listing = this.listings.get(key);
      // Whoever shows it asks for it again on hearing this, which reloads it.
      if (listing?.available) {
        listing.stale = true;
        this.notify();
      }
      for (const listener of this.changeListeners) listener(source);
    }, SETTLE_MS));
  }

  private load(listing: Listing): void {
    const route = this.route(listing.source);
    if (!route) return;
    const request = ++listing.request;
    listing.stale = false;
    listing.state = listing.state.asLoading();
    api.files.list(route.projectId).then(
      ({ files }) => {
        if (request !== listing.request) return;
        listing.state = listing.state.asLoaded(sameFiles(listing.state.data, files) ? listing.state.data ?? files : files);
        this.notify();
      },
      () => {
        if (request !== listing.request) return;
        listing.state = listing.state.asError("Failed to load the file list");
        this.notify();
      },
    );
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** MIME types that are textual despite not starting with `text/`. */
const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-ruby",
  "application/x-python",
  "application/x-perl",
  "application/x-php",
  "application/x-awk",
  "application/x-lua",
  "application/x-makefile",
  "application/x-httpd-php",
]);

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_APPLICATION_TYPES.has(mimeType);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
