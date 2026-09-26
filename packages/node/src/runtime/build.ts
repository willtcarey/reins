import { readFile } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, type AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { PiStorageAdapter } from "../pi-storage.js";
import type { NodeSessionBinding } from "../storage.js";
import { createPiContext } from "./context.js";
import { createHostTools, type HostToolContext } from "./tools.js";
import { createAgentHarnessPiRuntime, type AgentHarnessPiRuntime } from "./pi-runtime.js";
import type { AgentRuntimeEvent, RuntimeLifecycleSink } from "./types.js";
import { hydrateCachedPrompt } from "./attachments.js";
import { expandLocalPrompt } from "../resources/prompt.js";
import type { ContextFile, Skill } from "../resources/loader.js";

export interface NodeRuntimePolicy {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string | null;
  credentials: CredentialStore;
  customTools: AgentHarnessTool<HostToolContext>[];
  systemPrompt: (tools: AgentHarnessTool<HostToolContext>[], contextFiles: readonly ContextFile[], skills: readonly Skill[]) => string;
  lifecycle: RuntimeLifecycleSink;
  observe: (event: AgentRuntimeEvent) => void;
  onError?: (message: string, error: unknown) => void;
}

export class NodeModelNotFoundError extends Error {
  constructor(readonly provider: string, readonly modelId: string) {
    super(`Model not found: ${provider}/${modelId}`);
  }
}

const levels: Record<string, "minimal" | "low" | "medium" | "high" | "xhigh" | "max"> = {
  minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
};

/** Node assembles and opens Pi from its canonical storage and bound host resources. */
export async function buildNodeRuntime(sessionId: string, binding: NodeSessionBinding, storage: PiStorageAdapter, policy: NodeRuntimePolicy, db: Database): Promise<AgentHarnessPiRuntime> {
  const { modelRuntime, resourceLoader, resources: reinsResources } = await createPiContext({ cwd: binding.cwd, credentials: policy.credentials });
  const selected = policy.model;
  const model = selected ? modelRuntime.getModel(selected.provider, selected.modelId) : undefined;
  if (!model && selected) throw new NodeModelNotFoundError(selected.provider, selected.modelId);
  if (!model) throw new Error("AgentHarness Pi runtime requires an explicit model");
  const sessionEnvironment = { provider: model.provider, modelId: model.id, thinkingLevel: policy.thinkingLevel };
  const host = createHostTools({ cwd: binding.cwd, sessionId, builtins: ["read", "write", "edit", "bash"], sessionEnvironment });
  const tools: AgentHarnessTool<HostToolContext>[] = [...host.tools, ...policy.customTools];
  try {
    const skills = resourceLoader.getSkills().skills;
    const resources = {
      skills: await Promise.all(skills.map(async skill => ({
        name: skill.name, description: skill.description, content: await readFile(skill.filePath, "utf8"),
        filePath: skill.filePath, disableModelInvocation: skill.disableModelInvocation,
      }))),
      promptTemplates: resourceLoader.getPrompts().prompts.map(prompt => ({
        name: prompt.name, description: prompt.description, content: prompt.content,
      })),
    };
    const thinkingLevel = policy.thinkingLevel ? levels[policy.thinkingLevel] : undefined;
    if (policy.thinkingLevel && !thinkingLevel) throw new Error(`Invalid thinking level: ${policy.thinkingLevel}`);
    const runtime = await createAgentHarnessPiRuntime({
      storage, sessionId, createdAt: Date.parse(binding.createdAt), cwd: binding.cwd,
      ...(binding.parentSessionId ? { parentSessionId: binding.parentSessionId } : {}),
      options: {
        models: modelRuntime, model, thinkingLevel, tools, activeToolNames: tools.map(tool => tool.name), resources,
        systemPrompt: policy.systemPrompt(tools, reinsResources.contextFiles, reinsResources.skills),
        toolContext: { env: host.executionEnv },
      },
      sessionEnvironment, executionEnv: host.executionEnv, lifecycle: policy.lifecycle,
      hydratePrompt: (id, content) => hydrateCachedPrompt(db, id, content), onError: policy.onError,
    });
    const prompt = runtime.prompt.bind(runtime);
    const steer = runtime.steer.bind(runtime);
    runtime.prompt = (content, options) => prompt(expandLocalPrompt(content, binding.cwd).expanded, options);
    runtime.steer = (content, options) => steer(expandLocalPrompt(content, binding.cwd).expanded, options);
    const detach = runtime.subscribe(policy.observe);
    const close = runtime.close.bind(runtime);
    runtime.close = async () => { try { await close(); } finally { detach(); } };
    return runtime;
  } catch (error) {
    await host.executionEnv.cleanup(BACKGROUND_CONTEXT);
    throw error;
  }
}
