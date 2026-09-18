import { readFile } from "node:fs/promises";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getDb } from "../../db.js";
import { resolveModel } from "../../models/model-settings.js";
import type { ReinsToolContext } from "../../tools/types.js";
import { ModelNotFoundError, type CreateAgentRuntimeParams } from "../registry.js";
import { buildReinsSystemPrompt } from "../system-prompt.js";
import { createAgentHarnessPiRuntime, type AgentHarnessPiRuntime } from "./agent-harness-runtime.js";
import { createPiContext } from "./factory.js";
import { toPiThinkingLevel } from "./utility.js";

/** Construct the registered AgentHarness-based Pi runtime from Reins runtime inputs. */
export async function buildAgentHarnessPiRuntime(
  params: CreateAgentRuntimeParams,
): Promise<AgentHarnessPiRuntime> {
  const builtinNames = new Set<string>(params.sessionTools?.builtins ?? ["read", "write", "edit", "bash"]);
  const customTools = params.sessionTools?.harnessTools ?? [];
  const { modelRuntime, resourceLoader } = await createPiContext({ cwd: params.projectDir });
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
  const db = getDb();
  const row = db.query<{ created_at: string; parent_session_id: string | null }, [string]>(
    "SELECT created_at, parent_session_id FROM sessions WHERE id = ?",
  ).get(params.sessionId);
  if (!row) throw new Error(`Unknown session: ${params.sessionId}`);

  const builtinTools: AgentHarnessTool<ReinsToolContext>[] = [
    createReadTool<ReinsToolContext>(),
    createWriteTool<ReinsToolContext>(),
    createEditTool<ReinsToolContext>(),
    createBashTool<ReinsToolContext>({
      prepare: (execution) => {
        execution.env.PI_SESSION_ID = params.sessionId;
        execution.env.PI_PROVIDER = sessionEnvironment.provider;
        execution.env.PI_MODEL = sessionEnvironment.modelId;
        if (sessionEnvironment.thinkingLevel) {
          execution.env.PI_REASONING_LEVEL = sessionEnvironment.thinkingLevel;
        } else {
          delete execution.env.PI_REASONING_LEVEL;
        }
      },
    }),
  ].filter((tool) => builtinNames.has(tool.name));
  const tools: AgentHarnessTool<ReinsToolContext>[] = [...builtinTools, ...customTools];
  const systemPrompt = buildReinsSystemPrompt({
    tools,
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      source: skill.sourceInfo.source,
      disableModelInvocation: skill.disableModelInvocation,
    })),
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
  const executionEnv = new NodeExecutionEnv({ cwd: params.projectDir });
  return await createAgentHarnessPiRuntime({
    db,
    sessionId: params.sessionId,
    createdAt: new Date(row.created_at).getTime(),
    cwd: params.projectDir,
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    options: { ...options, toolContext: { env: executionEnv } },
    sessionEnvironment,
    executionEnv,
    lifecycle: params.lifecycle,
  });
}
