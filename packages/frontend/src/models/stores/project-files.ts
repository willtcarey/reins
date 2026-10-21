/**
 * The project files API: a source's file listing, reads of its files, and when they may have
 * changed. Features keep their own state on top of it (docs/dev/frontend-architecture.md *Store map*).
 */

import type { DirectoryEntry } from "@backend/models/sources.js";
import { ReinsHttpError } from "@reins/client";
import { Loadable } from "../../helpers/loadable.js";
import { api } from "../api.js";
import type { InboundEventSource } from "../ws-client.js";
import type { SessionCache } from "./session-cache.js";

/**
 * A source, whose files are read on its node (ADR-029). Session placements carry no source ID, so a
 * source is named by its node and path, which are all that its files depend on.
 */
export interface FileSource {
  nodeId: string;
  /** The checkout's path on the node, which absolute paths in its sessions' output are under. */
  path: string;
  /** Whether the node is connected; nothing is listed while it is not. */
  available: boolean;
  /** Only how a request reaches the source today: through its project's file routes. Goes once a route reads a source by node and path. */
  projectId: number;
}

type SourceName = Pick<FileSource, "nodeId" | "path">;

/** Whether two name the same source, whether or not its node is connected. */
export function sameSource(a: SourceName | null, b: SourceName | null): boolean {
  if (!a || !b) return a === b;
  return a.nodeId === b.nodeId && a.path === b.path;
}

export interface FileText {
  /** The file's text, or for a binary file a description of it. */
  text: string;
  isBinary: boolean;
}

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

interface Listing {
  source: FileSource;
  state: Loadable<readonly string[]>;
  request: number;
}

function sourceKey({ nodeId, path }: SourceName): string {
  return JSON.stringify([nodeId, path]);
}

function sameFiles(a: readonly string[] | null, b: readonly string[]): boolean {
  return a != null && a.length === b.length && a.every((file, index) => file === b[index]);
}

/**
 * Application-lifetime: listings are cached per source. Every call names its source, so which route
 * reads which source stays inside: today the project file routes read the project's default source
 * (node-contract.md *Which checkout a call works in*), whichever source is named.
 */
export class ProjectFiles {
  private listings = new Map<string, Listing>();
  private listeners = new Set<() => void>();
  private changeListeners = new Set<(source: SourceName) => void>();
  private pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: () => void;

  /** A session's events change the files of its source, as `sessions` places it. */
  constructor(events: InboundEventSource, sessions: Pick<SessionCache, "get">) {
    this.unsubscribe = events.subscribe({
      event: ({ sessionId, event }) => {
        const changesFiles = (event.type === "tool_execution_end" && FILE_MODIFYING_TOOLS.has(event.toolName))
          || event.type === "agent_end";
        const placement = changesFiles ? sessions.get(sessionId)?.placement : null;
        if (placement) this.filesMayHaveChanged({ nodeId: placement.nodeId, path: placement.path });
      },
    });
  }

  /**
   * The source's file listing, loaded the first time it is asked for while its node is connected
   * and again when its files may have changed. Idle, without files, while the node is offline. A
   * listing that comes back unchanged keeps its `data`, so what is built from it can be kept too.
   */
  listing(source: FileSource | null): Loadable<readonly string[]> {
    if (!source) return NO_LISTING;
    const key = sourceKey(source);
    let listing = this.listings.get(key);
    if (!source.available) {
      if (listing) listing.source = source;
      return NO_LISTING;
    }
    if (!listing) {
      listing = { source, state: Loadable.idle(), request: 0 };
      this.listings.set(key, listing);
    }
    const cameOnline = !listing.source.available;
    listing.source = source;
    if (listing.state.status === "idle" || (cameOnline && !listing.state.loading)) this.load(listing);
    return listing.state;
  }

  /** Listens for listings changing. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Listens for a source's files having possibly changed: a file-modifying tool or a turn of one of its sessions ended. */
  onFilesChanged(listener: (source: SourceName) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Reads a file as it is now; nothing is cached. Rejects with a `FileReadError`. */
  async read(source: FileSource, path: string): Promise<FileText> {
    try {
      const response = await api.files.content(source.projectId, path);
      const contentType = response.headers.get("content-type") || "";
      if (isTextMimeType(contentType)) return { text: await response.text(), isBinary: false };
      return { text: `Binary file (${formatSize((await response.blob()).size)})`, isBinary: true };
    } catch (error) {
      throw new FileReadError(error instanceof ReinsHttpError && error.status === 404);
    }
  }

  /** One level of a directory, `.` being the source's root. */
  async listDirectory(source: FileSource, path: string): Promise<DirectoryEntry[]> {
    return (await api.files.tree(source.projectId, path)).entries;
  }

  /** Where the browser loads a file itself (images, PDFs, downloads). */
  contentUrl(source: FileSource, path: string, { download = false } = {}): string {
    return api.files.contentUrl(source.projectId, path, { download });
  }

  dispose(): void {
    this.unsubscribe();
    for (const timer of this.pendingChanges.values()) clearTimeout(timer);
    this.pendingChanges.clear();
    this.listeners.clear();
    this.changeListeners.clear();
  }

  private filesMayHaveChanged(source: SourceName): void {
    const key = sourceKey(source);
    if (this.pendingChanges.has(key)) return;
    this.pendingChanges.set(key, setTimeout(() => {
      this.pendingChanges.delete(key);
      const listing = this.listings.get(key);
      if (listing?.source.available) this.load(listing);
      for (const listener of this.changeListeners) listener(source);
    }, SETTLE_MS));
  }

  private load(listing: Listing): void {
    const request = ++listing.request;
    listing.state = listing.state.asLoading();
    api.files.list(listing.source.projectId).then(
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
