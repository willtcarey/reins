import type { RouterGroup, RouteContext } from "../router.js";
import { badRequest, notFound, HttpError } from "../errors.js";
import {
  SessionAttachmentNotFoundError,
  SessionAttachmentPrunedError,
  SessionAttachmentUploadError,
  Sessions,
} from "../models/sessions.js";
import {
  parseFormData,
  parseFormFiles,
} from "./validate.js";
import { withSessionNotFound } from "./session-errors.js";

function handleAttachmentError(err: unknown): never {
  if (err instanceof SessionAttachmentNotFoundError) notFound(err.message);
  if (err instanceof SessionAttachmentUploadError) badRequest(err.message);
  if (err instanceof SessionAttachmentPrunedError) throw new HttpError(410, err.message);
  throw err;
}

export function registerAttachmentRoutes(router: RouterGroup<RouteContext>) {
  router.post("/:sessionId/attachments", withSessionNotFound(async (ctx) => {
    const sessionId = ctx.params.sessionId;

    try {
      const form = await parseFormData(ctx.req);
      const files = parseFormFiles(form, "files", { emptyMessage: "No files uploaded" });
      const sessions = new Sessions();
      const attachments = await sessions.uploadAttachments(sessionId, files);
      return Response.json({ attachments });
    } catch (err) {
      handleAttachmentError(err);
    }
  }));

  router.get("/:sessionId/attachments/:attachmentId", withSessionNotFound(async (ctx) => {
    const { sessionId, attachmentId } = ctx.params;

    try {
      const sessions = new Sessions();
      const attachment = sessions.getAttachmentBytes(sessionId, attachmentId);
      const body = new Uint8Array(attachment.data);
      return new Response(body, {
        headers: {
          "Content-Type": attachment.mimeType,
          "Content-Length": String(attachment.data.length),
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      });
    } catch (err) {
      handleAttachmentError(err);
    }
  }));
}
