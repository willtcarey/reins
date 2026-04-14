import { createCodingTools } from "@mariozechner/pi-coding-agent";
import { query, type SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { buildReinsSystemPrompt } from "../system-prompt.js";
import { ReinsResourceLoader } from "../resource-loader.js";
import {
  type AgentRuntime,
  type AgentRuntimeAdapter,
  type AvailabilitySourceType,
  type CreateAgentRuntimeParams,
  type ProviderInfo,
  type RuntimeAskParams,
} from "../registry.js";
import { ClaudeSdkAgentRuntime, isThinkingDisabled, mapThinkingEffort } from "./runtime.js";
import CLAUDE_SDK_MODELS from "./models.json";

function resolvePromptTools(projectDir: string, params: CreateAgentRuntimeParams): import("@mariozechner/pi-coding-agent").ToolDefinition[] {
  const builtinNames = new Set(params.sessionTools?.builtins ?? ["read", "write", "edit", "bash"]);
  const builtins = createCodingTools(projectDir).filter((tool) => builtinNames.has(tool.name as any));
  return [...builtins, ...(params.sessionTools?.customTools ?? [])];
}

export class ClaudeSdkRuntimeAdapter implements AgentRuntimeAdapter {
  readonly runtimeType = "claude_agent_sdk";

  async listModels(): Promise<ProviderInfo[]> {
    const source: AvailabilitySourceType = "local";
    return [{
      provider: "claude_agent_sdk",
      isAvailable: true,
      availabilitySource: source,
      availabilitySources: [source],
      models: CLAUDE_SDK_MODELS,
    }];
  }

  async ask(params: RuntimeAskParams): Promise<string> {
    const handle = query({
      prompt: params.prompt,
      options: {
        cwd: params.cwd,
        tools: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        settings: { includeCoAuthoredBy: false },
        settingSources: [],
        strictMcpConfig: true,
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        ...(params.model?.modelId ? { model: params.model.modelId } : {}),
        thinking: isThinkingDisabled(params.thinkingLevel) ? { type: "disabled" as const } : { type: "enabled" as const },
        ...(isThinkingDisabled(params.thinkingLevel) ? {} : { effort: mapThinkingEffort(params.thinkingLevel) }),
      },
    });

    let resultText = "";
    for await (const message of handle) {
      if (message.type === "result" && message.subtype === "success") {
        resultText = (message as SDKResultSuccess).result;
      }
    }

    return resultText.trim();
  }

  async createRuntime(params: CreateAgentRuntimeParams): Promise<AgentRuntime> {
    const { task } = params;
    const tools = resolvePromptTools(params.projectDir, params);
    const resources = new ReinsResourceLoader({ cwd: params.projectDir });
    const systemPrompt = buildReinsSystemPrompt({
      tools,
      task: task ?? undefined,
      isScratchSession: !task,
      contextFiles: resources.contextFiles,
      skills: resources.skills,
    });

    return new ClaudeSdkAgentRuntime({
      sessionId: params.sessionId,
      projectDir: params.projectDir,
      systemPrompt,
      resumeOnFirstPrompt: Boolean(params.resume),
      model: params.model,
      thinkingLevel: params.thinkingLevel ?? null,
      customTools: params.sessionTools?.customTools ?? [],
    });
  }
}
