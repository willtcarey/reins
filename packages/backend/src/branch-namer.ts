/**
 * Branch Name Generation
 *
 * Uses a lightweight Pi agent session (no tools) to generate clean git branch
 * names from task titles. Falls back to simple slugification if the LLM is
 * unavailable or returns invalid output.
 */

import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { resolveUtilityModelForCwd } from "./models/model-settings.js";
import { createPiResourceLoader } from "./pi/resource-loader.js";

const BRANCH_PATTERN = /^task\/[a-z0-9][a-z0-9-]*$/;
const TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT =
  "You generate git branch names. Given a task title, return ONLY a branch name in the format task/<slug>. " +
  "The slug should be lowercase, use hyphens for spaces, and be concise (2-5 words). " +
  "No explanation, no quotes, no backticks — just the branch name.";

/**
 * Generate a git branch name from a task title using the Pi SDK.
 * Creates a minimal throwaway session with no tools.
 */
export async function generateBranchName(title: string): Promise<string> {
  try {
    const cwd = process.cwd();
    const resourceLoader = createPiResourceLoader({
      cwd,
      systemPrompt: SYSTEM_PROMPT,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();

    const model = await resolveUtilityModelForCwd(cwd);
    const { session } = await createAgentSession({
      cwd,
      tools: [],
      model,
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
    });

    // prompt() returns when the agent turn is done
    const result = await Promise.race([
      session.prompt(title, { expandPromptTemplates: false }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT_MS)),
    ]);

    if (result === "timeout") {
      session.dispose();
      return slugifyBranchName(title);
    }

    const text = session.getLastAssistantText()?.trim().replace(/^["'`]+|["'`]+$/g, "") ?? "";
    session.dispose();

    if (BRANCH_PATTERN.test(text)) {
      return text;
    }
  } catch {
    // Session creation or prompt failed — fall through to slugify
  }

  return slugifyBranchName(title);
}

/**
 * Deterministic fallback: slugify a title into a branch name.
 */
export function slugifyBranchName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50)
    .replace(/-$/, "");

  return `task/${slug || "untitled"}`;
}
