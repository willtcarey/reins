/**
 * Source Model
 *
 * A source is one checkout of a project: a path on one node. This model owns its record (creating one,
 * moving its path, resolving which one a call works in) and what reads or changes that checkout, run on
 * its node: its git (`Git` on `RemoteNode.spawn`), listing (`fs.list`) and reading (`fs.read`) files,
 * diffs (`Workspace`) and skills (`skills.list`). The git logic stays in `Git`, the transport in
 * `RemoteNode`: node failures reach callers as they are (an unreachable node is a 503 at the router), and
 * only refusals with a meaning here become domain errors.
 */

import { basename, join } from "path";
import { ATTACHMENT_CHUNK_BYTES, type DirectoryEntry, type SkillInfo } from "@reins/node-protocol";
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
import type { NodeHub } from "../state.js";
import { nodeRefusal } from "../errors.js";
import { Workspace } from "./workspace.js";
import type { ReadFile } from "./file-system.js";

export type { DirectoryEntry };

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

export class SourceNotFoundError extends Error {
  constructor(message = "Source not found") { super(message); }
}

export class NodeNotFoundError extends Error {
  constructor(message = "Node not found") { super(message); }
}

/** A source's path is not a directory on its node. */
export class CheckoutNotFoundError extends Error {}

/** Another source (of any project) already is that checkout: a checkout belongs to one project. */
export class DuplicateSourceError extends Error {
  constructor(message = "That checkout already belongs to a project") { super(message); }
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

/** The node refused to write a file there (outside the checkout, a directory, a path through a file). */
export class FileWriteRefusedError extends Error {}

/** Bound on the node answering `fs.list` or an `fs.write` chunk, or opening an `fs.read`. */
const FS_REQUEST_TIMEOUT_MS = 10_000;
/** Bound on the node answering `skills.list`: suggestions are not worth a longer wait. */
const SKILLS_TIMEOUT_MS = 5_000;

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

/** A source as the project edit form shows it. */
export interface SourceView {
  id: number;
  nodeId: string;
  nodeName: string;
  /** Whether its node is connected now. */
  connected: boolean;
  path: string;
}

/** The project's sources, its default one first. */
export function listProjectSources(projectId: number, nodes: Pick<NodeHub, "get">): SourceView[] {
  return listSources(projectId).map((source) => ({
    id: source.id,
    nodeId: source.node_id,
    nodeName: getNode(source.node_id)?.name ?? source.node_id,
    connected: nodes.get(source.node_id).connected,
    path: source.path,
  }));
}

/**
 * Creates a source of the project: the checkout at `path` on node `nodeId`, kept only once that node
 * confirms the path is a directory. Throws `NodeNotFoundError`, `DuplicateSourceError`,
 * `CheckoutNotFoundError`, or the node's failure when it is unreachable.
 */
export async function createSource(projectId: number, nodeId: string, path: string, nodes: Pick<NodeHub, "get">): Promise<SourceModel> {
  if (!getNode(nodeId)) throw new NodeNotFoundError();
  let record: Source;
  try {
    record = storeCreateSource(projectId, nodeId, path);
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateSourceError();
    throw error;
  }
  const source = new SourceModel(nodes, record);
  try {
    await source.assertCheckoutExists();
  } catch (error) {
    deleteSource(record.id);
    throw error;
  }
  return source;
}

/**
 * Moves one of the project's sources to another path on its node, once the node confirms it is a
 * directory. Throws `SourceNotFoundError`, `DuplicateSourceError`, `CheckoutNotFoundError`, or the node's
 * failure when it is unreachable.
 */
export async function moveSource(projectId: number, sourceId: number, path: string, nodes: Pick<NodeHub, "get">): Promise<Source> {
  const current = resolveSource(projectId, sourceId);
  await new SourceModel(nodes, { ...current, path }).assertCheckoutExists();
  try {
    return updateSourcePath(sourceId, path) ?? current;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateSourceError();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// SourceModel
// ---------------------------------------------------------------------------

export class SourceModel {
  /** The checkout's git, run on its node. With that node unreachable every command rejects (an
   * `RpcFailure` with code `"unavailable"`, which the router answers 503). */
  readonly git: Git;

  constructor(
    private readonly nodes: Pick<NodeHub, "get">,
    readonly record: Source,
  ) {
    const node = nodes.get(record.node_id);
    this.git = new Git((argv, options) => node.spawn(argv, { ...options, sourceId: record.id, cwd: record.path }));
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
    const { id: sourceId, node_id: nodeId, path: cwd } = this.record;
    const node = this.nodes.get(nodeId);
    const read: ReadFile = async (path, { maxBytes } = {}) => {
      const input = { sourceId, cwd, path, ...(maxBytes ? { maxBytes } : {}) };
      const { result: { size }, body } = await node.openStream("fs.read", input, { timeoutMs: FS_REQUEST_TIMEOUT_MS });
      return { size, body };
    };
    return new Workspace(cwd, baseBranch, this.git, read);
  }

  /** Fetch from origin and fast-forward the base branch, in this checkout. */
  async sync(baseBranch: string): Promise<void> {
    await this.git.fetchAll();
    await this.git.fastForwardBaseBranch(baseBranch);
  }

  /** The skills the node finds in this checkout (`skills.list`). */
  async listSkills(): Promise<SkillInfo[]> {
    const { id: sourceId, node_id: nodeId, path: cwd } = this.record;
    return (await this.nodes.get(nodeId).request("skills.list", { sourceId, cwd }, { timeoutMs: SKILLS_TIMEOUT_MS })).skills;
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
   * Read one level of a directory, returning typed entries sorted
   * with directories first, then files, alphabetical within each group.
   */
  async listDirectory(subPath = "."): Promise<DirectoryEntry[]> {
    const { id: sourceId, node_id: nodeId, path: cwd } = this.record;
    try {
      const { entries } = await this.nodes.get(nodeId).request(
        "fs.list",
        { sourceId, cwd, path: subPath },
        { timeoutMs: FS_REQUEST_TIMEOUT_MS },
      );
      return entries;
    } catch (error) {
      // The node's refusals, in the file browser's terms.
      const refusal = nodeRefusal(error);
      if (refusal?.code === "invalid_request") throw new PathTraversalError(refusal.message);
      if (refusal?.code === "not_found") throw new FileNotFoundError(refusal.message);
      throw error;
    }
  }

  // ---- File uploads --------------------------------------------------------

  /**
   * Write one or more files into the checkout, on its node (`fs.write`, in chunks that each fit a
   * frame). The node checks each path against the checkout and keeps a file's bytes beside it until the
   * last chunk, so a partly written file is never seen at its path.
   *
   * Each file's name is sanitized to its basename. An optional `subPath` places files in a
   * subdirectory (intermediate directories are created on the node).
   *
   * Throws `NoFilesError` if the array is empty, `InvalidFilenameError` for degenerate names, and
   * `FileWriteRefusedError` when the node refuses a path (outside the checkout, a directory, a path
   * through a file).
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
    const { id: sourceId, node_id: nodeId, path: cwd } = this.record;
    const node = this.nodes.get(nodeId);
    let offset = 0;
    for (;;) {
      const chunk = new Uint8Array(await data.slice(offset, offset + ATTACHMENT_CHUNK_BYTES).arrayBuffer());
      const last = offset + chunk.byteLength >= data.size;
      const input = { sourceId, cwd, path, offset, data: Buffer.from(chunk).toString("base64"), last };
      try {
        await node.request("fs.write", input, { timeoutMs: FS_REQUEST_TIMEOUT_MS });
      } catch (error) {
        const refusal = nodeRefusal(error);
        if (refusal?.code === "invalid_request") throw new FileWriteRefusedError(refusal.message);
        throw error;
      }
      if (last) return;
      offset += chunk.byteLength;
    }
  }
}
