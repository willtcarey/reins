/**
 * Assembles a session's runtime on the server (ADR-029): AgentHarness over the session's storage on the
 * process's database, the server's model runtime and credentials, Pi's tools over the session's node
 * (`RemoteExecutionEnv`), the Reins tools, the environment from the server plus the checkout, events to
 * the process's browser clients and run lifecycle to the load serving now.
 *
 * Everything the runtime reaches of a handler load (its node's link, credentials, run lifecycle, tools,
 * attachments) it resolves at each call through `ProcessSessions.load`, never from the load that built
 * it: the runtime outlives it.
 */
import { BACKGROUND_CONTEXT, type AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ReinsToolCalls, SessionSettled } from "@reins/node-protocol";
import type { LoadServices, RemoteNode, SessionProcess } from "../state.js";
import type { SessionContext } from "../models/session.js";
import { PiStorageAdapter } from "../pi-storage.js";
import { createPiModelRuntime } from "../pi/factory.js";
import { broadcastFrame, sessionEventFrame } from "../models/broadcast.js";
import { logger } from "../logger.js";
import { RemoteExecutionEnv } from "../sessions/remote-env.js";
import { AttachmentCache, hydratePrompt, materializePromptAttachments, type FetchAttachment } from "./attachments.js";
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

/** What a session's runtime is built from: the process's state, the session's rows as they are now
 * (`SessionModel.context`) and where it runs. */
export interface RuntimeOpening {
  host: SessionProcess;
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

/** Pi's credential store over the load serving now, at each call. */
function loadCredentials(load: (signal?: AbortSignal) => Promise<LoadServices>): CredentialStore {
  return {
    read: async (providerId, options) => (await load(options?.signal)).credentials.read(providerId, options),
    list: async options => (await load(options?.signal)).credentials.list(options),
    modify: async (providerId, fn, options) => (await load(options?.signal)).credentials.modify(providerId, fn, options),
    delete: async (providerId, options) => (await load(options?.signal)).credentials.delete(providerId, options),
  };
}

/** The Reins tools' calls, through the load serving now at each call. */
function loadToolCalls(load: (signal?: AbortSignal) => Promise<LoadServices>, sessionId: string): ReinsToolCalls {
  return {
    executeScript: async (code, signal) => (await load(signal)).toolCalls(sessionId).executeScript(code, signal),
    searchScript: async (query, signal) => (await load(signal)).toolCalls(sessionId).searchScript(query, signal),
    createTask: async (input, signal) => (await load(signal)).toolCalls(sessionId).createTask(input, signal),
  };
}

/**
 * The runtime's run lifecycle, applied by the load serving now (`runStarted`/`runSettled`), one report at
 * a time in occurrence order: Pi emits each after the commits it follows, so a settlement is applied after
 * them. A report no load takes within its wait is logged and lost. Pi faults its harness on a storage
 * error and never ends that run, so the runtime settles it then (failed) and reports nothing more.
 */
function lifecycleReports(load: (signal?: AbortSignal) => Promise<LoadServices>, sessionId: string, onActivity: () => void): RuntimeLifecycleSink & { storageFailed(error: unknown): void } {
  let chain = Promise.resolve();
  let openRun: string | undefined;
  let faulted = false;
  const send = (apply: (services: LoadServices) => void | Promise<void>) => {
    onActivity();
    chain = chain.then(async () => { await apply(await load()); })
      .catch((error: unknown) => logger.warn(`Lifecycle report for session ${sessionId} lost:`, error instanceof Error ? error.message : error));
  };
  const settle = (report: Omit<SessionSettled, "sessionId" | "reportId">) => {
    const reportId = crypto.randomUUID();
    send(services => services.runSettled({ sessionId, reportId, ...report }));
  };
  return {
    started: runId => {
      if (faulted) return;
      openRun = runId;
      send(services => services.runStarted(sessionId, runId));
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

/** Builds and opens a session's runtime. Throws `ModelNotFoundError` for a model the server's catalog does
 * not have (the lane's, else the seed's), `UnknownToolsError` for tools it does not have. */
export async function buildSessionRuntime({ host, sessionId, projectId, nodeId, context, model: override, onActivity, onFault }: RuntimeOpening): Promise<AgentHarnessPiRuntime> {
  const { binding, branch, lane: seedLane, runtime: configuration } = context;
  const load = (signal?: AbortSignal) => host.sessions.load(signal);
  const nodeFor = async (signal?: AbortSignal): Promise<RemoteNode> => (await load(signal)).node(nodeId);
  const modelRuntime = await createPiModelRuntime({ credentials: loadCredentials(load) });

  const attachments = new AttachmentCache();
  const fetchAttachment: FetchAttachment = async (id, attachmentId) => (await load()).attachment(id, attachmentId);
  const storeAttachment: StoreAttachment = async (id, attachmentId, attachment) => (await load()).storeAttachment(id, attachmentId, attachment);
  const lifecycle = lifecycleReports(load, sessionId, onActivity);
  // Commits Pi makes without the `after_tool` hook (a checkpointed result republished on recovery, a hook
  // cut short by abort) get their inline images stored here, before the commit.
  const storage = new SessionStorage(new PiStorageAdapter(host.db, sessionId),
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
    ...createReinsTools(loadToolCalls(load, sessionId)),
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
      const seq = (host.sessions.eventSeqs.get(sessionId) ?? 0) + 1;
      host.sessions.eventSeqs.set(sessionId, seq);
      onActivity();
      broadcastFrame(host.clients, sessionEventFrame(sessionId, projectId, seq, Date.now(), sendableEvent(event)));
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
      pauseGate: host.sessions.pauseGate,
      ...(prepareRun ? { prepareRun } : {}),
      onError: (message, error) => logger.error(message, error),
    });
  } catch (error) {
    await executionEnv.cleanup(BACKGROUND_CONTEXT);
    throw error;
  }
}
