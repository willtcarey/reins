import { AddCodeReviewAnnotationInputSchema } from "../models/code-review.js";
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

export function registerCodeReviewRoutes(router: RouterGroup<ProjectRouteContext>): void {
  router.get("/code-review", (ctx) => {
    try {
      return Response.json(ctx.project.codeReviews().getOpen(getReviewScope(ctx)));
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
}

function getReviewScope(ctx: ProjectRouteContext): CodeReviewScope {
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
