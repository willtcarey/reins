/**
 * Source Model
 *
 * A source is a location: a path on one node, where sessions work (ADR-034). It belongs to no project: any
 * session may use it, and a project has one as its default source. This model owns its record (made on first use,
 * `ensureSource`; resolving which one a call works in) and what reads or changes that checkout, run on
 * its node: its git (`Git` on `NodeDirClient.spawner`), listing (`fs.list`), reading (`fs.read`) and writing
 * (`fs.write`) files, diffs (`Workspace`) and the skills of its checkout (discovered through `fs.*`). The
 * git logic stays in `Git`, the transport in `NodeClient`: node failures reach callers as they are (an
 * unreachable node is a 503 at the router), and only failures with a meaning here become domain errors.
 * The node confines nothing to the checkout (ADR-029): what a browser names is confined here.
 */

import { basename, isAbsolute, join, normalize, relative, resolve } from "path";
import { nodeResources, type Skill } from "../session-runtime/resources.js";
import { NodeDirClient, NodeFileError } from "../nodes/node-dir-client.js";
import { PiNodeEnv } from "../nodes/pi-node-env.js";
import { logger } from "../logger.js";
import { Git } from "../git.js";
import { findSource, getNode, getSource, defaultSource, upsertSource, type Source } from "../node-store.js";
import type { NodeHub } from "../state.js";
import { NodeNotFoundError, type Nodes } from "./nodes.js";
import { Workspace } from "./workspace.js";
import { WorkspaceFileNotFoundError, type ReadFile, type WorkspaceFile } from "./file-system.js";

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
/** A skill as suggestions list it (`GET /api/nodes/:nodeId/skills`). */
export interface SkillInfo { name: string; description: string }
const skillInfos = (skills: readonly Skill[]): SkillInfo[] => skills.map(({ name, description }) => ({ name, description }));

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Source `sourceId`; throws `SourceNotFoundError`. Resolve it where the call enters (route middleware, tool
 * scope), not inside models. */
export function resolveSource(sourceId: number): Source {
  const source = getSource(sourceId);
  if (!source) throw new SourceNotFoundError();
  return source;
}

/** The project's default source: where it was created, the default of a session with nothing better to
 * inherit, and the checkout of project operations no session makes (task lists' diff stats, deleting a
 * task's branch). A default, not a limit: any session may work elsewhere. Throws `SourceNotFoundError`. */
export function defaultSourceOf(projectId: number): Source {
  const source = defaultSource(projectId);
  if (!source) throw new SourceNotFoundError("Project has no default source");
  return source;
}

/** A path as sources keep it: absolute, normalized, without a trailing slash, so one directory is one row. */
function sourcePath(path: string): string {
  const trimmed = path.trim();
  // A relative path would be resolved against wherever the node runs.
  if (!isAbsolute(trimmed)) throw new CheckoutNotFoundError(`A source's path must be absolute: ${trimmed}`);
  const normalized = normalize(trimmed);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

/**
 * The source of `path` on node `nodeId`, made the first time a session, a move or a project names it. A
 * known one is returned without contacting its node, so a known location on an offline node can still be
 * chosen (its work then waits for the node). A new one needs an absolute path, a node that is not removed,
 * and that node confirming a directory there (`fs.list`). The server's sources are the only record of a
 * node's directories: the node keeps none and works in the path it is sent (ADR-026). Throws `NodeNotFoundError` (also for a removed node),
 * `CheckoutNotFoundError`, or the node's failure when it is unreachable.
 */
export async function ensureSource(nodeId: string, path: string, nodes: Nodes): Promise<SourceModel> {
  const normalized = sourcePath(path);
  const known = findSource(nodeId, normalized);
  if (known) return new SourceModel(nodes.hub, known);
  const node = getNode(nodeId);
  // A removed node is no longer offered: it holds no new sources.
  if (!node || node.removedAt) throw new NodeNotFoundError(nodeId);
  await new SourceModel(nodes.hub, { id: 0, node_id: nodeId, path: normalized }).assertCheckoutExists();
  return new SourceModel(nodes.hub, upsertSource(nodeId, normalized));
}

/**
 * The skills a session working in `path` on node `nodeId` can invoke, for `/name` suggestions (`listSkills`):
 * a directory no session works in yet too, without keeping a source for it. Throws `NodeNotFoundError`
 * (also for a removed node) and `CheckoutNotFoundError` for a relative path.
 */
export async function skillsAt(nodeId: string, path: string, nodes: Nodes): Promise<{ skills: SkillInfo[]; available: boolean }> {
  return sourceAt(nodeId, path, nodes).listSkills();
}

/**
 * The directory `path` on node `nodeId`, to read or write its files (the node file routes): a known source,
 * or one no session works in, without keeping a record of it or contacting the node. Throws
 * `NodeNotFoundError` (also for a removed node) and `CheckoutNotFoundError` for a relative path.
 */
export function sourceAt(nodeId: string, path: string, nodes: Pick<Nodes, "hub">): SourceModel {
  const normalized = sourcePath(path);
  const node = getNode(nodeId);
  if (!node || node.removedAt) throw new NodeNotFoundError(nodeId);
  return new SourceModel(nodes.hub, findSource(nodeId, normalized) ?? { id: 0, node_id: nodeId, path: normalized });
}

// ---------------------------------------------------------------------------
// SourceModel
// ---------------------------------------------------------------------------

export class SourceModel {
  /** The checkout's git, run on its node. With that node unreachable every command rejects (an
   * `RpcFailure` with code `"unavailable"`, which the router answers 503). */
  readonly git: Git;
  /** Does not wait for the node: its callers answer now (an unreachable node is a 503 at the router). */
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

  /** A working-tree file of the checkout, or the file at git `ref`. */
  openFile(path: string, ref?: string | null): Promise<WorkspaceFile> {
    // The base branch only matters to diffs.
    return this.workspace("HEAD").openFile(path, ref);
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

  /** Streams `data`, so an upload is never held whole. */
  private async writeFile(path: string, data: Blob): Promise<void> {
    const file = withinCheckout(this.path, path);
    if (file === null) throw new FileWriteRefusedError(`Path traversal not allowed: ${path}`);
    if (file === resolve(this.path)) throw new FileWriteRefusedError(`Not a file path: ${path}`);
    try {
      await this.checkout.writeFileFrom(file, data.stream());
    } catch (error) {
      throw error instanceof NodeFileError ? new FileWriteRefusedError(`Cannot write ${path}: ${error.message}`) : error;
    }
  }
}
