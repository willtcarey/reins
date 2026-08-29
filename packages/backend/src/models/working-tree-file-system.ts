import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { detectMimeTypeFromFile } from "../mime.js";
import {
  normalizeWorkspaceFilePath,
  WorkspaceFileNotFoundError,
  type FileSystem,
  type WorkspaceFile,
} from "./file-system.js";

export class WorkingTreeFileSystem implements FileSystem {
  constructor(private readonly projectDir: string) {}

  async openFile(filePath: string): Promise<WorkspaceFile> {
    const relativePath = normalizeWorkspaceFilePath(this.projectDir, filePath);
    const absolutePath = join(this.projectDir, relativePath);

    let fileStats;
    try {
      fileStats = await stat(absolutePath);
    } catch {
      throw new WorkspaceFileNotFoundError();
    }
    if (!fileStats.isFile()) throw new WorkspaceFileNotFoundError();

    return {
      filename: basename(relativePath),
      mimeType: await detectMimeTypeFromFile(absolutePath),
      size: fileStats.size,
      openBody: () => Bun.file(absolutePath),
    };
  }
}
