import {
  createAgentSession,
  createCodingTools,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { ServerState } from "../../state.js";
import {
  loadMessagesForLLM,
  persistMessages,
  updateSessionMeta,
} from "../../session-store.js";
import { getTask, type TaskRow } from "../../task-store.js";
import { checkoutBranch } from "../../git.js";
import { buildReinsSystemPrompt } from "../system-prompt.js";
import { createPiContext } from "./factory.js";
import {
  parseThinkingLevel,
  resolveModel,
} from "../../models/model-settings.js";
import { createBroadcast, type Broadcast } from "../../models/broadcast.js";
import {
  ModelNotFoundError,
  type AgentRuntime,
  type AgentRuntimeAdapter,
  type CreateAgentRuntimeParams,
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

async function resolveTask(
  taskId: number | null,
  projectDir: string,
): Promise<TaskRow | null> {
  if (!taskId) return null;
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  await checkoutBranch(projectDir, task.branch_name);
  return task;
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
    ? parseThinkingLevel(thinkingLevel)
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

function logCompactionState(sessionId: string, session: AgentSession): void {
  try {
    const sm = session.sessionManager;
    const branch = sm.getBranch();
    const entries = branch.map((entry) => {
      if (entry.type === "message") {
        const message = entry.message as { role?: string; content?: unknown; summary?: string };
        return {
          type: entry.type,
          role: message.role,
          contentPreview: JSON.stringify(message.content ?? message.summary)?.slice(0, 100),
        };
      }

      return {
        type: entry.type,
        role: undefined,
        contentPreview: entry.type === "compaction" ? entry.summary?.slice(0, 100) : undefined,
      };
    });
    console.log(`  Compaction starting for ${sessionId}:`);
    console.log(`    SessionManager branch: ${branch.length} entries`);
    console.log(`    Agent messages: ${session.messages?.length ?? "N/A"}`);
    console.log("    Entries:", JSON.stringify(entries, null, 2));
  } catch (err) {
    console.error(`  Failed to log compaction state for ${sessionId}:`, err);
  }
}

function handleCompactionEnd(
  sessionId: string,
  session: AgentSession,
  event: { aborted?: boolean; result?: { summary?: string }; errorMessage?: string },
  broadcast: Broadcast,
  projectId: number,
): void {
  if (!event.aborted) {
    try {
      const filtered = filterErrorMessages(session.messages);
      persistMessages(sessionId, filtered);
      console.log(`  Compaction persisted for ${sessionId} (${filtered.length} post-compaction messages)`);
    } catch (err) {
      console.error(`  Failed to persist compaction for ${sessionId}:`, err);
    }
  }
  broadcast({
    type: "event",
    sessionId,
    projectId,
    event: {
      type: "compaction_end",
      result: event.result,
      aborted: event.aborted,
      errorMessage: event.errorMessage,
    },
  });
}

function wirePiRuntimeEvents(
  state: ServerState,
  session: AgentSession,
  sessionId: string,
  projectId: number,
): void {
  const broadcast = createBroadcast(state.clients);

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "auto_compaction_start") {
      logCompactionState(sessionId, session);
      broadcast({
        type: "event",
        sessionId,
        projectId,
        event: { type: "compaction_start", reason: event.reason ?? "auto" },
      });
      return;
    }

    if (event.type === "auto_compaction_end") {
      handleCompactionEnd(sessionId, session, event, broadcast, projectId);
      return;
    }

    broadcast({ type: "event", sessionId, projectId, event });

    if (event.type === "turn_end" || event.type === "agent_end") {
      try {
        const filtered = filterErrorMessages(session.messages);
        persistMessages(sessionId, filtered);

        if (event.type === "agent_end") {
          const model = session.model;
          if (model) {
            updateSessionMeta(sessionId, {
              modelProvider: model.provider,
              modelId: model.id,
              thinkingLevel: session.thinkingLevel,
            });
          }
        }
      } catch (err) {
        console.error(`  Failed to persist messages for ${sessionId}:`, err);
      }
    }
  });
}

async function createPiSessionRuntime(params: CreateAgentRuntimeParams): Promise<AgentRuntime> {
  const {
    state,
    projectId,
    projectDir,
    sessionId,
    taskId,
    model,
    thinkingLevel,
    sessionTools,
  } = params;

  const task = await resolveTask(taskId, projectDir);

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
    console.log(`  Session hydrated: ${sessionId} (${messages.length} messages for LLM, total: ${state.sessions.size})`);
  }

  wirePiRuntimeEvents(state, agentSession, sessionId, projectId);

  return runtime;
}

export class PiRuntimeAdapter implements AgentRuntimeAdapter {
  readonly runtimeType = "pi";

  async listModels() {
    return buildProviderList();
  }

  async createRuntime(params: CreateAgentRuntimeParams): Promise<AgentRuntime> {
    return createPiSessionRuntime(params);
  }
}
