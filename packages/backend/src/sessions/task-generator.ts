/**
 * Task Generator
 *
 * Parses a freeform user intent into a structured task by running it as a background session of the
 * task-generator kind (`sessions/session-kinds.ts`) on the server, with the utility model. The kind has
 * no tools, environment or checkout, so it needs no node. The session exists only for the request: its
 * runtime is closed and it is deleted once the reply is in or the wait gives up.
 */

import { slugifyBranchName } from "../branch-name.js";
import { createBroadcast } from "../models/broadcast.js";
import { resolveUtilityModelConfig } from "../models/model-settings.js";
import { Sessions } from "../models/sessions.js";
import type { Source } from "../node-store.js";
import { deleteSession } from "../session-store.js";
import type { AppState } from "../state.js";
import { createSession } from "./create-session.js";
import { TASK_GENERATOR_KIND } from "./session-kinds.js";
import { sessionRuns } from "./session-runs.js";
import { closeSessionRuntime } from "../session-runtime/live.js";

export interface GeneratedTask {
  title: string;
  description: string;
  branch_name: string;
}

/** Bound on the whole run, including opening the session's runtime. */
const TIMEOUT_MS = 30_000;

/**
 * Generate a structured task from freeform user input, in a session on `source`. Any failure to get a
 * usable reply (no model configured, too slow, a failed run, unparseable JSON) gives the deterministic
 * fallback.
 */
export async function generateTask(
  state: AppState,
  source: Pick<Source, "id" | "project_id">,
  prompt: string,
  { timeoutMs = TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<GeneratedTask> {
  // Invalid/inert persisted settings require an explicit user fix; only run and response-shape
  // failures use the deterministic fallback.
  const model = resolveUtilityModelConfig();
  if (!model) return fallback(prompt);

  const { id } = createSession(state, source.project_id, {
    kind: TASK_GENERATOR_KIND,
    background: true,
    sourceId: source.id,
    model: { provider: model.provider, modelId: model.modelId },
    thinkingLevel: model.thinkingLevel,
  });
  const deadline = Date.now() + timeoutMs;
  try {
    const broadcast = createBroadcast(state.process);
    const clientId = crypto.randomUUID();
    await new Sessions(state, broadcast).submit(id, { op: "prompt", content: [{ type: "text", text: prompt }], clientId });
    const settled = await sessionRuns({ broadcast, state }).waitForSettlement(id, Math.max(0, deadline - Date.now()), { inputs: [clientId] });
    if (settled.status === "completed" && settled.result) return parseTask(settled.result) ?? fallback(prompt);
  } catch {
    // Submission or wait failure — fall through
  } finally {
    await closeSessionRuntime(state.process, id);
    deleteSession(id);
  }
  return fallback(prompt);
}

/** The task in the model's reply, or null when it is not one. */
function parseTask(text: string): GeneratedTask | null {
  // Strip markdown fences if present
  const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { return null; }

  if (
    typeof parsed?.title === "string" && parsed.title.trim() &&
    typeof parsed.description === "string" &&
    typeof parsed.branch_name === "string"
  ) {
    return {
      title: parsed.title.trim(),
      description: parsed.description.trim(),
      branch_name: parsed.branch_name.trim() || slugifyBranchName(parsed.title),
    };
  }
  return null;
}

/** Simple fallback when the model gives no usable task. */
function fallback(prompt: string): GeneratedTask {
  // Use the raw prompt as the title (capped) and description
  const title = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
  return {
    title,
    description: prompt,
    branch_name: slugifyBranchName(prompt),
  };
}
