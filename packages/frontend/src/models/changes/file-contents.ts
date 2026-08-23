import type { FileContents } from "@pierre/diffs";
import type { ReviewItem } from "./review-items.js";
import { extractFile, reversePatch } from "./patch.js";

const SIZE_LIMIT = 1_048_576;
const TEXT_APPLICATION_TYPES = new Set([
  "application/json", "application/javascript", "application/typescript", "application/xml",
  "application/yaml", "application/toml", "application/x-sh", "application/x-shellscript",
  "application/x-ruby", "application/x-python", "application/x-perl", "application/x-php",
  "application/x-awk", "application/x-lua", "application/x-makefile", "application/x-httpd-php",
]);

export interface ExpansionScope {
  projectId: number;
  mode: "branch" | "uncommitted";
  branch?: string | null;
}

export type ExpansionUnsupported =
  | { reason: "binary" }
  | { reason: "too_large"; limitBytes: number };

export interface FilePair {
  oldFile: FileContents;
  newFile: FileContents;
}

export type FetchResponse = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class UnsupportedFileContents extends Error {
  constructor(readonly unsupported: ExpansionUnsupported) {
    super(unsupported.reason);
  }
}

export async function loadFileContents(
  item: ReviewItem,
  scope: ExpansionScope,
  fetchResponse: FetchResponse,
): Promise<FilePair> {
  const oldName = item.oldPath ?? item.path;
  const oldKey = `review-expansion:${item.contentKey}:old`;
  const newKey = `review-expansion:${item.contentKey}:new`;

  if (item.status === "new" || item.status === "deleted") {
    return {
      oldFile: { name: oldName, contents: extractFile(item.filePatch, "old"), cacheKey: oldKey },
      newFile: { name: item.path, contents: extractFile(item.filePatch, "new"), cacheKey: newKey },
    };
  }

  const params = new URLSearchParams({ path: item.path });
  if (scope.branch) params.set("ref", scope.branch);
  const response = await fetchResponse(`/api/projects/${scope.projectId}/files/content?${params}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const newContents = await readText(response);
  const oldContents = reversePatch(item.filePatch, newContents);
  return {
    oldFile: { name: oldName, contents: oldContents, cacheKey: oldKey },
    newFile: { name: item.path, contents: newContents, cacheKey: newKey },
  };
}

async function readText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > SIZE_LIMIT) {
    throw new UnsupportedFileContents({ reason: "too_large", limitBytes: SIZE_LIMIT });
  }
  if (response.headers.get("X-Reins-Content-Kind") === "binary-placeholder") {
    throw new UnsupportedFileContents({ reason: "binary" });
  }
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && !contentType.startsWith("text/") && !TEXT_APPLICATION_TYPES.has(contentType)) {
    throw new UnsupportedFileContents({ reason: "binary" });
  }

  const bytes = await readBody(response);
  if (bytes.includes(0)) throw new UnsupportedFileContents({ reason: "binary" });
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UnsupportedFileContents({ reason: "binary" });
  }
}

async function readBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > SIZE_LIMIT) {
        throw new UnsupportedFileContents({ reason: "too_large", limitBytes: SIZE_LIMIT });
      }
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
