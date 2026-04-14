/**
 * Branch Name Generation
 *
 * Uses the configured utility/default model runtime adapter one-shot ask path
 * to generate clean git branch names from task titles. Falls back to simple
 * slugification if the LLM is unavailable or returns invalid output.
 */

import { resolveUtilityModelConfig } from "./models/model-settings.js";
import { getRuntimeAdapter } from "./runtimes/registry.js";

const BRANCH_PATTERN = /^task\/[a-z0-9][a-z0-9-]*$/;
const TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT =
  "You generate git branch names. Given a task title, return ONLY a branch name in the format task/<slug>. " +
  "The slug should be lowercase, use hyphens for spaces, and be concise (2-5 words). " +
  "No explanation, no quotes, no backticks — just the branch name.";

/**
 * Generate a git branch name from a task title via runtime adapter ask().
 */
export async function generateBranchName(title: string): Promise<string> {
  try {
    const configuredModel = resolveUtilityModelConfig();
    const runtimeType = configuredModel?.runtimeType ?? "pi";

    const text = (await getRuntimeAdapter(runtimeType).ask({
      cwd: process.cwd(),
      prompt: title,
      model: configuredModel ? {
        provider: configuredModel.provider,
        modelId: configuredModel.modelId,
      } : undefined,
      thinkingLevel: configuredModel?.thinkingLevel,
      systemPrompt: SYSTEM_PROMPT,
      timeoutMs: TIMEOUT_MS,
    }))
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "");

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
