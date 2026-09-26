import { readFile } from "node:fs/promises";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { createHostTools } from "@reins/node/host-tools";
import { getDb } from "../../db.js";
import { resolveModel } from "../../models/model-settings.js";
import type { ReinsToolContext } from "../../tools/types.js";
import { ModelNotFoundError, type CreateAgentRuntimeParams } from "../registry.js";
import { buildReinsSystemPrompt } from "@reins/node/system-prompt";
import { createAgentHarnessPiRuntime, type AgentHarnessPiRuntime } from "@reins/node/pi-runtime";
import { PiStorageAdapter } from "./storage-adapter.js";
import { hydratePromptContent } from "../../session-attachments-store.js";
import { logger } from "../../logger.js";
import { createPiContext } from "./factory.js";
import { toPiThinkingLevel } from "./utility.js";

/** Construct the registered AgentHarness-based Pi runtime from Reins runtime inputs. */
export async function buildAgentHarnessPiRuntime(
  params: CreateAgentRuntimeParams,
): Promise<AgentHarnessPiRuntime> {
  const customTools = params.sessionTools?.harnessTools ?? [];
  const { modelRuntime, resourceLoader, resources: reinsResources } = await createPiContext({ cwd: params.projectDir });
  const model = params.model
    ? resolveModel(params.model.provider, params.model.modelId, modelRuntime)
    : undefined;
  if (!model && params.model) throw new ModelNotFoundError(params.model.provider, params.model.modelId);
  if (!model) throw new Error("AgentHarness Pi runtime requires an explicit model");

  const sessionEnvironment = {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: params.thinkingLevel ?? null,
  };
  const skills = resourceLoader.getSkills().skills;
  const resources = {
    skills: await Promise.all(skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      content: await readFile(skill.filePath, "utf8"),
      filePath: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
    }))),
    promptTemplates: resourceLoader.getPrompts().prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      content: prompt.content,
    })),
  };
  const row = getDb().query<{ created_at: string; parent_session_id: string | null; storage_owner: string }, [string]>(
    "SELECT created_at, parent_session_id, storage_owner FROM sessions WHERE id = ?",
  ).get(params.sessionId);
  if (!row) throw new Error(`Unknown session: ${params.sessionId}`);
  if (row.storage_owner === "internal-node") throw new Error(`Node-owned sessions open on the node`);

  const host = createHostTools({
    cwd: params.projectDir,
    sessionId: params.sessionId,
    builtins: params.sessionTools?.builtins ?? ["read", "write", "edit", "bash"],
    sessionEnvironment,
  });
  const tools: AgentHarnessTool<ReinsToolContext>[] = [...host.tools, ...customTools];
  const systemPrompt = buildReinsSystemPrompt({
    tools,
    contextFiles: reinsResources.contextFiles,
    skills: reinsResources.skills,
    task: params.task ?? undefined,
    isScratchSession: !params.task,
  });
  const options = {
    models: modelRuntime,
    model,
    thinkingLevel: params.thinkingLevel ? toPiThinkingLevel(params.thinkingLevel) : undefined,
    activeToolNames: tools.map((tool) => tool.name),
    tools,
    resources,
    systemPrompt,
  };
  const executionEnv = host.executionEnv;
  return await createAgentHarnessPiRuntime({
    storage: new PiStorageAdapter(getDb(), params.sessionId),
    sessionId: params.sessionId,
    createdAt: new Date(row.created_at).getTime(),
    cwd: params.projectDir,
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    options: { ...options, toolContext: { env: executionEnv } },
    sessionEnvironment,
    executionEnv,
    lifecycle: params.lifecycle,
    hydratePrompt: hydratePromptContent,
    onError: (message, error) => logger.error(message, error),
  });
}
