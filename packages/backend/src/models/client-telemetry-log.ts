import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const CLIENT_TELEMETRY_LOG_PATH = join(tmpdir(), "reins-client-telemetry.jsonl");
export const CLIENT_TELEMETRY_MAX_FILE_BYTES = 1024 * 1024;
export const CLIENT_TELEMETRY_MAX_FILES = 4;

interface BoundedJsonlLogOptions {
  path?: string;
  maxFileBytes?: number;
  maxFiles?: number;
}

/** A serialized JSONL writer with a hard size and file-count bound. */
export class BoundedJsonlLog {
  public readonly path: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: BoundedJsonlLogOptions = {}) {
    this.path = options.path ?? CLIENT_TELEMETRY_LOG_PATH;
    this.maxFileBytes = options.maxFileBytes ?? CLIENT_TELEMETRY_MAX_FILE_BYTES;
    this.maxFiles = options.maxFiles ?? CLIENT_TELEMETRY_MAX_FILES;
  }

  public append(records: readonly unknown[]): Promise<void> {
    const write = this.pending.then(() => this.appendNow(records));
    this.pending = write.catch(() => {});
    return write;
  }

  private async appendNow(records: readonly unknown[]) {
    await mkdir(dirname(this.path), { recursive: true });
    let currentSize = await fileSize(this.path);

    for (const record of records) {
      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > this.maxFileBytes) throw new Error("Telemetry record exceeds file size limit");
      if (currentSize > 0 && currentSize + lineBytes > this.maxFileBytes) {
        await this.rotate();
        currentSize = 0;
      }
      await appendFile(this.path, line, "utf8");
      currentSize += lineBytes;
    }
  }

  private async rotate() {
    if (this.maxFiles <= 1) {
      await removeIfPresent(this.path);
      return;
    }

    await removeIfPresent(`${this.path}.${this.maxFiles - 1}`);
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      await renameIfPresent(`${this.path}.${index}`, `${this.path}.${index + 1}`);
    }
    await renameIfPresent(this.path, `${this.path}.1`);
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

async function removeIfPresent(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function renameIfPresent(from: string, to: string) {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
