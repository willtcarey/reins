/**
 * `reviews` (docs/dev/server-sdk.md): the pending code review of the calling session's project and task, for an
 * agent's script (`api.reviews`). A review is about a session's branch diff, so an extension, which has no session,
 * is refused (`reins.reviews` has the same methods).
 */

import { Type } from "@sinclair/typebox";
import { asyncIterableToText } from "../async-iterable.js";
import {
  CodeReviewStateSchema,
  ReviewAnchorEvidenceSchema,
  ReviewAnnotationSchema,
  ReviewDiffLineSchema,
  ReviewEntrySchema,
} from "../models/code-review.js";
import type { SessionModel } from "../models/session.js";
import { sdkMethod, type CallContext, type SdkNamespace } from "./declaration.js";

/** The calling session, of a project: code reviews belong to projects. */
function reviewing(context: CallContext): { session: SessionModel; projectId: number } {
  if (context.caller.kind !== "session") throw new Error("A code review is of the calling session's project and task, and an extension has none");
  const { session } = context.caller;
  if (session.projectId === null) throw new Error("This session has no project, and code reviews belong to projects");
  return { session, projectId: session.projectId };
}

const current = sdkMethod({
  description: "Get the pending code review in the current project/task scope, or null when none exists.",
  params: [],
  returns: Type.Union([CodeReviewStateSchema, Type.Null()]),
  tags: ["reviews", "code", "comments", "current", "read"],
  async run(context) {
    const { session, projectId } = reviewing(context);
    return context.models.project(projectId).codeReviews().getOpen({ taskId: session.taskId });
  },
});

const addComment = sdkMethod({
  description:
    "Create a pending code review if needed and add a comment anchored to a line or same-side range " +
    "in the current Git branch diff. The server captures the exact native per-file patch.",
  params: [
    { name: "path", schema: Type.String({ minLength: 1 }) },
    { name: "line", schema: Type.Integer({ minimum: 1 }) },
    { name: "body", schema: Type.String({ minLength: 1 }) },
    {
      name: "options",
      schema: Type.Object({
        endLine: Type.Optional(Type.Integer({ minimum: 1 })),
        side: Type.Optional(Type.Union([Type.Literal("old"), Type.Literal("new")])),
        author: Type.Optional(Type.String({ minLength: 1 })),
      }),
      optional: true,
    },
  ],
  returns: CodeReviewStateSchema,
  tags: ["reviews", "code", "comments", "create", "write", "diff"],
  async run(context, path, line, body, options = {}) {
    const text = body.trim();
    if (!text) throw new Error("Review comment body cannot be empty");
    const { session, projectId } = reviewing(context);
    const patch = await asyncIterableToText(session.workspace.getDiffPatchStream(3, "branch", session.task?.branch_name));
    return context.models.project(projectId).codeReviews().addComment({
      scope: { taskId: session.taskId },
      author: options.author?.trim() || "Agent",
      comment: { path, side: options.side ?? "new", startLine: line, endLine: options.endLine ?? line, filePatch: patch, body: text },
    }).review;
  },
});

export const REVIEWS = {
  name: "reviews",
  methods: { current, addComment },
  types: {
    CodeReview: CodeReviewStateSchema,
    ReviewAnnotation: ReviewAnnotationSchema,
    ReviewAnchor: ReviewAnchorEvidenceSchema,
    ReviewDiffLine: ReviewDiffLineSchema,
    ReviewEntry: ReviewEntrySchema,
  },
} satisfies SdkNamespace;
