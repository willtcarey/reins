import type { RouterGroup, RouteContext } from "../router.js";
import { badRequest, notFound, HttpError } from "../errors.js";
import {
  SessionAttachmentNotFoundError,
  SessionAttachmentPrunedError,
  SessionAttachmentUploadError,
  SessionNotFoundError,
  Sessions,
} from "../models/sessions.js";
import {
  parseFormData,
  parseFormFiles,
} from "./validate.js";

function handleAttachmentError(err: unknown): never {
  if (err instanceof SessionNotFoundError || err instanceof SessionAttachmentNotFoundError) {
    notFound(err.message);
  }
  if (err instanceof SessionAttachmentUploadError) badRequest(err.message);
  if (err instanceof SessionAttachmentPrunedError) throw new HttpError(410, err.message);
  throw err;
}

export function registerAttachmentRoutes(router: RouterGroup<RouteContext>) {
  router.post("/:sessionId/attachments", async (ctx) => {
    const sessionId = ctx.params.sessionId;

    try {
      const form = await parseFormData(ctx.req);
      const files = parseFormFiles(form, "files", { emptyMessage: "No files uploaded" });
      const sessions = new Sessions(ctx.state.sessions);
      const attachments = await sessions.uploadAttachments(sessionId, files);
      return Response.json({ attachments });
    } catch (err) {
      handleAttachmentError(err);
    }
  });

  router.get("/:sessionId/attachments/:attachmentId", async (ctx) => {
    const { sessionId, attachmentId } = ctx.params;

    try {
      const sessions = new Sessions(ctx.state.sessions);
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
  });
}
