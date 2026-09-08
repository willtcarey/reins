import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { asyncIterableToText } from "../async-iterable.js";
import { CodeReviewStateSchema } from "../models/code-review.js";
import { reviewAnchorFromPatch } from "../models/review-diff-anchor.js";
import { ProjectModel } from "../models/projects.js";
import { getTask } from "../task-store.js";
import { type ApiFunctionDef, defineFunction, type ApiContext } from "./define-function.js";

const ReviewCommentOptionsSchema = Type.Object({
  endLine: Type.Optional(Type.Integer({ minimum: 1 })),
  side: Type.Optional(Type.Union([Type.Literal("old"), Type.Literal("new")])),
  author: Type.Optional(Type.String({ minLength: 1 })),
});

function projectModel(ctx: ApiContext): ProjectModel {
  return new ProjectModel(ctx.projectId, ctx.sessions, ctx.broadcast);
}

function taskBranch(ctx: ApiContext): string | undefined {
  if (ctx.taskId === null) return undefined;
  const task = getTask(ctx.taskId);
  if (!task || task.project_id !== ctx.projectId) throw new Error("Current review task not found");
  return task.branch_name;
}

export const REVIEW_FUNCTIONS: ApiFunctionDef[] = [
  defineFunction({
    name: "reviews.current",
    description: "Get the pending code review in the current project/task scope, or null when none exists.",
    parameters: Type.Object({}),
    returns: Type.Union([CodeReviewStateSchema, Type.Null()]),
    async: true,
    tags: ["reviews", "code", "comments", "current", "read"],
    execute: async (_params, ctx) => projectModel(ctx).codeReviews().getOpen({ taskId: ctx.taskId }),
  }),
  defineFunction({
    name: "reviews.addComment",
    description:
      "Create a pending code review if needed and add a comment anchored to a line or same-side range " +
      "in the current Git branch diff. The server captures the exact native per-file patch.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      line: Type.Integer({ minimum: 1 }),
      body: Type.String({ minLength: 1 }),
      options: Type.Optional(ReviewCommentOptionsSchema),
    }),
    returns: CodeReviewStateSchema,
    async: true,
    tags: ["reviews", "code", "comments", "create", "write", "diff"],
    execute: async (params, ctx) => {
      const body = params.body.trim();
      if (!body) throw new Error("Review comment body cannot be empty");
      const project = projectModel(ctx);
      const patch = await asyncIterableToText(
        project.workspace.getDiffPatchStream(3, "branch", taskBranch(ctx)),
      );
      const anchor = reviewAnchorFromPatch(patch, {
        path: params.path,
        side: params.options?.side ?? "new",
        startLine: params.line,
        endLine: params.options?.endLine ?? params.line,
      });
      const now = new Date().toISOString();
      const review = project.codeReviews().addAnnotation({
        scope: { taskId: ctx.taskId },
        annotation: {
          id: randomUUID(),
          anchor,
          entry: {
            id: randomUUID(),
            author: params.options?.author?.trim() || "Agent",
            body,
            createdAt: now,
          },
        },
      }).review;
      return review;
    },
  }),
];
