import { readFile } from "node:fs/promises";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, type AgentHarnessTool, type Storage } from "@earendil-works/pi-agent-core";
import { createPiContext } from "./context.js";
import { createHostTools, type HostToolContext } from "./tools.js";
import { createReinsTools } from "./reins-tools.js";
import { createAgentHarnessPiRuntime, type AgentHarnessPiRuntime } from "./pi-runtime.js";
import type { RuntimeLifecycleSink } from "./types.js";
import type { PauseGate } from "./pause-gate.js";
import { NodeRejection, type AgentRuntimeEvent, type LaneSeed, type NodeSessionBinding, type ReinsToolCalls, type SessionRuntime, type SessionSettled } from "@reins/node-protocol";
import { NodeModelNotFoundError } from "./types.js";
import { piThinkingLevel, storedLaneModel } from "./lane.js";
import type { ReferenceToolImages } from "./tool-images.js";
import type { ClientPromptContent } from "./types.js";
import type { hydratePrompt } from "../node-attachments.js";
import { expandLocalPrompt } from "../resources/prompt.js";
import { environmentPrompt } from "./system-prompt.js";

/** What the node needs to build a session's runtime: the runtime configuration and lane seed the opening
 * command carried and the node's credential store (served by the server over the
 * connection; see `credentials.ts`). The model selection is Pi's own lane state; the seed only creates a
 * lane the session does not have yet, and `model` overrides both for this open (`session.setModel`
 * validates with the new model, which the caller then persists through the runtime). */
export interface NodeRuntimePolicy {
  runtime: SessionRuntime;
  lane: LaneSeed;
  credentials: CredentialStore;
  model?: { provider: string; modelId: string; thinkingLevel?: string | null };
  /** The node's gate: holds the runtime's runs at their pause points while the node pauses. */
  pauseGate?: PauseGate;
}

/** Receives this session's live runtime events in order (best effort). */
export type EmitSessionEvent = (event: AgentRuntimeEvent) => void;
/** The session's attachments as the runtime sees them: provider hydration of references, and the
 * conversion of tool-result images to references (see `tool-images.ts`). */
export interface RuntimeAttachments {
  hydratePrompt(sessionId: string, content: ClientPromptContent): ReturnType<typeof hydratePrompt>;
  referenceToolImages: ReferenceToolImages;
}
type SettledReport = Omit<SessionSettled, "sessionId" | "reportId">;
/** Run lifecycle for one session, reported to the server in occurrence order. */
export interface ReportLifecycle {
  started(runId: string): void;
  settled(report: SettledReport): void;
}

/** Run lifecycle as reports: settlement carries the runtime facts the server needs, so no live runtime crosses. */
function lifecycleReports(report: ReportLifecycle): RuntimeLifecycleSink {
  return {
    started: runId => report.started(runId),
    settled: (runtime, { runId, tipId, status, error }) => {
      const { model, thinkingLevel } = runtime.getSessionMetadata();
      const settled: SettledReport = {
        runId, tipId, status,
        ...(error ? { error: { ...(error.code ? { code: error.code } : {}), message: error.message } } : {}),
        metadata: { model: model?.provider && model.modelId ? { provider: model.provider, modelId: model.modelId } : null, thinkingLevel: thinkingLevel ?? null },
      };
      report.settled(settled);
    },
  };
}

export { NodeModelNotFoundError };

/** Node assembles and opens Pi over the session's storage on the server and bound host resources. All
 * agent tools run here; Reins application tools reach the server only through the session-bound `calls`.
 * Every tool is registered; the model is offered the ones the runtime configuration names (all when it
 * names none), and its system prompt is the server's, followed by the node's environment when asked. */
export async function buildNodeRuntime(sessionId: string, binding: NodeSessionBinding, storage: Storage, policy: NodeRuntimePolicy, attachments: RuntimeAttachments, emit: EmitSessionEvent, report: ReportLifecycle, calls: ReinsToolCalls): Promise<AgentHarnessPiRuntime> {
  const { modelRuntime, resourceLoader, resources: reinsResources } = await createPiContext({ cwd: binding.cwd, credentials: policy.credentials });
  // Pi's lane owns the model selection; it is validated here before Pi opens. A session without a lane
  // yet (it never ran) gets one seeded from the command's lane seed when Pi opens it below.
  const seed = policy.lane.model ? { ...policy.lane.model, thinkingLevel: policy.lane.thinkingLevel } : null;
  const selected = policy.model ?? await storedLaneModel(storage) ?? seed;
  if (!selected) throw new Error("AgentHarness Pi runtime requires an explicit model");
  const model = modelRuntime.getModel(selected.provider, selected.modelId);
  if (!model) throw new NodeModelNotFoundError(selected.provider, selected.modelId);
  // An existing lane's thinking level is restored; this only seeds one Pi has not created.
  const thinkingLevel = piThinkingLevel(selected.thinkingLevel);
  const sessionEnvironment = { provider: model.provider, modelId: model.id, thinkingLevel: thinkingLevel === "off" ? null : thinkingLevel };
  const host = createHostTools({ cwd: binding.cwd, sessionId, sessionEnvironment });
  const tools: AgentHarnessTool<HostToolContext>[] = [...host.tools, ...createReinsTools(calls)];
  try {
    const activeToolNames = policy.runtime.tools ?? tools.map(tool => tool.name);
    const unknown = activeToolNames.filter(name => !tools.some(tool => tool.name === name));
    if (unknown.length > 0) throw new NodeRejection("invalid_request", `Unknown tools: ${unknown.join(", ")}`);
    const activeTools = activeToolNames.map(name => tools.find(tool => tool.name === name)!);
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
    const runtime = await createAgentHarnessPiRuntime({
      storage, sessionId, createdAt: Date.parse(binding.createdAt), cwd: binding.cwd,
      ...(binding.parentSessionId ? { parentSessionId: binding.parentSessionId } : {}),
      options: {
        models: modelRuntime, model, thinkingLevel, tools, activeToolNames, resources,
        systemPrompt: policy.runtime.environment
          ? policy.runtime.systemPrompt + environmentPrompt({ tools: activeTools, contextFiles: reinsResources.contextFiles, skills: reinsResources.skills })
          : policy.runtime.systemPrompt,
        toolContext: { env: host.executionEnv },
      },
      sessionEnvironment, executionEnv: host.executionEnv, lifecycle: lifecycleReports(report),
      hydratePrompt: attachments.hydratePrompt,
      expandPrompt: content => expandLocalPrompt(content, binding.cwd), emit,
      referenceToolImages: attachments.referenceToolImages, ...(policy.pauseGate ? { pauseGate: policy.pauseGate } : {}), onError: console.error,
    });
    return runtime;
  } catch (error) {
    await host.executionEnv.cleanup(BACKGROUND_CONTEXT);
    throw error;
  }
}
