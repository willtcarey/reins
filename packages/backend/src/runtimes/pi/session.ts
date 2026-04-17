import {
  createAgentSession,
  createCodingTools,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { loadMessagesForLLM } from "../../session-store.js";
import type { TaskRow } from "../../task-store.js";
import { buildReinsSystemPrompt } from "../system-prompt.js";
import { createPiContext } from "./factory.js";
import {
  parseThinkingLevel,
  resolveModel,
  resolveModelSettingWithConfigInRegistry,
} from "../../models/model-settings.js";

/** Map a Reins thinking level to one PI supports (PI's max is "xhigh"). */
export function toPiThinkingLevel(level: string): string {
  return level === "max" ? "xhigh" : level;
}
import {
  ModelNotFoundError,
  type AgentRuntime,
  type AgentRuntimeAdapter,
  type CreateAgentRuntimeParams,
  type RuntimeAskParams,
} from "../registry.js";
import { PiAgentRuntime } from "./runtime.js";
import { buildProviderList } from "./models-registry.js";

export function filterErrorMessages(messages: any[]): any[] {
  return messages.filter((m) => {
    if (
      m.role === "assistant" &&
      m.stopReason === "error" &&
      Array.isArray(m.content) &&
      m.content.length === 0
    ) {
      return false;
    }
    return true;
  });
}

export function hydrateSessionManager(sm: SessionManager, messages: any[]): void {
  for (const msg of messages) {
    if (msg.role === "compactionSummary") {
      sm.appendCompaction(msg.summary ?? "", sm.getLeafId() ?? "", 0);
    } else {
      sm.appendMessage(msg);
    }
  }
}

async function buildSessionOpts(params: {
  projectDir: string;
  task: TaskRow | null;
  model: CreateAgentRuntimeParams["model"];
  thinkingLevel: CreateAgentRuntimeParams["thinkingLevel"];
  sessionTools?: CreateAgentRuntimeParams["sessionTools"];
}) {
  const {
    projectDir,
    task,
    model,
    thinkingLevel,
    sessionTools,
  } = params;

  const sessionManager = SessionManager.inMemory();
  const builtins = sessionTools?.builtins ?? ["read", "write", "edit", "bash"];

  const builtInToolsByName = new Map(createCodingTools(projectDir).map((tool) => [tool.name, tool]));
  const tools = builtins
    .map((name) => builtInToolsByName.get(name))
    .filter((tool): tool is NonNullable<typeof tool> => !!tool);

  const customTools = sessionTools?.customTools ?? [];
  const allTools = [...tools, ...customTools];

  const { authStorage, resourceLoader, modelRegistry } = await createPiContext({
    cwd: projectDir,
    resourceLoaderOptions: {
      systemPromptOverride: () => buildReinsSystemPrompt({
        tools: allTools,
        task: task ?? undefined,
        isScratchSession: !task,
      }),
    },
  });

  const resolvedModel = model
    ? resolveModel(model.provider, model.modelId, modelRegistry)
    : undefined;

  if (model && !resolvedModel) {
    throw new ModelNotFoundError(model.provider, model.modelId);
  }

  const configuredThinkingLevel = thinkingLevel
    ? parseThinkingLevel(toPiThinkingLevel(thinkingLevel))
    : undefined;

  return {
    cwd: projectDir,
    tools,
    customTools,
    sessionManager,
    resourceLoader,
    modelRegistry,
    model: resolvedModel,
    configuredThinkingLevel,
    authStorage,
  };
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

async function createPiSessionRuntime(params: CreateAgentRuntimeParams): Promise<AgentRuntime> {
  const {
    projectDir,
    sessionId,
    task,
    model,
    thinkingLevel,
    sessionTools,
  } = params;

  const sessionOpts = await buildSessionOpts({
    projectDir,
    task,
    model,
    thinkingLevel,
    sessionTools,
  });

  const result = await createAgentSession(sessionOpts);
  const runtime = new PiAgentRuntime(result.session);
  const agentSession = runtime.session;

  if (result.extensionsResult.errors.length > 0) {
    console.warn("  Pi extension load errors:", result.extensionsResult.errors);
  }

  if (result.modelFallbackMessage) {
    console.warn(`  Model fallback: ${result.modelFallbackMessage}`);
  }

  if (sessionOpts.configuredThinkingLevel) {
    try {
      agentSession.setThinkingLevel(sessionOpts.configuredThinkingLevel);
    } catch (err) {
      console.warn(
        `  Failed to apply configured thinking level '${sessionOpts.configuredThinkingLevel}' for session ${sessionId}:`,
        err,
      );
    }
  }

  const messages = loadMessagesForLLM(sessionId);
  if (messages.length > 0) {
    hydrateSessionManager(agentSession.sessionManager, messages);
    agentSession.agent.replaceMessages(messages);
    console.log(`  Session hydrated: ${sessionId} (${messages.length} messages for LLM)`);
  }

  return runtime;
}

export class PiRuntimeAdapter implements AgentRuntimeAdapter {
  readonly runtimeType = "pi";

  async listModels() {
    return buildProviderList();
  }

  async ask(params: RuntimeAskParams): Promise<string> {
    const {
      cwd,
      prompt,
      model,
      thinkingLevel,
      systemPrompt,
      timeoutMs,
    } = params;

    const { authStorage, modelRegistry, resourceLoader } = await createPiContext({
      cwd,
      resourceLoaderOptions: {
        systemPrompt,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });

    const resolvedModel = model
      ? resolveModel(model.provider, model.modelId, modelRegistry)
      : resolveModelSettingWithConfigInRegistry("utility_model", modelRegistry)?.model
        ?? resolveModelSettingWithConfigInRegistry("default_model", modelRegistry)?.model;

    if (model && !resolvedModel) {
      throw new ModelNotFoundError(model.provider, model.modelId);
    }

    const { session } = await createAgentSession({
      cwd,
      tools: [],
      model: resolvedModel,
      authStorage,
      modelRegistry,
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
    });

    try {
      if (thinkingLevel) {
        session.setThinkingLevel(parseThinkingLevel(toPiThinkingLevel(thinkingLevel)));
      }

      return ephemeralPrompt(session, { prompt, timeoutMs });
    } finally {
      session.dispose();
    }
  }

  async createRuntime(params: CreateAgentRuntimeParams): Promise<AgentRuntime> {
    return createPiSessionRuntime(params);
  }
}
