import { isAbsolute, relative, resolve } from "node:path";

export class InvalidWorkspacePathError extends Error {}
export class WorkspaceFileNotFoundError extends Error {}

export interface WorkspaceFile {
  filename: string;
  mimeType: string;
  size: number;
  openBody: () => Blob | ReadableStream<Uint8Array>;
}

export interface FileSystem {
  openFile(filePath: string): Promise<WorkspaceFile>;
}

export function normalizeWorkspaceFilePath(projectDir: string, filePath: string): string {
  const absolutePath = resolve(projectDir, filePath);
  const relativePath = relative(projectDir, absolutePath);
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
