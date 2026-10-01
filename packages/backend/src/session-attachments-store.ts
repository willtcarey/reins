import { createHash, randomUUID } from "node:crypto";
import { ATTACHMENT_IMAGE_MIME_TYPES, MAX_ATTACHMENT_BYTES } from "@reins/node-protocol";
import { getDb } from "./db.js";
import type {
  ClientPromptContent,
  HydratedPromptContent,
  ImageAttachmentBlock,
  InlineImageBlock,
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

/** Shared with the node, which checks the same limits before it references a tool-result image. */
export const ALLOWED_IMAGE_MIME_TYPES = new Set(ATTACHMENT_IMAGE_MIME_TYPES);
export { MAX_ATTACHMENT_BYTES };
export const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface StoreSessionAttachmentInput {
  /** A caller-assigned ID (a node's): the bytes are stored under exactly this ID, never deduplicated into another. */
  id?: string;
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

function attachmentUrl(sessionId: string, attachmentId: string): string {
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

function validateImageAttachmentInput(input: StoreSessionAttachmentInput): Buffer {
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

function insertAttachment(id: string, sessionId: string, input: StoreSessionAttachmentInput, data: Buffer, sha256: string, hint: ImageSizeHint | null): SessionAttachmentInfo {
  const row = getDb()
    .query<SessionAttachmentRow, [string, string, string, string | null, number, string, Buffer, number | null, number | null]>(
      `INSERT INTO session_attachments (id, session_id, kind, mime_type, filename, byte_size, sha256, data, width, height, created_at)
       VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       RETURNING *`,
    )
    .get(id, sessionId, input.mimeType, input.filename ?? null, data.length, sha256, data, hint?.width ?? null, hint?.height ?? null)!;
  return toInfo(row);
}

/** Restores pruned bytes and fills missing metadata of an existing row with the same content. */
function completeAttachment(existing: SessionAttachmentRow, input: StoreSessionAttachmentInput, data: Buffer, hint: ImageSizeHint | null): SessionAttachmentInfo {
  const shouldUpdate = !existing.data
    || (hint !== null && (existing.width === null || existing.height === null));
  if (!shouldUpdate) return toInfo(existing);
  getDb().query(
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
    width: existing.width ?? hint?.width ?? null,
    height: existing.height ?? hint?.height ?? null,
    pruned_at: existing.data ? existing.pruned_at : null,
  });
}

/**
 * Without `input.id`, the server assigns the ID and dedupes by sha256 + MIME type within the session.
 * With `input.id` (a node-assigned ID), the bytes are stored under exactly that ID: the same content
 * again converges (restoring pruned bytes), different content under the ID or an ID another session
 * holds rejects, and identical bytes already held under another ID are stored again under this one, so
 * every transcript reference resolves as written.
 */
export function storeSessionAttachment(
  sessionId: string,
  input: StoreSessionAttachmentInput,
): SessionAttachmentInfo {
  const data = validateImageAttachmentInput(input);
  const sha256 = sha256Hex(data);
  const hint = normalizeImageSizeHint(input.width, input.height);
  const db = getDb();

  if (input.id !== undefined) {
    const assigned = db.query<SessionAttachmentRow, [string]>("SELECT * FROM session_attachments WHERE id = ?").get(input.id);
    if (!assigned) return insertAttachment(input.id, sessionId, input, data, sha256, hint);
    if (assigned.session_id !== sessionId) throw new Error(`Attachment ID already in use: ${input.id}`);
    if (assigned.sha256 !== sha256 || assigned.mime_type !== input.mimeType || assigned.byte_size !== data.length) {
      throw new Error(`Attachment ${input.id} is already stored with different content`);
    }
    return completeAttachment(normalizeRow(assigned), input, data, hint);
  }

  const existing = db
    .query<SessionAttachmentRow, [string, string, string]>(
      `SELECT * FROM session_attachments
       WHERE session_id = ? AND sha256 = ? AND mime_type = ?
       ORDER BY created_at, id LIMIT 1`,
    )
    .get(sessionId, sha256, input.mimeType);
  if (existing) return completeAttachment(existing, input, data, hint);
  return insertAttachment(`att_${randomUUID()}`, sessionId, input, data, sha256, hint);
}

export function getSessionAttachment(sessionId: string, attachmentId: string): SessionAttachmentRow | null {
  const row = getDb()
    .query<SessionAttachmentRow, [string, string]>(
      `SELECT * FROM session_attachments WHERE session_id = ? AND id = ?`,
    )
    .get(sessionId, attachmentId) ?? null;
  return row ? normalizeRow(row) : null;
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
