import { Type } from "@sinclair/typebox";
import {
  CodeReviewMutationConflictError,
  CodeReviewScopeNotFoundError,
  InvalidCodeReviewAnnotationError,
  type CodeReviewScope,
} from "../models/code-reviews.js";
import type { RouterGroup } from "../router.js";
import { badRequest, conflict, notFound } from "../errors.js";
import type { ProjectRouteContext } from "./index.js";
import { parseBody } from "./validate.js";

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
  expectedReview: Type.Optional(Type.Object({
    id: NonEmptyString,
    revision: Type.Integer({ minimum: 0 }),
  })),
  annotation: Type.Object({ id: NonEmptyString, anchor: Anchor, entry: Entry }),
});

export function registerCodeReviewRoutes(router: RouterGroup<ProjectRouteContext>): void {
  router.get("/code-review", (ctx) => {
    try {
      return Response.json(ctx.project.codeReviews().getOpen(scopeFromRequest(ctx)));
    } catch (error) {
      return translateError(error);
    }
  });

  router.post("/code-review/annotations", async (ctx) => {
    const scope = scopeFromRequest(ctx);
    const body = await parseBody(AddAnnotationBody, ctx.req);

    try {
      const result = ctx.project.codeReviews().addAnnotation({
        scope,
        expectedReview: body.expectedReview,
        annotation: body.annotation,
      });
      return Response.json(result.review, { status: result.created ? 201 : 200 });
    } catch (error) {
      return translateError(error);
    }
  });
}

function scopeFromRequest(ctx: ProjectRouteContext): CodeReviewScope {
  const value = ctx.url.searchParams.get("taskId");
  if (value === null) return { taskId: null };
  const taskId = Number(value);
  if (!Number.isInteger(taskId) || taskId < 1) badRequest("taskId must be a positive integer");
  return { taskId };
}

function translateError(error: unknown): never {
  if (error instanceof CodeReviewScopeNotFoundError) notFound(error.message);
  if (error instanceof CodeReviewMutationConflictError) conflict(error.message);
  if (error instanceof InvalidCodeReviewAnnotationError) badRequest(error.message);
  throw error;
}
