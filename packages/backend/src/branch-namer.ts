/**
 * Branch Name Generation
 *
 * Uses a fast LLM (Haiku) to generate clean git branch names from task titles.
 * Falls back to simple slugification if the LLM is unavailable or returns invalid output.
 */

import Anthropic from "@anthropic-ai/sdk";

const BRANCH_PATTERN = /^task\/[a-z0-9][a-z0-9\-]*$/;
const TIMEOUT_MS = 5000;

/**
 * Generate a git branch name from a task title.
 * Returns a name like `task/refactor-auth-middleware`.
 */
export async function generateBranchName(title: string): Promise<string> {
  try {
    const client = new Anthropic();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await client.messages.create(
        {
          model: "claude-haiku-4-0",
          max_tokens: 60,
          system:
            "You generate git branch names. Given a task title, return ONLY a branch name in the format task/<slug>. " +
            "The slug should be lowercase, use hyphens for spaces, and be concise (2-5 words). " +
            "No explanation, no quotes, no backticks — just the branch name.",
          messages: [{ role: "user", content: title }],
        },
        { signal: controller.signal },
      );
      clearTimeout(timeout);

      const text =
        response.content[0]?.type === "text"
          ? response.content[0].text.trim().replace(/^["'`]+|["'`]+$/g, "")
          : "";

      if (BRANCH_PATTERN.test(text)) {
        return text;
      }
    } catch {
      clearTimeout(timeout);
    }
  } catch {
    // SDK construction failed (no API key, etc.)
  }

  // Fallback: simple slugification
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
