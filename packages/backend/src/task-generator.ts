/**
 * Task Generator
 *
 * Uses a lightweight Pi agent session to parse a freeform user intent
 * into a structured task (title, description, branch name).
 */

import { createAgentSession, SessionManager, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { slugifyBranchName } from "./branch-namer.js";

export interface GeneratedTask {
  title: string;
  description: string;
  branch_name: string;
}

const TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `You parse user intent into a structured task definition. Given a freeform description of what someone wants to do, return a JSON object with exactly these fields:

- "title": A concise task title (3-5 words, imperative mood, e.g. "Add dark mode support")
- "description": A brief description expanding on the intent with actionable detail (1-3 sentences). Include relevant context the user implied but didn't spell out. This is shown to a coding agent as context for what it should work on.
- "branch_name": A git branch name in task/<slug> format (lowercase, hyphens, 2-5 words in the slug)

Return ONLY valid JSON. No markdown fences, no explanation, no extra text.`;

/**
 * Generate a structured task from freeform user input.
 */
export async function generateTask(prompt: string): Promise<GeneratedTask> {
  try {
    const resourceLoader = new DefaultResourceLoader({
      systemPrompt: SYSTEM_PROMPT,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      tools: [],
      model: getModel("anthropic", "claude-haiku-4-5"),
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
    });

    const result = await Promise.race([
      session.prompt(prompt, { expandTemplates: false }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT_MS)),
    ]);

    if (result === "timeout") {
      session.dispose();
      return fallback(prompt);
    }

    const text = session.getLastAssistantText()?.trim() ?? "";
    session.dispose();

    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();

    const parsed = JSON.parse(cleaned);

    if (
      typeof parsed.title === "string" && parsed.title.trim() &&
      typeof parsed.description === "string" &&
      typeof parsed.branch_name === "string"
    ) {
      return {
        title: parsed.title.trim(),
        description: parsed.description.trim(),
        branch_name: parsed.branch_name.trim() || slugifyBranchName(parsed.title),
      };
    }
  } catch {
    // Parse or session failure — fall through
  }

  return fallback(prompt);
}

/** Simple fallback when the LLM is unavailable. */
function fallback(prompt: string): GeneratedTask {
  // Use the raw prompt as the title (capped) and description
  const title = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
  return {
    title,
    description: prompt,
    branch_name: slugifyBranchName(prompt),
  };
}
