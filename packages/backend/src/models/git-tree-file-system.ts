import { basename } from "node:path";
import type { Git } from "../git.js";
import { isNodeUnavailable } from "../errors.js";
import { detectMimeTypeFromBytes } from "../mime.js";
import {
  fileKind,
  normalizeWorkspaceFilePath,
  WorkspaceFileNotFoundError,
  type FileSystem,
  type WorkspaceFile,
} from "./file-system.js";

export class GitTreeFileSystem implements FileSystem {
  constructor(
    private readonly root: string,
    private readonly git: Git,
    private readonly ref: string,
  ) {}

  async openFile(filePath: string): Promise<WorkspaceFile> {
    const relativePath = normalizeWorkspaceFilePath(this.root, filePath);
    try {
      const { objectId, size } = await this.git.getGitBlobInfo(this.ref, relativePath);
      const prefix = await this.git.readGitBlobPrefix(objectId);
      const mimeType = await detectMimeTypeFromBytes(prefix);
      return {
        filename: basename(relativePath),
        mimeType,
        size,
        kind: fileKind(mimeType, size),
        openBody: () => this.git.streamGitBlob(objectId),
      };
    } catch (error) {
      if (isNodeUnavailable(error)) throw error;
      throw new WorkspaceFileNotFoundError("File not found in ref");
    }
  }
}
