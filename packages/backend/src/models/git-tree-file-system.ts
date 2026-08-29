import { basename } from "node:path";
import {
  getGitBlobInfo,
  readGitBlobPrefix,
  streamGitBlob,
} from "../git.js";
import { detectMimeTypeFromBytes } from "../mime.js";
import {
  normalizeWorkspaceFilePath,
  WorkspaceFileNotFoundError,
  type FileSystem,
  type WorkspaceFile,
} from "./file-system.js";

export class GitTreeFileSystem implements FileSystem {
  constructor(
    private readonly projectDir: string,
    private readonly ref: string,
  ) {}

  async openFile(filePath: string): Promise<WorkspaceFile> {
    const relativePath = normalizeWorkspaceFilePath(this.projectDir, filePath);
    try {
      const { objectId, size } = await getGitBlobInfo(this.projectDir, this.ref, relativePath);
      const prefix = await readGitBlobPrefix(this.projectDir, objectId);
      return {
        filename: basename(relativePath),
        mimeType: await detectMimeTypeFromBytes(prefix),
        size,
        openBody: () => streamGitBlob(this.projectDir, objectId),
      };
    } catch {
      throw new WorkspaceFileNotFoundError("File not found in ref");
    }
  }
}
