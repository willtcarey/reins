import { getSession, listSessions, listPaletteItems, updateSessionMeta, updateActivityState, updateSessionMetadata } from "../session-store.js";
export { getSession, listSessions, listPaletteItems, updateSessionMeta, updateActivityState, updateSessionMetadata };
import { createSession as insertSession } from "../session-store.js";
import { defaultSourceOf } from "../models/sources.js";

/** Test convenience: production persistence requires an explicit source; by default the project's home. */
export const createSession = (id: string, projectId: number, opts: Omit<Parameters<typeof insertSession>[2], "sourceId"> & { sourceId?: number }) =>
  insertSession(id, projectId, { ...opts, sourceId: opts.sourceId ?? defaultSourceOf(projectId).id });
