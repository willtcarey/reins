/**
 * The `beforeRun` hooks (`reins.sessions.beforeRun`, docs/dev/server-sdk.md *Sessions*), as the current app runs
 * them for a runtime before a run (`App.beforeRun`).
 */
import type { BeforeRunHook, MessageBlock, MessageContent } from "@reins/sdk/server";
import type { AppState, BeforeRunCall, RunInput } from "../../state.js";
import { Models } from "../../models/models.js";
import { getSessionAttachment } from "../../session-attachments-store.js";
import { getSession } from "../../session-store.js";
import { getTask } from "../../task-store.js";
import { taskInfo } from "../../sdk-host/projects.js";
import { checkContent, sessionInfo, storeImages } from "../../sdk-host/sessions.js";
import { coreSessionHooks } from "./core.js";

/** Where an input's hidden blocks begin, and their label (`metadata.details`). */
function detailsOf(input: RunInput): { start: number; label: string | null } | null {
  const details = input.metadata.details;
  if (typeof details !== "object" || details === null || !("start" in details) || typeof details.start !== "number") return null;
  const label = "label" in details && typeof details.label === "string" ? details.label : null;
  return { start: details.start, label };
}

/** The input as a hook gets it: its images read back from the session's attachments. */
function messageOf(sessionId: string, input: RunInput): MessageContent {
  const details = detailsOf(input);
  return input.content.map((block, index): MessageBlock => {
    if (block.type === "image") {
      const stored = getSessionAttachment(sessionId, block.attachmentId);
      if (!stored?.data) throw new Error(`The run's image ${block.attachmentId} is no longer stored`);
      return { image: { data: new Uint8Array(stored.data), mimeType: stored.mime_type, ...(stored.filename ? { filename: stored.filename } : {}) } };
    }
    if (!details || index < details.start) return block.text;
    return { text: block.text, hidden: true, ...(index === details.start && details.label ? { label: details.label } : {}) };
  });
}

/** Runs the hooks in their fixed order (Reins' own first, `coreSessionHooks`, then the extensions'), each on the
 * message the one before returned, and gives the input that
 * replaces the run's: its images stored as the session's, its hidden blocks marked, and the original's other
 * metadata (who sent it) kept; null when no hook replaced it. A hook's throw rejects with its message. */
export async function runBeforeRun(state: AppState, { sessionId, tools, input, signal }: BeforeRunCall): Promise<RunInput | null> {
  const hooks: readonly { extension: string | null; hook: BeforeRunHook }[] = [
    ...coreSessionHooks(state.process).beforeRun.map(hook => ({ extension: null, hook })),
    ...await state.extensions.sessionHooks("beforeRun"),
  ];
  const row = getSession(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  const session = sessionInfo({ models: new Models(state), caller: { kind: "extension", name: "reins" } }, row);
  const task = row.task_id === null ? null : getTask(row.task_id);
  let message: MessageContent | null = input && messageOf(sessionId, input);
  let replaced = false;
  for (const { extension, hook } of hooks) {
    signal.throwIfAborted();
    const result = await hook({ session, task: task && taskInfo(task), tools, message, signal });
    if (result === undefined) continue;
    if (message === null) {
      if (extension !== null) state.extensions.reportError(extension, new Error("Its beforeRun hook returned a message for a run that resumes, which has none: it was left out"));
      continue;
    }
    message = result;
    replaced = true;
  }
  if (!input || !replaced || message === null) return null;
  const checked = await checkContent(message, "A run's message must not be blank").catch((error: unknown) => {
    throw new Error(`A beforeRun hook's message was refused: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  });
  const { content, details } = storeImages(sessionId, checked);
  const { details: _replacedDetails, ...metadata } = input.metadata;
  return { content, metadata: { ...metadata, ...(details ? { details: { label: details.label, start: details.start } } : {}) } };
}
