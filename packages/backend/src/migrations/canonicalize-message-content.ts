import type { Database, Statement } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

type JsonRecord = Record<string, unknown>;

interface MigrationAttachmentRow {
  id: string;
  mime_type: string;
  filename: string | null;
  byte_size: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

interface MigrationInlineImageBlock {
  type: "image";
  data: string;
  mimeType: string;
  filename?: unknown;
  width?: unknown;
  height?: unknown;
}

interface MigrationImageSizeHint {
  width: number;
  height: number;
}

const MIGRATION_ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const MIGRATION_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMigrationInlineImageBlock(value: unknown): value is MigrationInlineImageBlock {
  return isRecord(value)
    && value.type === "image"
    && typeof value.data === "string"
    && typeof value.mimeType === "string";
}

function normalizeMigrationImageSizeHint(width: unknown, height: unknown): MigrationImageSizeHint | null {
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

function migrationTextFromContentBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      isRecord(block) && block.type === "text" && typeof block.text === "string"
    ))
    .map((block) => block.text)
    .join("\n");
}

function canonicalizeRootMessageContentForMigration(value: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(value)) return { value, changed: false };

  if (value.role === "compactionSummary") {
    const next = { ...value };
    let changed = false;
    let summary = typeof next.summary === "string" ? next.summary : undefined;

    if (summary === undefined) {
      if (typeof next.content === "string") {
        summary = next.content;
      } else {
        const blockSummary = migrationTextFromContentBlocks(next.content);
        if (blockSummary || Array.isArray(next.content)) summary = blockSummary;
      }

      if (summary !== undefined) {
        next.summary = summary;
        changed = true;
      }
    }

    if ("content" in next) {
      delete next.content;
      changed = true;
    }

    return { value: next, changed };
  }

  if (
    (value.role === "user" || value.role === "assistant" || value.role === "toolResult")
    && typeof value.content === "string"
  ) {
    return {
      value: {
        ...value,
        content: [{ type: "text", text: value.content }],
      },
      changed: true,
    };
  }

  return { value, changed: false };
}

function migrationImageBlockFromRow(row: MigrationAttachmentRow): JsonRecord {
  const hint = normalizeMigrationImageSizeHint(row.width, row.height);
  return {
    type: "image",
    attachmentId: row.id,
    mimeType: row.mime_type,
    filename: row.filename ?? undefined,
    byteSize: row.byte_size,
    sha256: row.sha256,
    ...(hint ? { width: hint.width, height: hint.height } : {}),
  };
}

function storeMigratedInlineImage(
  upsertAttachment: Statement<MigrationAttachmentRow, [string, string, string, string | null, number, string, Buffer, number | null, number | null]>,
  sessionId: string,
  block: MigrationInlineImageBlock,
): JsonRecord {
  if (!MIGRATION_ALLOWED_IMAGE_MIME_TYPES.has(block.mimeType)) {
    throw new Error(`Unsupported image type in persisted message: ${block.mimeType || "unknown"}`);
  }

  const data = Buffer.from(block.data, "base64");
  if (data.length === 0) throw new Error("Persisted image attachment is empty");
  if (data.length > MIGRATION_MAX_ATTACHMENT_BYTES) {
    throw new Error(`Persisted image attachment exceeds ${MIGRATION_MAX_ATTACHMENT_BYTES} byte limit`);
  }

  const sha256 = createHash("sha256").update(data).digest("hex");
  const hint = normalizeMigrationImageSizeHint(block.width, block.height);
  const row = upsertAttachment.get(
    `att_${randomUUID()}`,
    sessionId,
    block.mimeType,
    typeof block.filename === "string" ? block.filename : null,
    data.length,
    sha256,
    data,
    hint?.width ?? null,
    hint?.height ?? null,
  );

  if (!row) throw new Error("Failed to store migrated image attachment");
  return migrationImageBlockFromRow(row);
}

function externalizeInlineImagesForMigration(
  value: unknown,
  storeImage: (block: MigrationInlineImageBlock) => JsonRecord,
): { value: unknown; changed: boolean } {
  if (isMigrationInlineImageBlock(value)) {
    return { value: storeImage(value), changed: true };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const migrated = externalizeInlineImagesForMigration(entry, storeImage);
      changed = changed || migrated.changed;
      return migrated.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }

  if (!isRecord(value)) return { value, changed: false };

  let changed = false;
  const next: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    const migrated = externalizeInlineImagesForMigration(entry, storeImage);
    changed = changed || migrated.changed;
    next[key] = migrated.value;
  }

  return changed ? { value: next, changed } : { value, changed: false };
}

export function canonicalizeMessageContentMigration(db: Database): void {
  const rows = db
    .query<{ id: number; session_id: string; message_json: string }, []>(
      `SELECT id, session_id, message_json
       FROM session_messages
       WHERE message_json LIKE '%"data":%'
          OR json_type(message_json, '$.content') = 'text'
          OR (role = 'compactionSummary' AND json_type(message_json, '$.content') IS NOT NULL)`,
    )
    .all();

  if (rows.length === 0) return;

  const upsertAttachment = db.query<MigrationAttachmentRow, [string, string, string, string | null, number, string, Buffer, number | null, number | null]>(
    `INSERT INTO session_attachments (id, session_id, kind, mime_type, filename, byte_size, sha256, data, width, height, created_at)
     VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(session_id, sha256, mime_type) DO UPDATE SET
       data = COALESCE(session_attachments.data, excluded.data),
       byte_size = excluded.byte_size,
       filename = COALESCE(session_attachments.filename, excluded.filename),
       width = COALESCE(session_attachments.width, excluded.width),
       height = COALESCE(session_attachments.height, excluded.height),
       pruned_at = CASE WHEN session_attachments.data IS NULL THEN NULL ELSE session_attachments.pruned_at END
     RETURNING id, mime_type, filename, byte_size, sha256, width, height`,
  );
  const updateMessage = db.query("UPDATE session_messages SET message_json = ? WHERE id = ?");

  const tx = db.transaction(() => {
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.message_json);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse persisted message ${row.id}: ${message}`, { cause: err });
      }

      const canonical = canonicalizeRootMessageContentForMigration(parsed);
      const externalized = externalizeInlineImagesForMigration(canonical.value, (block) => (
        storeMigratedInlineImage(upsertAttachment, row.session_id, block)
      ));

      if (canonical.changed || externalized.changed) {
        updateMessage.run(JSON.stringify(externalized.value), row.id);
      }
    }
  });
  tx();
}
