import { acceptCodeReviewSubmission } from "../code-review-store.js";
import { getSession } from "../session-store.js";
import { getDb } from "../db.js";
import type { ServerState } from "../state.js";
import type { Broadcast } from "./broadcast.js";
import { Sessions } from "./sessions.js";
import {
  CodeReviewError,
  type CodeReview,
  type ReviewAnnotation,
} from "./code-review.js";
import { ProjectCodeReviews, type CodeReviewScope } from "./code-reviews.js";

export interface SubmitCodeReviewCommand {
  scope: CodeReviewScope;
  reviewId: string;
  expectedRevision: number;
  sessionId: string;
}

/** Coordinates durable review acceptance with session and runtime adapters. */
export class CodeReviewSubmission {
  constructor(
    private readonly reviews: ProjectCodeReviews,
    private readonly projectId: number,
    private readonly state: ServerState,
    private readonly broadcast: Broadcast,
  ) {}

  async submit(command: SubmitCodeReviewCommand): Promise<{ messageId: string }> {
    const review = this.reviews.getExpected(command.scope, {
      id: command.reviewId,
      revision: command.expectedRevision,
    });
    if (review.annotations.length === 0) {
      throw new CodeReviewError("Code review has no saved comments", "invalid");
    }

    const session = getSession(command.sessionId);
    if (!session || session.project_id !== this.projectId || session.task_id !== command.scope.taskId) {
      throw new CodeReviewError("Submission session does not belong to the review scope", "not-found");
    }
    const feedback = this.compileFeedback(review.annotations);
    const message = [{ type: "text" as const, text: feedback }];
    const reinsId = `code-review:${review.id}:${review.revision}`;
    // The prompt goes through the command outbox like any input, atomically with consuming the review.
    // Where the session lives and whether it is busy is the delivery path's concern, not the review's.
    getDb().transaction(() => {
      acceptCodeReviewSubmission(review, command.sessionId, feedback);
      new Sessions(this.state.nodes).submit(command.sessionId, { op: "prompt", content: message, clientId: reinsId });
    })();
    this.broadcastReview(review);
    return { messageId: reinsId };
  }

  private broadcastReview(review: CodeReview): void {
    this.broadcast({
      type: "code_review_updated",
      projectId: review.projectId,
      taskId: review.taskId,
      reviewId: review.id,
      revision: review.revision + 1,
    });
  }

  private compileFeedback(annotations: readonly ReviewAnnotation[]): string {
    const locations = new Map<string, {
      anchor: ReviewAnnotation["anchor"];
      entries: ReviewAnnotation["entries"];
    }>();

    for (const annotation of annotations) {
      const { anchor } = annotation;
      const key = JSON.stringify([anchor.path, anchor.side, anchor.startLine, anchor.lines]);
      const location = locations.get(key);
      if (location) {
        location.entries.push(...annotation.entries);
      } else {
        locations.set(key, { anchor, entries: [...annotation.entries] });
      }
    }

    return [...locations.values()].map(({ anchor, entries }) => {
      const diff = anchor.filePatch
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
      const comments = entries.map((entry, index) =>
        `${index === 0 ? "" : "↳ "}${entry.author}: ${entry.body}`,
      ).join("\n");
      return `${anchor.path}\n\nDiff:\n${diff}\n\n${comments}`;
    }).join("\n\n---\n\n");
  }
}
