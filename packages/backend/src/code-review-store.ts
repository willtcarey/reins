import { getDb } from "./db.js";
import {
  CodeReview,
  type CodeReviewStatus,
  type ReviewAnnotation,
} from "./models/code-review.js";

interface CodeReviewRow {
  id: string;
  project_id: number;
  task_id: number | null;
  status: CodeReviewStatus;
  annotations_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface CreateCodeReviewInput {
  id: string;
  projectId: number;
  taskId?: number | null;
}

export interface CodeReviewScope {
  projectId: number;
  taskId: number | null;
}

export class CodeReviewRevisionConflictError extends Error {
  constructor(id: string, expectedRevision: number, actualRevision: number) {
    super(`Code review ${id} revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = "CodeReviewRevisionConflictError";
  }
}

/** Create the one open review allowed in a project/task scope. */
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

/** Return every review in the exact project/task scope, newest first. */
export function listCodeReviews(scope: CodeReviewScope): CodeReview[] {
  return getDb()
    .query<CodeReviewRow, [number, number | null]>(
      `SELECT * FROM code_reviews
       WHERE project_id = ? AND task_id IS ?
       ORDER BY updated_at DESC, id`,
    )
    .all(scope.projectId, scope.taskId)
    .map(fromRow);
}

/** Persist a detached review using its loaded revision as compare-and-swap. */
export function saveCodeReview(review: CodeReview): CodeReview | null {
  const row = getDb()
    .query<CodeReviewRow, [CodeReviewStatus, string, string, number]>(
      `UPDATE code_reviews
       SET status = ?,
           annotations_json = ?,
           revision = revision + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND revision = ?
       RETURNING *`,
    )
    .get(
      review.status,
      JSON.stringify(review.annotations),
      review.id,
      review.revision,
    );
  if (row) return fromRow(row);

  const current = getDb()
    .query<{ revision: number }, [string]>("SELECT revision FROM code_reviews WHERE id = ?")
    .get(review.id);
  if (!current) return null;
  throw new CodeReviewRevisionConflictError(review.id, review.revision, current.revision);
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
    status: row.status,
    revision: row.revision,
    annotations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
