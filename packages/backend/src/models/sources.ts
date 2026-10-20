/**
 * Source Model
 *
 * A source is one checkout of a project: a path on one node. This model owns its record (creating one,
 * moving its path, resolving which one a call works in) and what reads or changes that checkout, run on
 * its node: its git (`Git` on `NodeDirClient.spawner`), listing (`fs.list`), reading (`fs.read`) and writing
 * (`fs.write`) files, diffs (`Workspace`) and the skills of its checkout (discovered through `fs.*`). The
 * git logic stays in `Git`, the transport in `NodeClient`: node failures reach callers as they are (an
 * unreachable node is a 503 at the router), and only failures with a meaning here become domain errors.
 * The node confines nothing to the checkout (ADR-029): what a browser names is confined here.
 */

import { basename, isAbsolute, join, relative, resolve } from "path";
import { nodeResources, type Skill } from "../session-runtime/resources.js";
import { NodeDirClient, NodeFileError } from "../nodes/node-dir-client.js";
import { PiNodeEnv } from "../nodes/pi-node-env.js";
import { logger } from "../logger.js";
import { Git } from "../git.js";
import {
  createSource as storeCreateSource,
  defaultSource,
  deleteSource,
  getNode,
  getSource,
  listSources,
  updateSourcePath,
  type Source,
} from "../node-store.js";
import type { SessionRow } from "../session-store.js";
import type { NodeHub } from "../state.js";
import { NodeNotFoundError, type Nodes } from "./nodes.js";
import { Workspace } from "./workspace.js";
import { WorkspaceFileNotFoundError, type ReadFile } from "./file-system.js";

/** One entry of a checkout's directory, as the file browser lists it. */
export interface DirectoryEntry { name: string; type: "file" | "directory" }

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

export class SourceNotFoundError extends Error {
  constructor(message = "Source not found") { super(message); }
}

/** A source's path is not a directory on its node. */
export class CheckoutNotFoundError extends Error {}

/** Another source (of any project) already has that node and path: a checkout belongs to one project. Or
 * the project already has a source on that node: a session moved to a node works in its project's source
 * there, so a project has at most one per node. */
export class DuplicateSourceError extends Error {
  constructor(message = "That path is already a source of another project") { super(message); }
}

export class PathTraversalError extends Error {
  constructor(message = "Path traversal not allowed") { super(message); }
}

export class FileNotFoundError extends Error {
  constructor(message = "File not found") { super(message); }
}

export class NoFilesError extends Error {
  constructor(message = "No files provided") { super(message); }
}

export class InvalidFilenameError extends Error {
  constructor(message = "Invalid filename") { super(message); }
}

/** A file cannot be written there (outside the checkout, a directory, a path through a file). */
export class FileWriteRefusedError extends Error {}

/** Bound on discovering the node's skills for skill suggestions: not worth a longer wait. */
const SKILLS_TIMEOUT_MS = 5_000;

/** `path` resolved against the checkout `cwd`, or null when it leaves it (lexically). */
function withinCheckout(cwd: string, path: string): string | null {
  const resolved = resolve(cwd, path);
  const fromRoot = relative(cwd, resolved);
  return fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot) ? null : resolved;
}
/** A skill as suggestions list it (`GET /api/projects/:id/skills`). */
export interface SkillInfo { name: string; description: string }
const skillInfos = (skills: readonly Skill[]): SkillInfo[] => skills.map(({ name, description }) => ({ name, description }));

const isUniqueViolation = (error: unknown) => error instanceof Error && error.message.includes("UNIQUE constraint");

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * The source a call works in: the one the caller names (a request's `sourceId`, a calling session's
 * source), which must belong to the project, or else the project's default source. Resolve it where the
 * call enters (route middleware, tool scope), not inside models.
 */
export function resolveSource(projectId: number, sourceId?: number | null): Source {
  if (sourceId == null) {
    const source = defaultSource(projectId);
    if (!source) throw new SourceNotFoundError("Project has no source");
    return source;
  }
  const source = getSource(sourceId);
  if (!source || source.project_id !== projectId) throw new SourceNotFoundError();
  return source;
}

/** The session's source (`resolveSource` of its row), or null when it is gone or belongs to another
 * project. Where the session's commands go: to that source's node. */
export function sessionSource(row: Pick<SessionRow, "source_id" | "project_id">): Source | null {
  try {
    return resolveSource(row.project_id, row.source_id);
  } catch (error) {
    if (error instanceof SourceNotFoundError) return null;
    throw error;
  }
}

/** A source as the project edit form shows it. */
export interface SourceView {
  id: number;
  nodeId: string;
  nodeName: string;
  /** Whether its node is connected now. */
  connected: boolean;
  /** Whether its node was revoked: it may not connect, so the path cannot be checked there. */
  revoked: boolean;
  path: string;
}

/** The project's sources, its default one first. Those on a removed node are left out: that node is gone
 * for good, so there is nothing to edit there (its sessions stay, and move to another node's source). */
export function listProjectSources(projectId: number, nodes: Pick<NodeHub, "get">): SourceView[] {
  return listSources(projectId).flatMap((source) => {
    const node = getNode(source.node_id);
    if (node?.removedAt) return [];
    return [{
      id: source.id,
      nodeId: source.node_id,
      nodeName: node?.name ?? source.node_id,
      connected: nodes.get(source.node_id).connected,
      revoked: !!node?.revokedAt,
      path: source.path,
    }];
  });
}

/** A checkout's path is absolute: the node works in the path it is sent, and a relative one would be
 * resolved against wherever the node runs. */
function assertAbsolute(path: string): void {
  if (!isAbsolute(path)) throw new CheckoutNotFoundError(`A source's path must be absolute: ${path}`);
}

/**
 * Creates a source of the project: the checkout at `path` on node `nodeId`, kept only once that node
 * confirms the path is a directory there. The server's sources are the only record of a node's checkouts:
 * the node keeps none and works in the path it is sent (ADR-026). Tells browsers the node's new source
 * (`Nodes.publish`). Throws `NodeNotFoundError` (also for a removed node), `DuplicateSourceError` (a
 * checkout a project has, or a second checkout of the project on the node), `CheckoutNotFoundError`, or the
 * node's failure when it is unreachable.
 */
export async function createSource(projectId: number, nodeId: string, path: string, nodes: Nodes): Promise<SourceModel> {
  const node = getNode(nodeId);
  // A removed node is no longer offered: it holds no new sources.
  if (!node || node.removedAt) throw new NodeNotFoundError(nodeId);
  assertAbsolute(path);
  if (listSources(projectId).some((source) => source.node_id === nodeId)) throw new DuplicateSourceError(`The project already has a source on ${node.name}`);
  let record: Source;
  try {
    record = storeCreateSource(projectId, nodeId, path);
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateSourceError();
    throw error;
  }
  const source = new SourceModel(nodes.hub, record);
  try {
    await source.assertCheckoutExists();
  } catch (error) {
    deleteSource(record.id);
    throw error;
  }
  nodes.publish(nodeId);
  return source;
}

/**
 * Moves one of the project's sources to another path on its node, once the node confirms it is a
 * directory there. Tells browsers. Throws `SourceNotFoundError` (also for a source on a removed node, which
 * is no longer listed), `DuplicateSourceError`,
 * `CheckoutNotFoundError`, or the node's failure when it is unreachable.
 */
export async function moveSource(projectId: number, sourceId: number, path: string, nodes: Nodes): Promise<Source> {
  const current = resolveSource(projectId, sourceId);
  if (getNode(current.node_id)?.removedAt) throw new SourceNotFoundError();
  assertAbsolute(path);
  await new SourceModel(nodes.hub, { ...current, path }).assertCheckoutExists();
  let moved: Source;
  try {
    moved = updateSourcePath(sourceId, path) ?? current;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateSourceError();
    throw error;
  }
  nodes.publish(current.node_id);
  return moved;
}

// ---------------------------------------------------------------------------
// SourceModel
// ---------------------------------------------------------------------------

export class SourceModel {
  /** The checkout's git, run on its node. With that node unreachable every command rejects (an
   * `RpcFailure` with code `"unavailable"`, which the router answers 503). */
  readonly git: Git;
  /** The checkout on its node, for a caller answering now: a node not connected fails at once and nothing
   * is sent again (`RpcFailure` `unavailable`, a 503 at the router). */
  private readonly checkout: NodeDirClient;

  constructor(
    nodes: Pick<NodeHub, "get">,
    readonly record: Source,
  ) {
    this.checkout = new NodeDirClient({ cwd: record.path, node: nodes.get(record.node_id), waitForNode: false });
    this.git = new Git(this.checkout.spawner());
  }

  get id(): number { return this.record.id; }
  /** The checkout's path on its node. */
  get path(): string { return this.record.path; }

  /** Throws `CheckoutNotFoundError` unless the path is a directory on the node. */
  async assertCheckoutExists(): Promise<void> {
    try {
      await this.listDirectory(".");
    } catch (error) {
      if (error instanceof FileNotFoundError) throw new CheckoutNotFoundError(`Directory does not exist: ${this.path}`);
      throw error;
    }
  }

  /** Files and diffs of the checkout, against `baseBranch`. */
  workspace(baseBranch: string): Workspace {
    // `path` is relative to the checkout, confined to it by the workspace's file system.
    const read: ReadFile = async (path, { maxBytes } = {}) => {
      try {
        return await this.checkout.readFileStream(path, maxBytes ? { maxBytes } : {});
      } catch (error) {
        if (error instanceof NodeFileError && ["not_found", "is_directory", "not_directory", "invalid"].includes(error.code)) throw new WorkspaceFileNotFoundError();
        throw error;
      }
    };
    return new Workspace(this.path, baseBranch, this.git, read);
  }

  /** Fetch from origin and fast-forward the base branch, in this checkout. */
  async sync(baseBranch: string): Promise<void> {
    await this.git.fetchAll();
    await this.git.fastForwardBaseBranch(baseBranch);
  }

  /**
   * The skills a session in this checkout can invoke, as its runtime discovers them (ADR-029): the
   * node's `~/.agents`, then the checkout's, through its node (within 5 s). `available` is false, with
   * no skills, when the node is not connected or does not answer in time.
   */
  async listSkills(): Promise<{ skills: SkillInfo[]; available: boolean }> {
    const { id: sourceId, node_id: nodeId } = this.record;
    try {
      const { skills } = await nodeResources(new PiNodeEnv(this.checkout, { strict: true }), { signal: AbortSignal.timeout(SKILLS_TIMEOUT_MS) });
      return { skills: skillInfos(skills), available: true };
    } catch (error) {
      logger.debug(`The skills of source ${sourceId}'s checkout are unavailable from node ${nodeId}:`, error instanceof Error ? error.message : error);
      return { skills: [], available: false };
    }
  }

  // ---- File listing ---------------------------------------------------------

  /**
   * List all non-ignored files in the checkout.
   * Combines tracked and untracked-but-not-ignored files into a
   * sorted, deduplicated list of relative paths.
   */
  async listFiles(): Promise<string[]> {
    const [tracked, untracked] = await Promise.all([
      this.git.listTrackedFiles(),
      this.git.listUntrackedFiles(),
    ]);
    return [...new Set([...tracked, ...untracked])].toSorted();
  }

  /**
   * Read one level of a directory of the checkout (`fs.list`): its files and directories (not symlinks or
   * other entries), directories first, then by name case-insensitively. Throws `PathTraversalError` for a
   * path outside the checkout and `FileNotFoundError` for one that is not a directory.
   */
  async listDirectory(subPath = "."): Promise<DirectoryEntry[]> {
    const path = withinCheckout(this.path, subPath);
    if (path === null) throw new PathTraversalError();
    let listed;
    try {
      listed = await this.checkout.listDir(path);
    } catch (error) {
      if (error instanceof NodeFileError && (error.code === "not_found" || error.code === "not_directory")) throw new FileNotFoundError("Directory not found");
      throw error;
    }
    return listed
      .flatMap((entry): DirectoryEntry[] => entry.kind === "symlink" ? [] : [{ name: entry.name, type: entry.kind }])
      .toSorted((a, b) => a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  // ---- File uploads --------------------------------------------------------

  /**
   * Write one or more files into the checkout, on its node (`fs.write`, in chunks that each fit a
   * frame). The node keeps a file's chunks in its data directory until the last, so a partly written
   * file is never seen at its path.
   *
   * Each file's name is sanitized to its basename. An optional `subPath` places files in a
   * subdirectory (intermediate directories are created on the node).
   *
   * Throws `NoFilesError` if the array is empty, `InvalidFilenameError` for degenerate names, and
   * `FileWriteRefusedError` for a path outside the checkout or one the node cannot write (a directory, a
   * path through a file).
   *
   * Returns the list of relative paths (from the checkout root) that were written.
   */
  async writeFiles(
    files: { name: string; data: Blob }[],
    subPath = "",
  ): Promise<{ uploaded: string[] }> {
    if (files.length === 0) throw new NoFilesError();

    const uploaded: string[] = [];
    for (const file of files) {
      const safeName = basename(file.name);
      if (!safeName || safeName === "." || safeName === "..") {
        throw new InvalidFilenameError(`Invalid filename: ${file.name}`);
      }
      const path = subPath ? join(subPath, safeName) : safeName;
      await this.writeFile(path, file.data);
      uploaded.push(path);
    }
    return { uploaded };
  }

  /** Sends `data` to `path` in the checkout, one `fs.write` chunk at a time (an empty file is one). */
  private async writeFile(path: string, data: Blob): Promise<void> {
    const file = withinCheckout(this.path, path);
    if (file === null) throw new FileWriteRefusedError(`Path traversal not allowed: ${path}`);
    if (file === resolve(this.path)) throw new FileWriteRefusedError(`Not a file path: ${path}`);
    try {
      await this.checkout.writeFile(file, new Uint8Array(await data.arrayBuffer()));
    } catch (error) {
      throw error instanceof NodeFileError ? new FileWriteRefusedError(`Cannot write ${path}: ${error.message}`) : error;
    }
  }
}
