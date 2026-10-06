import { isAbsolute, relative, resolve } from "node:path";

export class InvalidWorkspacePathError extends Error {}
export class WorkspaceFileNotFoundError extends Error {}

export interface WorkspaceFile {
  filename: string;
  mimeType: string;
  size: number;
  openBody: () => ReadableStream<Uint8Array>;
}

/** Reads one file of a checkout (`path` relative to it): its size, and its bytes (the first `maxBytes`). */
export type ReadFile = (path: string, options?: { maxBytes?: number }) => Promise<{ size: number; body: ReadableStream<Uint8Array> }>;

export interface FileSystem {
  openFile(filePath: string): Promise<WorkspaceFile>;
}

/** `filePath` relative to the checkout at `root`, refusing one outside it (lexically: the node checks again). */
export function normalizeWorkspaceFilePath(root: string, filePath: string): string {
  const absolutePath = resolve(root, filePath);
  const relativePath = relative(root, absolutePath);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith("../")
    || isAbsolute(relativePath)
  ) {
    throw new InvalidWorkspacePathError("Path traversal not allowed");
  }
  return relativePath;
}
