import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  resolveModel,
  resolveModelSettingWithConfigInRuntime,
} from "../../models/model-settings.js";
import { ModelNotFoundError, type RuntimeAskParams } from "../registry.js";
import { createPiContext } from "./factory.js";

const PI_THINKING_LEVELS: Record<string, PiThinkingLevel> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** Map a Reins thinking level to Pi's native level. */
export function toPiThinkingLevel(level: string): PiThinkingLevel {
  const mapped = PI_THINKING_LEVELS[level];
  if (!mapped) {
    throw new Error(
      `Invalid thinking level '${level}'. Valid levels: ${Object.keys(PI_THINKING_LEVELS).join(", ")}`,
    );
  }
  return mapped;
}

export async function ephemeralPrompt(
  session: AgentSession,
  params: { prompt: string; timeoutMs?: number },
): Promise<string> {
  const { prompt, timeoutMs } = params;

  if (timeoutMs && timeoutMs > 0) {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const promptPromise = session.prompt(prompt, { expandPromptTemplates: false });
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    try {
      const result = await Promise.race([
        promptPromise.then(() => "completed" as const),
        timeoutPromise,
      ]);

      if (result === "timeout") {
        void session.abort().catch(() => undefined);
        void promptPromise.catch(() => undefined);
        return "";
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  } else {
    await session.prompt(prompt, { expandPromptTemplates: false });
  }

  return session.getLastAssistantText()?.trim() ?? "";
}

/** Run a one-shot utility prompt without creating a persisted Reins session. */
export async function askWithPi(params: RuntimeAskParams): Promise<string> {
  const {
    cwd,
    prompt,
    model,
    thinkingLevel,
    systemPrompt,
    timeoutMs,
  } = params;

  const { modelRuntime, resourceLoader } = await createPiContext({
    cwd,
    resourceLoaderOptions: {
      systemPrompt,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });

  const resolvedModel = model
    ? resolveModel(model.provider, model.modelId, modelRuntime)
    : resolveModelSettingWithConfigInRuntime("utility_model", modelRuntime)?.model
      ?? resolveModelSettingWithConfigInRuntime("default_model", modelRuntime)?.model;

  if (model && !resolvedModel) {
    throw new ModelNotFoundError(model.provider, model.modelId);
  }

  const { session } = await createAgentSession({
    cwd,
    tools: [],
    model: resolvedModel,
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    resourceLoader,
  });

  try {
    if (thinkingLevel) session.setThinkingLevel(toPiThinkingLevel(thinkingLevel));
    return ephemeralPrompt(session, { prompt, timeoutMs });
  } finally {
    session.dispose();
  }
}
