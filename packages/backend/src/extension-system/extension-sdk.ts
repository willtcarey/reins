/**
 * One extension's `ServerSdk` (docs/dev/server-sdk.md). Every removal it hands out is also put in `owned`, so
 * disconnecting removes what the extension's own disposer forgot.
 */

import type {
  Disposer, ImagesProvider, NodeProcess, PageHandler, ProcessOptions, PromptContribution, ScriptNamespace, SecretStorage, ServerSdk, Service, SessionSettlement, ToolProvider,
} from "@reins/sdk/server";
import type { ExtensionStorage } from "../database.js";
import type { AppState } from "../state.js";
import { createBroadcast } from "../models/broadcast.js";
import { logger } from "../logger.js";
import { deleteExtensionSecret, extensionSecretKeys, getExtensionSecret, setExtensionSecret } from "../extension-secrets-store.js";
import { Models } from "../models/models.js";
import { bind, type CallContext } from "../sdk-host/declaration.js";
import { TOOLS } from "../sdk-host/tools.js";
import { SESSIONS } from "../sdk-host/sessions.js";
import { PROJECTS, TASKS } from "../sdk-host/projects.js";
import { NODES, spawnProcess } from "../sdk-host/nodes.js";
import { IMAGES } from "../sdk-host/images.js";
import { UI } from "../sdk-host/ui.js";
import { MODELS } from "../sdk-host/models.js";
import { REVIEWS } from "../sdk-host/reviews.js";
import { matchTools } from "./tool-docs.js";
import { MAX_TOOL_ID_LENGTH, TOOL_ID_SEPARATOR, pagePath, type ExtensionHost, type Removal } from "./host.js";

export interface ExtensionSdkOptions {
  name: string;
  storage: ExtensionStorage;
  host: ExtensionHost;
  app: () => AppState;
  started: () => boolean;
  owned: Disposer[];
}

export function createExtensionSdk({ name, storage: { dataDir, db }, host, app, started, owned }: ExtensionSdkOptions): ServerSdk {
  const own = (remove: Removal): Disposer => {
    owned.push(remove);
    return remove;
  };
  const broadcast = createBroadcast(app().process);
  // Each call gets the app's models of that moment, as the extension acts as no session.
  const context = (): CallContext => ({ models: new Models(app()), caller: { kind: "extension", name } });
  /** Disconnecting stops the extension's processes, one that is still starting too. */
  const spawn = async (node: string, command: string | readonly string[], options: ProcessOptions = {}): Promise<NodeProcess> => {
    const unloaded = new AbortController();
    let spawned: NodeProcess | undefined;
    const remove = own(async () => { unloaded.abort(); await spawned?.stop(); });
    const forget = () => { const at = owned.indexOf(remove); if (at >= 0) owned.splice(at, 1); };
    const signal = options.signal ? AbortSignal.any([options.signal, unloaded.signal]) : unloaded.signal;
    try {
      spawned = await spawnProcess(context(), node, command, { ...options, signal });
    } catch (error) {
      forget();
      throw error;
    }
    void spawned.exited.then(forget);
    return spawned;
  };
  return Object.freeze<ServerSdk>({
    name,
    dataDir,
    db,
    logger,
    secrets: secretStorage(name),
    broadcast: (message: object) => broadcast({ type: "extension", extension: name, message }),
    tools: Object.freeze({
      ...bind(TOOLS.methods, context),
      register: (provider: ToolProvider) => own(host.addToolProvider(name, provider)),
      maxLocalIdLength: MAX_TOOL_ID_LENGTH - name.length - TOOL_ID_SEPARATOR.length,
      match: matchTools,
    }),
    images: Object.freeze({
      ...bind(IMAGES.methods, context),
      registerProvider: (provider: ImagesProvider) => own(host.addImageProvider(name, provider)),
    }),
    services: Object.freeze({ register: (service: Service) => own(host.addService(name, service, started())) }),
    sessions: Object.freeze({
      ...bind(SESSIONS.methods, context),
      onSettled: (listener: (settlement: SessionSettlement) => void | Promise<void>) => own(host.addSettlementListener(name, listener)),
    }),
    nodes: Object.freeze({
      ...bind(NODES.methods, context),
      spawn: (node: string, command: string | readonly string[], options?: ProcessOptions) => spawn(node, command, options),
    }),
    ui: Object.freeze(bind(UI.methods, context)),
    models: Object.freeze(bind(MODELS.methods, context)),
    reviews: Object.freeze(bind(REVIEWS.methods, context)),
    projects: Object.freeze(bind(PROJECTS.methods, context)),
    tasks: Object.freeze(bind(TASKS.methods, context)),
    prompt: Object.freeze({
      register: (contribution: PromptContribution) => own(host.addPromptContribution(name, contribution)),
    }),
    scripting: Object.freeze({
      register: (namespace: ScriptNamespace) => own(host.addScriptNamespace(name, namespace)),
    }),
    http: Object.freeze<ServerSdk["http"]>({
      handle: (api, handlers) => own(host.addHttpApi(name, api, handlers)),
      page: (path: string, handler: PageHandler) => own(host.addPage(name, path, handler)),
      pagePath: (path: string) => pagePath(name, path),
    }),
  });
}

const MAX_SECRET_KEY_LENGTH = 256;

/** The extension's secrets: its keys only. Async, as the contract is (a keychain could hold them later). */
function secretStorage(extension: string): SecretStorage {
  const checked = (key: unknown): string => {
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_SECRET_KEY_LENGTH) {
      throw new Error(`A secret's key is a string of 1 to ${MAX_SECRET_KEY_LENGTH} characters`);
    }
    return key;
  };
  return Object.freeze({
    get: async (key: string) => getExtensionSecret(extension, checked(key)),
    set: async (key: string, value: string) => {
      if (typeof value !== "string") throw new Error("A secret's value is a string");
      setExtensionSecret(extension, checked(key), value);
    },
    delete: async (key: string) => deleteExtensionSecret(extension, checked(key)),
    keys: async (prefix = "") => {
      if (typeof prefix !== "string") throw new Error("A prefix is a string");
      return extensionSecretKeys(extension, prefix);
    },
  });
}
