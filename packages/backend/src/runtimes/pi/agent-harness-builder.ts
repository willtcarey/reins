import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { getDb } from "../../db.js";
import { resolveModel } from "../../models/model-settings.js";
import type { CreateAgentRuntimeParams } from "../registry.js";
import { buildReinsSystemPrompt } from "../system-prompt.js";
import { projectCodingAgentResources } from "./agent-harness-resources.js";
import { adaptAgentTool } from "./agent-harness-tools.js";
import { createAgentHarnessPiRuntime, type AgentHarnessPiRuntime } from "./agent-harness-runtime.js";
import { createPiContext } from "./factory.js";
import { toPiThinkingLevel } from "./session.js";

/** Construct the unregistered AgentHarness-based Pi runtime from Reins runtime inputs. */
export async function buildAgentHarnessPiRuntime(
  params: CreateAgentRuntimeParams,
): Promise<AgentHarnessPiRuntime> {
  const builtinNames = params.sessionTools?.builtins ?? ["read", "write", "edit", "bash"];
  const customTools = params.sessionTools?.customTools ?? [];
  const { modelRuntime, resourceLoader } = await createPiContext({ cwd: params.projectDir });
  const model = params.model
    ? resolveModel(params.model.provider, params.model.modelId, modelRuntime)
    : undefined;
  if (!model) throw new Error(params.model
    ? `Model not found: ${params.model.provider}/${params.model.modelId}`
    : "AgentHarness Pi runtime requires an explicit model");

  const sessionEnvironment = {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: params.thinkingLevel ?? null,
  };
  const builtinTools = createCodingTools(params.projectDir, {
    bash: {
      spawnHook: (context) => ({
        ...context,
        env: {
          ...context.env,
          PI_SESSION_ID: params.sessionId,
          PI_PROVIDER: sessionEnvironment.provider,
          PI_MODEL: sessionEnvironment.modelId,
          ...(sessionEnvironment.thinkingLevel ? { PI_REASONING_LEVEL: sessionEnvironment.thinkingLevel } : {}),
        },
      }),
    },
  }).filter((tool) => builtinNames.some((name) => name === tool.name));
  const tools: AgentHarnessTool<undefined>[] = [
    ...builtinTools.map(adaptAgentTool),
    ...customTools.map(adaptAgentTool),
  ];
  const resources = await projectCodingAgentResources(resourceLoader);
  const systemPrompt = buildReinsSystemPrompt({
    tools,
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
    skills: resourceLoader.getSkills().skills.map((skill) => ({
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
  const row = getDb().query<{ created_at: string; parent_session_id: string | null }, [string]>(
    "SELECT created_at, parent_session_id FROM sessions WHERE id = ?",
  ).get(params.sessionId);
  if (!row) throw new Error(`Unknown session: ${params.sessionId}`);

  return createAgentHarnessPiRuntime({
    db: getDb(),
    sessionId: params.sessionId,
    createdAt: new Date(row.created_at).getTime(),
    cwd: params.projectDir,
    ...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
    options: {
      models: modelRuntime,
      model,
      thinkingLevel: params.thinkingLevel ? toPiThinkingLevel(params.thinkingLevel) : undefined,
      activeToolNames: tools.map((tool) => tool.name),
      tools,
      resources,
      systemPrompt,
    },
    sessionEnvironment,
  });
}
