import { createHash, randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import {
  isImageAttachmentBlock,
  isInlineImageBlock,
  isRecord,
  type ClientPromptContent,
  type ImageAttachmentBlock,
  type InlineImageBlock,
  type RuntimePromptContent,
} from "./content-blocks.js";

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
}

export interface SessionAttachmentInfo {
  id: string;
  kind: "image";
  mimeType: string;
  filename?: string;
  byteSize: number;
  sha256: string;
  url: string;
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
  return {
    id: row.id,
    kind: "image",
    mimeType: row.mime_type,
    filename: row.filename ?? undefined,
    byteSize: row.byte_size,
    sha256: row.sha256,
    url: attachmentUrl(row.session_id, row.id),
  };
}

export function attachmentUrl(sessionId: string, attachmentId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`;
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
  const db = getDb();

  const existing = db
    .query<SessionAttachmentRow, [string, string, string]>(
      `SELECT * FROM session_attachments
       WHERE session_id = ? AND sha256 = ? AND mime_type = ?`,
    )
    .get(sessionId, sha256, input.mimeType);

  if (existing) {
    if (!existing.data) {
      db.query(
        `UPDATE session_attachments
         SET data = ?, byte_size = ?, filename = COALESCE(filename, ?), pruned_at = NULL
         WHERE id = ?`,
      ).run(data, data.length, input.filename ?? null, existing.id);
      return toInfo({ ...existing, data, byte_size: data.length, filename: existing.filename ?? input.filename ?? null, pruned_at: null });
    }
    return toInfo(existing);
  }

  const id = `att_${randomUUID()}`;
  const row = db
    .query<SessionAttachmentRow, [string, string, string, string | null, number, string, Buffer]>(
      `INSERT INTO session_attachments (id, session_id, kind, mime_type, filename, byte_size, sha256, data, created_at)
       VALUES (?, ?, 'image', ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       RETURNING *`,
    )
    .get(id, sessionId, input.mimeType, input.filename ?? null, data.length, sha256, data)!;

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
  return {
    type: "image",
    attachmentId: info.id,
    mimeType: info.mimeType,
    filename: info.filename,
    byteSize: info.byteSize,
    sha256: info.sha256,
  };
}

function inlineBlockFromRow(row: SessionAttachmentRow): InlineImageBlock | { type: "text"; text: string } {
  if (!row.data) return { type: "text", text: "[Image attachment pruned]" };
  return {
    type: "image",
    data: row.data.toString("base64"),
    mimeType: row.mime_type,
    filename: row.filename ?? undefined,
  };
}

function externalizeInlineImage(sessionId: string, block: InlineImageBlock): ImageAttachmentBlock {
  const data = Buffer.from(block.data, "base64");
  const info = storeSessionAttachment(sessionId, {
    data,
    mimeType: block.mimeType,
    filename: block.filename,
  });
  return attachmentBlockFromInfo(info);
}

export function externalizeImages<T>(sessionId: string, value: T): T;
export function externalizeImages(sessionId: string, value: unknown): unknown {
  if (isInlineImageBlock(value)) {
    return externalizeInlineImage(sessionId, value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => externalizeImages(sessionId, entry));
  }

  if (!isRecord(value) || value instanceof Uint8Array || value instanceof Date) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = externalizeImages(sessionId, entry);
  }
  return result;
}

export function hydrateAttachmentRefs(sessionId: string, value: ClientPromptContent): RuntimePromptContent;
export function hydrateAttachmentRefs<T>(sessionId: string, value: T): T;
export function hydrateAttachmentRefs(sessionId: string, value: unknown): unknown {
  if (isImageAttachmentBlock(value)) {
    const row = getSessionAttachment(sessionId, value.attachmentId);
    if (!row) {
      return { type: "text", text: "[Image attachment missing]" };
    }
    return inlineBlockFromRow(row);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => hydrateAttachmentRefs(sessionId, entry));
  }

  if (!isRecord(value) || value instanceof Uint8Array || value instanceof Date) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = hydrateAttachmentRefs(sessionId, entry);
  }
  return result;
}

export function collectAttachmentIds(value: unknown): string[] {
  const ids: string[] = [];
  collectAttachmentIdsInto(value, ids);
  return [...new Set(ids)];
}

function collectAttachmentIdsInto(value: unknown, ids: string[]): void {
  if (isImageAttachmentBlock(value)) {
    ids.push(value.attachmentId);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectAttachmentIdsInto(entry, ids);
    return;
  }

  if (!isRecord(value) || value instanceof Uint8Array || value instanceof Date) return;
  for (const entry of Object.values(value)) collectAttachmentIdsInto(entry, ids);
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
    try {
      for (const id of collectAttachmentIds(JSON.parse(row.message_json))) {
        stillReferenced.add(id);
      }
    } catch {
      // Ignore malformed historical rows.
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
