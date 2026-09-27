import { readFile } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT, type AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { PiStorageAdapter } from "../pi-storage.js";
import type { NodeSessionBinding } from "../storage.js";
import { createPiContext } from "./context.js";
import { createHostTools, type HostToolContext } from "./tools.js";
import { createReinsTools, type ReinsToolCalls } from "./reins-tools.js";
import { createAgentHarnessPiRuntime, type AgentHarnessPiRuntime } from "./pi-runtime.js";
import type { AgentRuntimeEvent, RuntimeLifecycleSink, RuntimeMessage } from "./types.js";
import type { FinalReply, SessionSettled } from "../protocol/schema.js";
import type { NodeSessionTask } from "../storage.js";
import { NodeModelNotFoundError } from "./types.js";
import { piThinkingLevel, storedLaneModel } from "./lane.js";
import { hydrateCachedPrompt } from "./attachments.js";
import { toolImageReferences } from "./tool-images.js";
import { expandLocalPrompt } from "../resources/prompt.js";
import { buildReinsSystemPrompt } from "./system-prompt.js";

/** What the node needs to build a session's runtime: the provisioned task snapshot (null: scratch)
 * and the node's credential store (served by the server over the connection; see `credentials.ts`). The model
 * selection is Pi's own lane state; `model` only overrides it for this open (`session.setModel`
 * validates and seeds with the new model, which the caller then persists through the runtime). */
export interface NodeRuntimePolicy {
  task: NodeSessionTask | null;
  credentials: CredentialStore;
  model?: { provider: string; modelId: string; thinkingLevel?: string | null };
}

/** Receives this session's live runtime events in order (best effort). */
export type EmitSessionEvent = (event: AgentRuntimeEvent) => void;
export type { FinalReply };
export type SettledReport = Omit<SessionSettled, "sessionId">;
/** Durable run lifecycle for one session. A settlement with `final` is recorded at once, holding its
 * place (and every later report) until `final` resolves with the child's reply or `replyError`. */
export interface ReportLifecycle {
  started(runId: string): void;
  settled(report: SettledReport, final?: Promise<SettledReport>): void;
}

export function finalReply(messages: readonly RuntimeMessage[]): FinalReply | null {
  const last = messages.findLast(message => message.role === "assistant");
  if (!last) return null;
  return {
    text: Array.isArray(last.content) ? last.content.filter(block => block.type === "text").map(block => String(block.text)).join("\n") : null,
    stopReason: last.stopReason ?? null,
    errorMessage: last.errorMessage == null ? null : String(last.errorMessage),
  };
}

/** Run lifecycle as durable reports: settlement carries the runtime facts the server needs, so no live runtime crosses. */
function lifecycleReports(binding: NodeSessionBinding, report: ReportLifecycle, onError: (message: string, error: unknown) => void): RuntimeLifecycleSink {
  return {
    started: runId => report.started(runId),
    settled: (runtime, { runId, status, error }) => {
      const { model, thinkingLevel } = runtime.getSessionMetadata();
      const settled: SettledReport = {
        runId, status,
        ...(error ? { error: { ...(error.code ? { code: error.code } : {}), message: error.message } } : {}),
        metadata: { model: model?.provider && model.modelId ? { provider: model.provider, modelId: model.modelId } : null, thinkingLevel: thinkingLevel ?? null },
        reply: null,
      };
      // Only a parent consumes the final reply, so only child sessions read the transcript.
      if (!binding.parentSessionId) return report.settled(settled);
      report.settled(settled, runtime.getMessages().then(
        messages => ({ ...settled, reply: finalReply(messages) }),
        (failure: unknown) => {
          onError(`Failed to read final reply for ${runId}:`, failure);
          return { ...settled, replyError: failure instanceof Error ? failure.message : String(failure) };
        },
      ));
    },
  };
}

export { NodeModelNotFoundError };

/** Node assembles and opens Pi from its canonical storage and bound host resources. All agent tools
 * run here; Reins application tools reach the server only through the session-bound `calls`. */
export async function buildNodeRuntime(sessionId: string, binding: NodeSessionBinding, storage: PiStorageAdapter, policy: NodeRuntimePolicy, db: Database, emit: EmitSessionEvent, report: ReportLifecycle, calls: ReinsToolCalls): Promise<AgentHarnessPiRuntime> {
  const { modelRuntime, resourceLoader, resources: reinsResources } = await createPiContext({ cwd: binding.cwd, credentials: policy.credentials });
  // Pi's lane (created at provision) owns the model selection; it is validated here before Pi opens.
  const selected = policy.model ?? await storedLaneModel(storage);
  if (!selected) throw new Error("AgentHarness Pi runtime requires an explicit model");
  const model = modelRuntime.getModel(selected.provider, selected.modelId);
  if (!model) throw new NodeModelNotFoundError(selected.provider, selected.modelId);
  // Only seeds a lane Pi has not created yet; an existing lane's thinking level is restored.
  const thinkingLevel = piThinkingLevel(selected.thinkingLevel);
  const sessionEnvironment = { provider: model.provider, modelId: model.id, thinkingLevel: thinkingLevel === "off" ? null : thinkingLevel };
  const host = createHostTools({ cwd: binding.cwd, sessionId, builtins: ["read", "write", "edit", "bash"], sessionEnvironment });
  const tools: AgentHarnessTool<HostToolContext>[] = [...host.tools, ...createReinsTools(calls)];
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
    const runtime = await createAgentHarnessPiRuntime({
      storage, sessionId, createdAt: Date.parse(binding.createdAt), cwd: binding.cwd,
      ...(binding.parentSessionId ? { parentSessionId: binding.parentSessionId } : {}),
      options: {
        models: modelRuntime, model, thinkingLevel, tools, activeToolNames: tools.map(tool => tool.name), resources,
        systemPrompt: buildReinsSystemPrompt({
          tools, contextFiles: reinsResources.contextFiles, skills: reinsResources.skills,
          task: policy.task ? { title: policy.task.title, description: policy.task.description } : undefined,
          isScratchSession: !policy.task,
        }),
        toolContext: { env: host.executionEnv },
      },
      sessionEnvironment, executionEnv: host.executionEnv, lifecycle: lifecycleReports(binding, report, console.error),
      hydratePrompt: (id, content) => hydrateCachedPrompt(db, id, content),
      referenceToolImages: toolImageReferences(db, sessionId), onError: console.error,
    });
    const prompt = runtime.prompt.bind(runtime);
    const steer = runtime.steer.bind(runtime);
    runtime.prompt = (content, options) => prompt(expandLocalPrompt(content, binding.cwd).expanded, options);
    runtime.steer = (content, options) => steer(expandLocalPrompt(content, binding.cwd).expanded, options);
    const detach = runtime.subscribe(emit);
    const close = runtime.close.bind(runtime);
    runtime.close = async () => { try { await close(); } finally { detach(); } };
    return runtime;
  } catch (error) {
    await host.executionEnv.cleanup(BACKGROUND_CONTEXT);
    throw error;
  }
}
