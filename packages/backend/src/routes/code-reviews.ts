import { Type } from "@sinclair/typebox";
import {
  AddCodeReviewAnnotationInputSchema,
  CodeReviewError,
  DeleteCodeReviewCommentInputSchema,
} from "../models/code-review.js";
import { CodeReviewSubmission } from "../models/code-review-submission.js";
import { createBroadcast } from "../models/broadcast.js";
import { type CodeReviewScope } from "../models/code-reviews.js";
import type { RouterGroup } from "../router.js";
import { badRequest, conflict, notFound } from "../errors.js";
import type { ProjectRouteContext } from "./index.js";
import { parseBody } from "./validate.js";

const SubmitCodeReviewInputSchema = Type.Object({
  reviewId: Type.String({ minLength: 1 }),
  expectedRevision: Type.Integer({ minimum: 0 }),
  sessionId: Type.String({ minLength: 1 }),
});

export function registerCodeReviewRoutes(router: RouterGroup<ProjectRouteContext>): void {
  router.get("/code-review", (ctx) => {
    try {
      return Response.json(ctx.project.codeReviews().getOpen(getReviewScope(ctx)));
    } catch (error) {
      return translateError(error);
    }
  });

  router.post("/code-review/submissions", async (ctx) => {
    const scope = getReviewScope(ctx);
    const body = await parseBody(SubmitCodeReviewInputSchema, ctx.req);

    try {
      const submission = new CodeReviewSubmission(
        ctx.project.codeReviews(),
        ctx.project.projectId,
        ctx.state,
        createBroadcast(ctx.state.clients),
      );
      return Response.json(await submission.submit({ scope, ...body }));
    } catch (error) {
      return translateError(error);
    }
  });

  router.post("/code-review/annotations", async (ctx) => {
    const scope = getReviewScope(ctx);
    const body = await parseBody(AddCodeReviewAnnotationInputSchema, ctx.req);

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

  router.delete("/code-review/comments/:commentId", async (ctx) => {
    const scope = getReviewScope(ctx);
    const body = await parseBody(DeleteCodeReviewCommentInputSchema, ctx.req);

    try {
      return Response.json(ctx.project.codeReviews().deleteComment({
        scope,
        expectedReview: body.expectedReview,
        commentId: ctx.params.commentId!,
      }));
    } catch (error) {
      return translateError(error);
    }
  });
}

function getReviewScope(ctx: ProjectRouteContext): CodeReviewScope {
  const value = ctx.url.searchParams.get("taskId");
  if (value === null) return { taskId: null };
  const taskId = Number(value);
  if (!Number.isInteger(taskId) || taskId < 1) badRequest("taskId must be a positive integer");
  return { taskId };
}

function translateError(error: unknown): never {
  if (!(error instanceof CodeReviewError)) throw error;
  if (error.kind === "not-found") notFound(error.message);
  if (error.kind === "conflict") conflict(error.message);
  badRequest(error.message);
}
