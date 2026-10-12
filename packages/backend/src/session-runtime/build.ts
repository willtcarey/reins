/**
 * Assembles a session's runtime on the server (ADR-029): AgentHarness over the session's storage on the
 * process's database, the server's model runtime and credentials, Pi's tools over the session's node
 * (`RemoteExecutionEnv`), the Reins tools, the environment from the server plus the checkout, events to
 * the process's browser connections and run lifecycle to the current app.
 *
 * The runtime keeps the `ServerProcess` only: its storage, attachments and credentials (under the
 * process's locks) are on the process's database, its events go out through the process's broadcast, its
 * node is the process's hub's (`sessionNode`), and what it needs of an app (run lifecycle, the Reins tools)
 * it resolves at each call through `ServerProcess.app`, never from the app that built it: the runtime
 * outlives it.
 */
import { BACKGROUND_CONTEXT, type AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { ReinsToolCalls } from "../tools/index.js";
import type { SessionSettled } from "../sessions/session-runs.js";
import type { App, RemoteNode, ServerProcess } from "../state.js";
import type { SessionContext } from "../models/session.js";
import { PiStorageAdapter } from "../pi-storage.js";
import { createPiModelRuntime } from "../pi/factory.js";
import { createDbCredentialStore } from "../pi/credential-store.js";
import { getSessionAttachment, storeSessionAttachment } from "../session-attachments-store.js";
import { getNode } from "../node-store.js";
import { sessionEventFrame } from "../models/broadcast.js";
import { logger } from "../logger.js";
import { RemoteExecutionEnv } from "../sessions/remote-env.js";
import { AttachmentCache, hydratePrompt, materializePromptAttachments, type AttachmentBytes, type FetchAttachment } from "./attachments.js";
import { createAgentHarnessPiRuntime, ModelNotFoundError, type AgentHarnessPiRuntime, type PrepareRun, type RuntimeLifecycleSink } from "./pi-runtime.js";
import { createHostTools, type HostToolContext } from "./tools.js";
import { createReinsTools } from "./reins-tools.js";
import { referenceInlineImages, toolImageReferences, type StoreAttachment } from "./tool-images.js";
import { environmentPrompt, expandSkills, prepareCheckout, type CheckoutTarget } from "./environment.js";
import { mergeResources, serverAgentsDir, serverResources } from "./resources.js";
import { SessionStorage } from "./storage.js";
import { sendableEvent } from "./events.js";
import { piThinkingLevel, storedLaneModel } from "./lane.js";

/** The runtime configuration names tools the server does not have. */
export class UnknownToolsError extends Error {
  constructor(names: string[]) {
    super(`Unknown tools: ${names.join(", ")}`);
    this.name = "UnknownToolsError";
  }
}

/** What a session's runtime is built from: the process (the only state it may keep), the session's rows
 * as they are now (`SessionModel.context`) and where it runs. */
export interface RuntimeOpening {
  serverProcess: ServerProcess;
  sessionId: string;
  projectId: number;
  /** The node of the session's source. */
  nodeId: string;
  context: SessionContext;
  /** Opens it with this model in place of the lane's (a model change, `OpenOptions.model`). */
  model?: ModelOverride;
  /** The runtime emitted an event or reported its lifecycle (its last activity). */
  onActivity(): void;
  /** A storage call failed under it: Pi faulted its harness, so it is not to be reused. */
  onFault(): void;
}

/** A model a caller is about to set, which opens the runtime in place of the lane's. */
export interface ModelOverride { provider: string; modelId: string; thinkingLevel?: string | null }

/** Bound on the node answering `checkout.environment` for slash expansion: a submission waits on it. */
const EXPANSION_TIMEOUT_MS = 10_000;

/** The Reins tools' calls, delivered to the current app at each call. */
function currentToolCalls(serverProcess: ServerProcess, sessionId: string): ReinsToolCalls {
  return {
    executeScript: async (code, signal) => (await serverProcess.app(signal)).executeScript(sessionId, code, signal),
    searchScript: async (query, signal) => (await serverProcess.app(signal)).searchScript(sessionId, query, signal),
    createTask: async (input, signal) => (await serverProcess.app(signal)).createTask(sessionId, input, signal),
  };
}

/** The session's attachment from the process's database, or null when it has none by that ID (or its
 * bytes were pruned). */
function storedAttachment(sessionId: string, attachmentId: string): AttachmentBytes | null {
  const row = getSessionAttachment(sessionId, attachmentId);
  return row?.data ? {
    data: row.data, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256,
    ...(row.filename ? { filename: row.filename } : {}),
    ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
  } : null;
}

/**
 * The runtime's run lifecycle, delivered to the current app (`runStarted`/`runSettled`), one report at
 * a time in occurrence order: Pi emits each after the commits it follows, so a settlement is applied after
 * them. A report no app takes within its wait is logged and lost. Pi faults its harness on a storage
 * error and never ends that run, so the runtime settles it then (failed) and reports nothing more.
 */
function lifecycleReports(serverProcess: ServerProcess, sessionId: string, onActivity: () => void): RuntimeLifecycleSink & { storageFailed(error: unknown): void } {
  let chain = Promise.resolve();
  let openRun: string | undefined;
  let faulted = false;
  const send = (apply: (app: App) => void | Promise<void>) => {
    onActivity();
    chain = chain.then(async () => { await apply(await serverProcess.app()); })
      .catch((error: unknown) => logger.warn(`Lifecycle report for session ${sessionId} lost:`, error instanceof Error ? error.message : error));
  };
  const settle = (report: Omit<SessionSettled, "sessionId" | "reportId">) => {
    const reportId = crypto.randomUUID();
    send(app => app.runSettled({ sessionId, reportId, ...report }));
  };
  return {
    started: runId => {
      if (faulted) return;
      openRun = runId;
      send(app => app.runStarted(sessionId, runId));
    },
    settled: (runtime, { runId, tipId, status, error }) => {
      if (faulted) return;
      openRun = undefined;
      const { model, thinkingLevel } = runtime.getSessionMetadata();
      settle({
        runId, tipId, status,
        ...(error ? { error: { ...(error.code ? { code: error.code } : {}), message: error.message } } : {}),
        metadata: { model: model?.provider && model.modelId ? { provider: model.provider, modelId: model.modelId } : null, thinkingLevel: thinkingLevel ?? null },
      });
    },
    storageFailed: error => {
      if (faulted) return;
      faulted = true;
      if (openRun === undefined) return;
      settle({ runId: openRun, status: "failed", error: { message: `Session storage failed: ${error instanceof Error ? error.message : String(error)}` }, metadata: { model: null, thinkingLevel: null }, tipId: null });
    },
    flush: () => chain,
  };
}

/** A session's node, from the process's hub at each call (it holds no link: `RemoteNode`): rejects once the
 * node was removed (its sessions take no work, and a tool call waiting for it fails). */
export function sessionNode(serverProcess: ServerProcess, nodeId: string): () => Promise<RemoteNode> {
  return async () => {
    if (getNode(nodeId)?.removedAt) throw new Error(`Node removed: ${nodeId}`);
    return serverProcess.nodes.get(nodeId);
  };
}

/** Builds and opens a session's runtime. Throws `ModelNotFoundError` for a model the server's catalog does
 * not have (the lane's, else the seed's), `UnknownToolsError` for tools it does not have. */
export async function buildSessionRuntime({ serverProcess, sessionId, projectId, nodeId, context, model: override, onActivity, onFault }: RuntimeOpening): Promise<AgentHarnessPiRuntime> {
  const { binding, branch, lane: seedLane, runtime: configuration } = context;
  const nodeFor = sessionNode(serverProcess, nodeId);
  const modelRuntime = await createPiModelRuntime({ credentials: createDbCredentialStore(serverProcess) });

  const attachments = new AttachmentCache();
  const fetchAttachment: FetchAttachment = async (id, attachmentId) => storedAttachment(id, attachmentId);
  const storeAttachment: StoreAttachment = async (id, attachmentId, { data, mimeType, filename, width, height }) => {
    storeSessionAttachment(id, { id: attachmentId, data, mimeType, filename, width, height });
  };
  const lifecycle = lifecycleReports(serverProcess, sessionId, onActivity);
  // Commits Pi makes without the `after_tool` hook (a checkpointed result republished on recovery, a hook
  // cut short by abort) get their inline images stored here, before the commit.
  const storage = new SessionStorage(new PiStorageAdapter(serverProcess.db, sessionId),
    writes => referenceInlineImages(attachments, storeAttachment, sessionId, writes),
    error => { lifecycle.storageFailed(error); onFault(); });

  // Pi's lane owns the model selection; it is validated against the server's catalog before Pi opens. A
  // session without a lane yet (it never ran) gets one seeded from the lane seed when Pi opens it below;
  // a model change opens it with the new model, which the caller then sets through the lane.
  const seed = seedLane.model ? { ...seedLane.model, thinkingLevel: seedLane.thinkingLevel } : null;
  const selected = override ? { ...override, thinkingLevel: override.thinkingLevel ?? seed?.thinkingLevel } : await storedLaneModel(storage) ?? seed;
  if (!selected) throw new Error("AgentHarness Pi runtime requires an explicit model");
  const model = modelRuntime.getModel(selected.provider, selected.modelId);
  if (!model) throw new ModelNotFoundError(selected.provider, selected.modelId);
  // An existing lane's thinking level is restored; this only seeds one Pi has not created.
  const thinkingLevel = piThinkingLevel(selected.thinkingLevel);
  const sessionEnvironment = { provider: model.provider, modelId: model.id, thinkingLevel: thinkingLevel === "off" ? null : thinkingLevel };

  const agentsDir = serverAgentsDir();
  const executionEnv = new RemoteExecutionEnv({ sourceId: binding.sourceId, cwd: binding.cwd, nodeFor });
  const tools: AgentHarnessTool<HostToolContext>[] = [
    ...createHostTools({ sessionId, sessionEnvironment, serverAgentsDir: agentsDir }),
    ...createReinsTools(currentToolCalls(serverProcess, sessionId)),
  ];
  try {
    const activeToolNames = configuration.tools ?? tools.map(tool => tool.name);
    const unknown = activeToolNames.filter(name => !tools.some(tool => tool.name === name));
    if (unknown.length > 0) throw new UnknownToolsError(unknown);
    const activeTools = activeToolNames.map(name => tools.find(tool => tool.name === name)!);

    // The checkout is prepared at each run's first assistant request (on its node, waiting for it): the
    // task branch, and the environment the prompt lists. A kind without the environment and without a
    // branch (a utility kind) needs no checkout: the model sees exactly its prompt.
    const target: CheckoutTarget = { nodeId, sourceId: binding.sourceId, cwd: binding.cwd, branch };
    const prepareRun: PrepareRun | undefined = configuration.environment || branch
      ? async ({ signal, waiting }) => {
        const checkout = await prepareCheckout(nodeFor, target, { signal, waiting });
        return configuration.environment
          ? configuration.systemPrompt + environmentPrompt({ tools: activeTools, resources: mergeResources(serverResources(agentsDir), checkout) })
          : configuration.systemPrompt;
      }
      : undefined;
    const checkoutSkills = async () => {
      let checkout;
      try { checkout = await (await nodeFor()).request("checkout.environment", { sourceId: binding.sourceId, cwd: binding.cwd }, { timeoutMs: EXPANSION_TIMEOUT_MS }); }
      catch (error) { throw new Error(`The checkout's skills are unavailable (${error instanceof Error ? error.message : String(error)})`, { cause: error }); }
      return mergeResources(serverResources(agentsDir), checkout).skills;
    };

    const emit = (event: Parameters<typeof sendableEvent>[0]) => {
      // Per session for the life of the process, whichever runtime emits.
      const seq = (serverProcess.sessions.eventSeqs.get(sessionId) ?? 0) + 1;
      serverProcess.sessions.eventSeqs.set(sessionId, seq);
      onActivity();
      serverProcess.broadcast(sessionEventFrame(sessionId, projectId, seq, Date.now(), sendableEvent(event)));
    };

    return await createAgentHarnessPiRuntime({
      storage, sessionId, createdAt: Date.parse(binding.createdAt), cwd: binding.cwd,
      ...(binding.parentSessionId ? { parentSessionId: binding.parentSessionId } : {}),
      options: {
        models: modelRuntime, model, thinkingLevel, tools, activeToolNames,
        systemPrompt: configuration.systemPrompt,
        toolContext: { env: executionEnv },
      },
      sessionEnvironment, executionEnv, lifecycle,
      hydratePrompt: (id, content) => hydratePrompt(attachments, id, content, fetchAttachment),
      // A prompt's attachments are checked against the store before Pi admits it. A kind without the
      // environment (a utility kind) sees exactly what was submitted: no skills are expanded.
      expandPrompt: async content => {
        await materializePromptAttachments(attachments, sessionId, content, fetchAttachment);
        return configuration.environment ? expandSkills(content, serverResources(agentsDir), checkoutSkills) : content;
      },
      emit,
      referenceToolImages: toolImageReferences(attachments, storeAttachment, sessionId),
      pauseGate: serverProcess.sessions.pauseGate,
      ...(prepareRun ? { prepareRun } : {}),
      onError: (message, error) => logger.error(message, error),
    });
  } catch (error) {
    await executionEnv.cleanup(BACKGROUND_CONTEXT);
    throw error;
  }
}
