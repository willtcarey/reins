import { isAbsolute, relative, resolve } from "node:path";

export class InvalidWorkspacePathError extends Error {}
export class WorkspaceFileNotFoundError extends Error {}

/** How a file is shown: as text, previewed by the browser itself (images, PDFs), or not at all: a binary
 * file is only downloaded. */
export type FileKind = "text" | "preview" | "binary";

export interface WorkspaceFile {
  filename: string;
  mimeType: string;
  size: number;
  kind: FileKind;
  openBody: () => ReadableStream<Uint8Array>;
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

/** An empty file is text: there is nothing to preview or download. */
export function fileKind(mimeType: string, size: number): FileKind {
  if (size === 0 || mimeType.startsWith("text/") || TEXT_APPLICATION_TYPES.has(mimeType)) return "text";
  if (mimeType.startsWith("image/") || mimeType === "application/pdf") return "preview";
  return "binary";
}

/** Reads one file of a checkout (`path` relative to it): its size, and its bytes (the first `maxBytes`).
 * Throws `WorkspaceFileNotFoundError` for anything but a file. */
export type ReadFile = (path: string, options?: { maxBytes?: number }) => Promise<{ size: number; body: ReadableStream<Uint8Array> }>;

export interface FileSystem {
  openFile(filePath: string): Promise<WorkspaceFile>;
}

/** `filePath` relative to the checkout at `root`, refusing one outside it (lexically: the node confines nothing). */
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
