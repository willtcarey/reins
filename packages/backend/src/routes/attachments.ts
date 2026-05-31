import type { RouterGroup, RouteContext } from "../router.js";
import { badRequest, notFound, HttpError } from "../errors.js";
import { getSession } from "../session-store.js";
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  getSessionAttachment,
  storeSessionAttachment,
} from "../session-attachments-store.js";

function requireSession(sessionId: string): void {
  if (!getSession(sessionId)) notFound("Session not found");
}

function fileName(file: File): string | undefined {
  const name = file.name?.trim();
  return name ? name : undefined;
}

export function registerAttachmentRoutes(router: RouterGroup<RouteContext>) {
  router.post("/:sessionId/attachments", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    requireSession(sessionId);

    const form = await ctx.req.formData().catch(() => null);
    if (!form) badRequest("Expected multipart/form-data");

    const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) badRequest("No files uploaded");

    let totalBytes = 0;
    const attachments = [];
    for (const file of files) {
      const bytes = Buffer.from(await file.arrayBuffer());
      totalBytes += bytes.length;
      if (totalBytes > MAX_PROMPT_ATTACHMENT_BYTES) {
        badRequest(`Attachments exceed ${MAX_PROMPT_ATTACHMENT_BYTES} byte prompt limit`);
      }

      try {
        attachments.push(storeSessionAttachment(sessionId, {
          data: bytes,
          mimeType: file.type,
          filename: fileName(file),
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid attachment";
        badRequest(message);
      }
    }

    return Response.json({ attachments });
  });

  router.get("/:sessionId/attachments/:attachmentId", async (ctx) => {
    const { sessionId, attachmentId } = ctx.params;
    requireSession(sessionId);

    const row = getSessionAttachment(sessionId, attachmentId);
    if (!row) notFound("Attachment not found");
    if (!row.data) throw new HttpError(410, "Attachment data has been pruned");

    const body = new Uint8Array(row.data);
    return new Response(body, {
      headers: {
        "Content-Type": row.mime_type,
        "Content-Length": String(row.data.length),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  });
}
