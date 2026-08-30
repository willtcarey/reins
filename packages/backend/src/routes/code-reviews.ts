import { Type } from "@sinclair/typebox";
import type { RouterGroup } from "../router.js";
import type { ProjectRouteContext } from "./index.js";
import { conflict, notFound, badRequest } from "../errors.js";
import { getOpenCodeReview } from "../code-review-store.js";
import {
  addCodeReviewAnnotation,
  CodeReviewMutationConflictError,
} from "../code-review-workflow.js";
import { createBroadcast } from "../models/broadcast.js";
import { getTask } from "../task-store.js";
import { parseBody, parseIntParam } from "./validate.js";

const NonEmptyString = Type.String({ minLength: 1, pattern: "\\S" });
const NullableString = Type.Union([Type.String(), Type.Null()]);
const Anchor = Type.Object({
  path: NonEmptyString,
  oldPath: NullableString,
  side: Type.Union([Type.Literal("old"), Type.Literal("new")]),
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  excerpt: Type.String(),
  contextBefore: NullableString,
  contextAfter: NullableString,
  fileFingerprint: NullableString,
  baseRevision: NullableString,
  headRevision: NullableString,
});
const Entry = Type.Object({
  id: NonEmptyString,
  author: NonEmptyString,
  body: NonEmptyString,
  createdAt: NonEmptyString,
  sourceKey: Type.Optional(NonEmptyString),
  sourceUrl: Type.Optional(NonEmptyString),
});
const AddAnnotationBody = Type.Object({
  reviewId: Type.Optional(NonEmptyString),
  revision: Type.Optional(Type.Integer({ minimum: 0 })),
  annotation: Type.Object({ id: NonEmptyString, anchor: Anchor, entry: Entry }),
});

export function registerCodeReviewRoutes(router: RouterGroup<ProjectRouteContext>): void {
  router.get("/code-review", (ctx) => loadOpenReview(ctx, null));
  router.post("/code-review/annotations", (ctx) => addAnnotation(ctx, null));

  router.get("/tasks/:taskId/code-review", (ctx) => {
    return loadOpenReview(ctx, scopedTaskId(ctx));
  });
  router.post("/tasks/:taskId/code-review/annotations", (ctx) => {
    return addAnnotation(ctx, scopedTaskId(ctx));
  });
}

function loadOpenReview(ctx: ProjectRouteContext, taskId: number | null): Response {
  return Response.json(getOpenCodeReview({ projectId: ctx.project.projectId, taskId }));
}

async function addAnnotation(ctx: ProjectRouteContext, taskId: number | null): Promise<Response> {
  const body = await parseBody(AddAnnotationBody, ctx.req);
  if ((body.reviewId === undefined) !== (body.revision === undefined)) {
    badRequest("reviewId and revision must be supplied together");
  }
  if (body.annotation.anchor.endLine < body.annotation.anchor.startLine) {
    badRequest("annotation anchor endLine must be greater than or equal to startLine");
  }

  try {
    const result = addCodeReviewAnnotation({
      projectId: ctx.project.projectId,
      taskId,
      reviewId: body.reviewId,
      revision: body.revision,
      annotation: body.annotation,
    }, createBroadcast(ctx.state.clients));
    return Response.json(result.review, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof CodeReviewMutationConflictError) conflict(error.message);
    throw error;
  }
}

function scopedTaskId(ctx: ProjectRouteContext): number {
  const taskId = parseIntParam(ctx.params, "taskId");
  const task = getTask(taskId);
  if (!task || task.project_id !== ctx.project.projectId) notFound("Task not found");
  return taskId;
}
