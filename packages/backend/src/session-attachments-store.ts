import { createHash, randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import type {
  ClientPromptContent,
  HydratedPromptContent,
  ImageAttachmentBlock,
  InlineImageBlock,
  PersistedContentBlock,
  TextContentBlock,
} from "./messages-store.js";

type TextPromptBlock = TextContentBlock;

interface ImageSizeHint {
  width: number;
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeImageSizeHint(width: unknown, height: unknown): ImageSizeHint | null {
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

function hasValidOptionalImageSize(value: Record<string, unknown>): boolean {
  if (value.width === undefined && value.height === undefined) return true;
  return normalizeImageSizeHint(value.width, value.height) !== null;
}

function isImageAttachmentBlock(value: unknown): value is ImageAttachmentBlock {
  return isRecord(value)
    && value.type === "image"
    && typeof value.attachmentId === "string"
    && typeof value.mimeType === "string"
    && ALLOWED_IMAGE_MIME_TYPES.has(value.mimeType)
    && typeof value.byteSize === "number"
    && Number.isFinite(value.byteSize)
    && value.byteSize >= 0
    && (value.filename === undefined || typeof value.filename === "string")
    && (value.sha256 === undefined || typeof value.sha256 === "string")
    && hasValidOptionalImageSize(value);
}

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface StoreSessionAttachmentInput {
  data: Uint8Array | Buffer;
  mimeType: string;
  filename?: string;
  width?: number;
  height?: number;
}

export interface SessionAttachmentInfo {
  id: string;
  kind: "image";
  mimeType: string;
  filename?: string;
  byteSize: number;
  sha256: string;
  url: string;
  width?: number;
  height?: number;
}

export interface SessionAttachmentRow {
  id: string;
  session_id: string;
  kind: "image";
  mime_type: string;
  filename: string | null;
  byte_size: number;
  sha256: string;
  data: Buffer | null;
  width: number | null;
  height: number | null;
  created_at: string;
  pruned_at: string | null;
}

function normalizeBytes(data: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function normalizeRow(row: SessionAttachmentRow): SessionAttachmentRow {
  return row.data && !Buffer.isBuffer(row.data)
    ? { ...row, data: Buffer.from(row.data) }
    : row;
}

function toInfo(row: SessionAttachmentRow): SessionAttachmentInfo {
  const hint = normalizeImageSizeHint(row.width, row.height);
  return {
    id: row.id,
    kind: "image",
    mimeType: row.mime_type,
    filename: row.filename ?? undefined,
    byteSize: row.byte_size,
    sha256: row.sha256,
    url: attachmentUrl(row.session_id, row.id),
    ...(hint ? { width: hint.width, height: hint.height } : {}),
  };
}

export function attachmentUrl(sessionId: string, attachmentId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

function parseTextPromptBlock(value: Record<string, unknown>, index: number): TextPromptBlock {
  if (value.type !== "text" || typeof value.text !== "string") {
    throw new Error(`block ${index} must include string text`);
  }
  return { type: "text", text: value.text };
}

function parseImageAttachmentBlock(value: Record<string, unknown>, index: number): ImageAttachmentBlock {
  if (!isImageAttachmentBlock(value)) {
    throw new Error(`block ${index} must be a valid image attachment ref`);
  }
  const hint = normalizeImageSizeHint(value.width, value.height);
  return {
    type: "image",
    attachmentId: value.attachmentId,
    mimeType: value.mimeType,
    filename: value.filename,
    byteSize: value.byteSize,
    sha256: value.sha256,
    ...(hint ? { width: hint.width, height: hint.height } : {}),
  };
}

export function parseClientPromptContent(value: unknown): ClientPromptContent {
  if (!Array.isArray(value)) throw new Error("expected content blocks array");

  return value.map((block, index) => {
    if (!isRecord(block)) throw new Error(`block ${index} must be an object`);
    if (block.type === "text") return parseTextPromptBlock(block, index);
    if (block.type === "image") return parseImageAttachmentBlock(block, index);
    throw new Error(`block ${index} must be text or image`);
  });
}

export function validateImageAttachmentInput(input: StoreSessionAttachmentInput): Buffer {
  if (!ALLOWED_IMAGE_MIME_TYPES.has(input.mimeType)) {
    throw new Error(`Unsupported image type: ${input.mimeType || "unknown"}`);
  }

  const data = normalizeBytes(input.data);
  if (data.length === 0) {
    throw new Error("Attachment is empty");
  }
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`);
  }
  return data;
}

export function storeSessionAttachment(
  sessionId: string,
  input: StoreSessionAttachmentInput,
): SessionAttachmentInfo {
  const data = validateImageAttachmentInput(input);
  const sha256 = sha256Hex(data);
  const hint = normalizeImageSizeHint(input.width, input.height);
  const db = getDb();

  const existing = db
    .query<SessionAttachmentRow, [string, string, string]>(
      `SELECT * FROM session_attachments
       WHERE session_id = ? AND sha256 = ? AND mime_type = ?`,
    )
    .get(sessionId, sha256, input.mimeType);

  if (existing) {
    const width = existing.width ?? hint?.width ?? null;
    const height = existing.height ?? hint?.height ?? null;
    const shouldUpdate = !existing.data
      || (hint !== null && (existing.width === null || existing.height === null));

    if (shouldUpdate) {
      db.query(
        `UPDATE session_attachments
         SET data = COALESCE(data, ?),
             byte_size = ?,
             filename = COALESCE(filename, ?),
             width = COALESCE(width, ?),
             height = COALESCE(height, ?),
             pruned_at = CASE WHEN data IS NULL THEN NULL ELSE pruned_at END
         WHERE id = ?`,
      ).run(data, data.length, input.filename ?? null, hint?.width ?? null, hint?.height ?? null, existing.id);
      return toInfo({
        ...existing,
        data: existing.data ?? data,
        byte_size: data.length,
        filename: existing.filename ?? input.filename ?? null,
        width,
        height,
        pruned_at: existing.data ? existing.pruned_at : null,
      });
    }
    return toInfo(existing);
  }

  const id = `att_${randomUUID()}`;
  const row = db
    .query<SessionAttachmentRow, [string, string, string, string | null, number, string, Buffer, number | null, number | null]>(
      `INSERT INTO session_attachments (id, session_id, kind, mime_type, filename, byte_size, sha256, data, width, height, created_at)
       VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       RETURNING *`,
    )
    .get(id, sessionId, input.mimeType, input.filename ?? null, data.length, sha256, data, hint?.width ?? null, hint?.height ?? null)!;

  return toInfo(row);
}

export function getSessionAttachment(sessionId: string, attachmentId: string): SessionAttachmentRow | null {
  const row = getDb()
    .query<SessionAttachmentRow, [string, string]>(
      `SELECT * FROM session_attachments WHERE session_id = ? AND id = ?`,
    )
    .get(sessionId, attachmentId) ?? null;
  return row ? normalizeRow(row) : null;
}

function attachmentBlockFromInfo(info: SessionAttachmentInfo): ImageAttachmentBlock {
  const hint = normalizeImageSizeHint(info.width, info.height);
  return {
    type: "image",
    attachmentId: info.id,
    mimeType: info.mimeType,
    filename: info.filename,
    byteSize: info.byteSize,
    sha256: info.sha256,
    ...(hint ? { width: hint.width, height: hint.height } : {}),
  };
}

function inlineBlockFromRow(
  row: SessionAttachmentRow,
  fallbackHint?: ImageSizeHint | null,
): InlineImageBlock | { type: "text"; text: string } {
  if (!row.data) return { type: "text", text: "[Image attachment pruned]" };
  const hint = normalizeImageSizeHint(row.width, row.height) ?? fallbackHint ?? null;
  return {
    type: "image",
    data: row.data.toString("base64"),
    mimeType: row.mime_type,
    filename: row.filename ?? undefined,
    ...(hint ? { width: hint.width, height: hint.height } : {}),
  };
}

export function externalizeInlineImageBlock(sessionId: string, block: InlineImageBlock): ImageAttachmentBlock {
  const data = Buffer.from(block.data, "base64");
  const info = storeSessionAttachment(sessionId, {
    data,
    mimeType: block.mimeType,
    filename: block.filename,
    width: block.width,
    height: block.height,
  });
  return attachmentBlockFromInfo(info);
}

export function hydrateImageAttachmentBlock(
  sessionId: string,
  block: ImageAttachmentBlock,
): InlineImageBlock | TextPromptBlock {
  const row = getSessionAttachment(sessionId, block.attachmentId);
  if (!row) return { type: "text", text: "[Image attachment missing]" };
  return inlineBlockFromRow(row, normalizeImageSizeHint(block.width, block.height));
}

export function hydratePromptContent(sessionId: string, content: ClientPromptContent): HydratedPromptContent {
  return content.map((block) => block.type === "image"
    ? hydrateImageAttachmentBlock(sessionId, block)
    : block);
}

function isAttachmentRefBlock(block: PersistedContentBlock): block is ImageAttachmentBlock {
  return block.type === "image";
}

export function collectAttachmentIds(message: { content?: PersistedContentBlock[] }): string[] {
  if (!message.content) return [];
  const ids = message.content
    .filter(isAttachmentRefBlock)
    .map((block) => block.attachmentId);
  return [...new Set(ids)];
}

export function pruneUnreferencedAttachmentData(sessionId: string, candidateIds: string[]): void {
  const uniqueCandidates = [...new Set(candidateIds)];
  if (uniqueCandidates.length === 0) return;

  const rows = getDb()
    .query<{ message_json: string }, [string]>(
      `SELECT message_json FROM session_messages WHERE session_id = ?`,
    )
    .all(sessionId);

  const stillReferenced = new Set<string>();
  for (const row of rows) {
    const message: { content?: PersistedContentBlock[] } = JSON.parse(row.message_json);
    for (const id of collectAttachmentIds(message)) {
      stillReferenced.add(id);
    }
  }

  const update = getDb().query(
    `UPDATE session_attachments
     SET data = NULL, pruned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE session_id = ? AND id = ? AND data IS NOT NULL`,
  );

  for (const id of uniqueCandidates) {
    if (!stillReferenced.has(id)) update.run(sessionId, id);
  }
}
