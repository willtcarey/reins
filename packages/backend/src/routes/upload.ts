/**
 * File upload into a session's checkout (the file browser's Upload): multipart/form-data with one or more
 * files under "files", into the folder `?path=` (the checkout's root without it), on its node
 * (`SourceModel.writeFiles`, `fs.write`).
 */

import type { RouterGroup } from "../router.js";
import type { SessionRouteContext } from "./index.js";
import { badRequest } from "../errors.js";
import {
  NoFilesError,
  InvalidFilenameError,
  FileWriteRefusedError,
} from "../models/sources.js";

export function registerUploadRoutes(router: RouterGroup<SessionRouteContext>) {
  router.post("/upload", async (ctx) => {
    const formData = await ctx.req.formData();
    const files = formData.getAll("files").filter(
      (f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f,
    );

    const subPath = ctx.url.searchParams.get("path") ?? "";

    try {
      const result = await ctx.session.source.writeFiles(
        files.map((f) => ({ name: f.name, data: f })),
        subPath,
      );
      return Response.json(result);
    } catch (err) {
      if (
        err instanceof FileWriteRefusedError ||
        err instanceof NoFilesError ||
        err instanceof InvalidFilenameError
      ) {
        badRequest(err.message);
      }
      throw err;
    }
  });
}
