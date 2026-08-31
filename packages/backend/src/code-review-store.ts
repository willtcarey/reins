import { getDb } from "./db.js";
import { CodeReview, type ReviewAnnotation } from "./models/code-review.js";

interface CodeReviewRow {
  id: string;
  project_id: number;
  task_id: number | null;
  annotations_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface CodeReviewPersistenceScope {
  projectId: number;
  taskId: number | null;
}

export interface CreateCodeReviewInput extends CodeReviewPersistenceScope {
  id: string;
}

export class CodeReviewRevisionConflictError extends Error {
  constructor(id: string, expectedRevision: number, actualRevision: number) {
    super(`Code review ${id} revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = "CodeReviewRevisionConflictError";
  }
}

/** Create the one pending review allowed in a project/task scope. */
export function createCodeReview(input: CreateCodeReviewInput): CodeReview {
  const row = getDb()
    .query<CodeReviewRow, [string, number, number | null]>(
      `INSERT INTO code_reviews
         (id, project_id, task_id, annotations_json)
       VALUES (?, ?, ?, '[]')
       RETURNING *`,
    )
    .get(input.id, input.projectId, input.taskId ?? null);
  if (!row) throw new Error("Failed to create code review");
  return fromRow(row);
}

export function getCodeReview(id: string): CodeReview | null {
  const row = getDb()
    .query<CodeReviewRow, [string]>("SELECT * FROM code_reviews WHERE id = ?")
    .get(id);
  return row ? fromRow(row) : null;
}

/** Return the pending review in an exact project/task scope. */
export function getOpenCodeReview(scope: CodeReviewPersistenceScope): CodeReview | null {
  const row = getDb()
    .query<CodeReviewRow, [number, number | null]>(
      `SELECT * FROM code_reviews
       WHERE project_id = ? AND task_id IS ?`,
    )
    .get(scope.projectId, scope.taskId);
  return row ? fromRow(row) : null;
}

/** Persist a detached review using its loaded revision as compare-and-swap. */
export function saveCodeReview(review: CodeReview): CodeReview | null {
  const row = getDb()
    .query<CodeReviewRow, [string, string, number]>(
      `UPDATE code_reviews
       SET annotations_json = ?,
           revision = revision + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND revision = ?
       RETURNING *`,
    )
    .get(JSON.stringify(review.annotations), review.id, review.revision);
  if (row) return fromRow(row);

  const current = getDb()
    .query<{ revision: number }, [string]>("SELECT revision FROM code_reviews WHERE id = ?")
    .get(review.id);
  if (!current) return null;
  throw new CodeReviewRevisionConflictError(review.id, review.revision, current.revision);
}

export interface AcceptedCodeReviewSubmission {
  messageId: string;
  message: { type: "text"; text: string }[];
}

/** Atomically persist one ordinary user message and consume its pending review. */
export function acceptCodeReviewSubmission(
  review: CodeReview,
  sessionId: string,
  text: string,
): AcceptedCodeReviewSubmission {
  const db = getDb();
  const message = [{ type: "text" as const, text }];
  const accept = db.transaction(() => {
    const max = db.query<{ seq: number }, [string]>(
      "SELECT COALESCE(MAX(seq), -1) AS seq FROM session_messages WHERE session_id = ?",
    ).get(sessionId)!;
    const inserted = db.query<{ id: number }, [string, number, string]>(
      `INSERT INTO session_messages (session_id, seq, role, message_json, created_at)
       VALUES (?, ?, 'user', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       RETURNING id`,
    ).get(sessionId, max.seq + 1, JSON.stringify({ role: "user", content: message }));
    if (!inserted) throw new Error("Failed to persist review submission message");

    const deleted = db.query<{ id: string }, [string, number]>(
      "DELETE FROM code_reviews WHERE id = ? AND revision = ? RETURNING id",
    ).get(review.id, review.revision);
    if (!deleted) {
      const current = db.query<{ revision: number }, [string]>(
        "SELECT revision FROM code_reviews WHERE id = ?",
      ).get(review.id);
      if (!current) throw new Error(`Code review ${review.id} no longer exists`);
      throw new CodeReviewRevisionConflictError(review.id, review.revision, current.revision);
    }
    return String(inserted.id);
  });

  return { messageId: accept.immediate(), message };
}

export function deleteCodeReview(id: string): boolean {
  return getDb().query("DELETE FROM code_reviews WHERE id = ?").run(id).changes > 0;
}

function fromRow(row: CodeReviewRow): CodeReview {
  const annotations: ReviewAnnotation[] = JSON.parse(row.annotations_json);
  return CodeReview.restore({
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    revision: row.revision,
    annotations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
