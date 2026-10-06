import { basename } from "node:path";
import { nodeRefusal } from "../errors.js";
import { detectMimeTypeFromBytes } from "../mime.js";
import {
  InvalidWorkspacePathError,
  normalizeWorkspaceFilePath,
  WorkspaceFileNotFoundError,
  type FileSystem,
  type ReadFile,
  type WorkspaceFile,
} from "./file-system.js";

/** Bytes read to detect a file's MIME type. */
const MIME_SNIFF_BYTES = 8192;

/** The checkout's working tree, read through its node (`fs.read`). */
export class WorkingTreeFileSystem implements FileSystem {
  constructor(
    private readonly root: string,
    private readonly read: ReadFile,
  ) {}

  async openFile(filePath: string): Promise<WorkspaceFile> {
    const relativePath = normalizeWorkspaceFilePath(this.root, filePath);
    const { size, body } = await this.open(relativePath, MIME_SNIFF_BYTES);
    const prefix = new Uint8Array(await new Response(body).arrayBuffer());
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    return {
      filename: basename(relativePath),
      mimeType: await detectMimeTypeFromBytes(prefix),
      size,
      // Opened only if the caller sends the content.
      openBody: () => new ReadableStream<Uint8Array>({
        start: async () => { reader = (await this.open(relativePath)).body.getReader(); },
        async pull(controller) {
          const next = await reader!.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        async cancel() { await reader?.cancel().catch(() => undefined); },
      }),
    };
  }

  /** The node's refusals in the workspace's terms. */
  private async open(path: string, maxBytes?: number) {
    try {
      return await this.read(path, maxBytes ? { maxBytes } : {});
    } catch (error) {
      const refusal = nodeRefusal(error);
      if (refusal?.code === "not_found") throw new WorkspaceFileNotFoundError();
      if (refusal?.code === "invalid_request") throw new InvalidWorkspacePathError(refusal.message);
      throw error;
    }
  }
}
