/**
 * Assembles a session's runtime on the server (ADR-029): AgentHarness over the session's storage on the
 * process's database, the server's model runtime and credentials, Pi's tools over the session's node
 * (`PiNodeEnv`), the Reins tools, the environment from the server plus the checkout, events to
 * the process's browser connections, its busy edges announced (`session_updated`) and its run ends applied
 * to the session's row.
 *
 * The runtime keeps the `ServerProcess` only: its storage, attachments and credentials (under the
 * process's locks) are on the process's database, its events go out through the process's broadcast,
 * and what it needs of an app (its node's link, the Reins tools) it reads at each call from
 * `ServerProcess.app`, never from the app that built it: the runtime outlives it. Its run lifecycle it
 * applies itself, against the process's database and broadcast (`lifecycleReports`), app or no app.
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { RpcFailure } from "@reins/node-protocol";
import type { ReinsToolCalls } from "../tools/index.js";
import { runSettled, type SessionSettled } from "../sessions/session-runs.js";
import type { App, NodeClient, ServerProcess } from "../state.js";
import type { SessionContext } from "../models/session.js";
import { PiStorageAdapter } from "../pi-storage.js";
import { createPiModelRuntime } from "../pi/factory.js";
import { createDbCredentialStore } from "../pi/credential-store.js";
import { createBroadcast, sessionEventFrame } from "../models/broadcast.js";
import { logger } from "../logger.js";
import { NodeDirClient } from "../nodes/node-dir-client.js";
import { PiNodeEnv } from "../nodes/pi-node-env.js";
import { AttachmentCache, hydratePrompt, materializePromptAttachments } from "./attachments.js";
import { createAgentHarnessPiRuntime, ModelNotFoundError, type AgentHarnessPiRuntime, type PrepareRun, type RuntimeLifecycleSink } from "./pi-runtime.js";
import { createHostTools, type HostToolContext } from "./tools.js";
import { createReinsTools } from "./reins-tools.js";
import { referenceInlineImages, toolImageReferences } from "./tool-images.js";
import { environmentPrompt, expandSkills, prepareCheckout } from "./environment.js";
import { nodeResources } from "./resources.js";
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

/** Bound on discovering the node's skills for slash expansion: a submission waits on it. */
const EXPANSION_TIMEOUT_MS = 10_000;

/** The Reins tools' calls, delivered to the current app at each call. During a reload's gap a call is not
 * run: it fails at once with outcome `not_run`, for the model to try again. */
function currentToolCalls(serverProcess: ServerProcess, sessionId: string): ReinsToolCalls {
  const app = (): App => {
    if (serverProcess.app) return serverProcess.app;
    throw Object.assign(new Error("Not run: the server is reloading, try again"), { outcome: "not_run" });
  };
  return {
    executeScript: async (code, signal) => app().executeScript(sessionId, code, signal),
    searchScript: async (query, signal) => app().searchScript(sessionId, query, signal),
    createTask: async (input, signal) => app().createTask(sessionId, input, signal),
  };
}

/**
 * The runtime's run lifecycle, applied by the runtime itself (`runSettled` of `sessions/session-runs.ts`,
 * the code it was built with) against the process's database and broadcast: no app is involved, so a
 * reload's gap holds nothing up. A run's start writes nothing (the runtime is busy, which is what running
 * is); its end is applied, one at a time in occurrence order: Pi emits each after the commits it follows,
 * so a settlement is applied after them, and the runtime stays busy until it was. One that fails is logged
 * and lost. Pi faults its harness on a storage error and never ends that run, so the runtime settles it
 * then (failed, Reins' end of it) and reports nothing more.
 */
function lifecycleReports(serverProcess: ServerProcess, sessionId: string, onActivity: () => void): RuntimeLifecycleSink & { storageFailed(error: unknown): void } {
  /** Its last report's application: the session's reports are applied in order. */
  let last = Promise.resolve();
  let openRun: string | undefined;
  let faulted = false;
  const send = (apply: () => void | Promise<void>): Promise<void> => {
    onActivity();
    last = last.then(apply).catch((error: unknown) => {
      logger.warn(`Lifecycle report for session ${sessionId} lost:`, error instanceof Error ? error.message : error);
    });
    return last;
  };
  const settle = (report: Omit<SessionSettled, "sessionId">) => {
    const settled: SessionSettled = { sessionId, ...report };
    return send(() => runSettled(serverProcess, settled));
  };
  return {
    started: runId => {
      if (faulted) return;
      openRun = runId;
      onActivity();
    },
    settled: (runtime, { runId, tipId, status, error }) => {
      if (faulted) return;
      openRun = undefined;
      const { model, thinkingLevel } = runtime.getSessionMetadata();
      return settle({
        runId, source: "pi", tipId, status,
        ...(error ? { error: { ...(error.code ? { code: error.code } : {}), message: error.message } } : {}),
        metadata: { model: model?.provider && model.modelId ? { provider: model.provider, modelId: model.modelId } : null, thinkingLevel: thinkingLevel ?? null },
      });
    },
    storageFailed: error => {
      if (faulted) return;
      faulted = true;
      if (openRun === undefined) return;
      void settle({ runId: openRun, source: "reins", status: "failed", error: { message: `Session storage failed: ${error instanceof Error ? error.message : String(error)}` }, metadata: { model: null, thinkingLevel: null }, tipId: null });
    },
    flush: () => last,
  };
}

/** Asks the current app for the node at each call: the runtime outlives its app. In a reload's gap a call
 * fails `unavailable`, as for a node not connected, so one waiting for the node waits through the gap too. */
export function currentAppNode(serverProcess: ServerProcess, nodeId: string): NodeClient {
  const node = () => {
    const app = serverProcess.app;
    if (!app) throw new RpcFailure("unavailable", "The server is reloading");
    return app.node(nodeId);
  };
  const field = <T>(read: (client: NodeClient) => T, none: T): T => {
    try { return read(node()); } catch { return none; }
  };
  return {
    id: nodeId,
    get connected() { return field(client => client.connected, false); },
    get build() { return field(client => client.build, null); },
    get failure() { return field(client => client.failure, null); },
    get docs() { return field(client => client.docs, null); },
    async request(method, input, options) { return node().request(method, input, options); },
    async openStream(method, input, options) { return node().openStream(method, input, options); },
  };
}

/** Builds and opens a session's runtime. Throws `ModelNotFoundError` for a model the server's catalog does
 * not have (the lane's, else the seed's), `UnknownToolsError` for tools it does not have. */
export async function buildSessionRuntime({ serverProcess, sessionId, projectId, nodeId, context, model: override, onActivity, onFault }: RuntimeOpening): Promise<AgentHarnessPiRuntime> {
  const { binding, branch, lane: seedLane, runtime: configuration } = context;
  const node = currentAppNode(serverProcess, nodeId);
  const modelRuntime = await createPiModelRuntime({ credentials: createDbCredentialStore(serverProcess) });

  const attachments = new AttachmentCache();
  const lifecycle = lifecycleReports(serverProcess, sessionId, onActivity);
  // Commits Pi makes without the `after_tool` hook (a checkpointed result republished on recovery, a hook
  // cut short by abort) get their inline images stored here, before the commit.
  const storage = new SessionStorage(new PiStorageAdapter(serverProcess.db, sessionId),
    async writes => referenceInlineImages(attachments, sessionId, writes),
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

  const executionEnv = new PiNodeEnv(new NodeDirClient({ cwd: binding.cwd, node }));
  const tools: AgentHarnessTool<HostToolContext>[] = [
    ...createHostTools({ sessionId, sessionEnvironment }),
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
    // Discovery is strict: one the node could not answer fails, rather than pass for a node without them.
    const prepareRun: PrepareRun | undefined = configuration.environment || branch
      ? async ({ signal, waiting }) => {
        // Its waits for the node are the run's pause point.
        const checkout = new NodeDirClient({ cwd: binding.cwd, node, onWaiting: waiting });
        const connected = await prepareCheckout(checkout, branch, signal);
        if (!configuration.environment) return configuration.systemPrompt;
        const resources = await nodeResources(new PiNodeEnv(checkout, { strict: true }), { signal });
        return configuration.systemPrompt + environmentPrompt({ cwd: binding.cwd, tools: activeTools, resources: { ...resources, docs: connected.docs } });
      }
      : undefined;
    // Slash expansion does not wait for a node that is not connected: the submission fails at once.
    const nodeSkills = async () => {
      try {
        const checkout = new PiNodeEnv(new NodeDirClient({ cwd: binding.cwd, node, waitForNode: false }), { strict: true });
        return (await nodeResources(checkout, { signal: AbortSignal.timeout(EXPANSION_TIMEOUT_MS) })).skills;
      } catch (error) {
        throw new Error(`The node's skills are unavailable (${error instanceof Error ? error.message : String(error)})`, { cause: error });
      }
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
      hydratePrompt: async (id, content) => hydratePrompt(attachments, id, content),
      // A prompt's attachments are checked against the store before Pi admits it. A kind without the
      // environment (a utility kind) sees exactly what was submitted: no skills are expanded.
      expandPrompt: async content => {
        materializePromptAttachments(attachments, sessionId, content);
        return configuration.environment ? expandSkills(content, nodeSkills) : content;
      },
      emit,
      // Running is the runtime's busy state: browsers hear of each change, and read it from the views.
      onBusy: () => {
        onActivity();
        createBroadcast(serverProcess)({ type: "session_updated", sessionId, projectId });
      },
      referenceToolImages: toolImageReferences(attachments, sessionId),
      pauseGate: serverProcess.sessions.pauseGate,
      ...(prepareRun ? { prepareRun } : {}),
      onError: (message, error) => logger.error(message, error),
    });
  } catch (error) {
    await executionEnv.cleanup();
    throw error;
  }
}
