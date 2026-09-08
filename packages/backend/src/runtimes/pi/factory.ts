import type { ModelsStore, Provider } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createDbCredentialStore } from "./credential-store.js";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

const additionalProviders = new Map<string, Provider>();

/** Register an app-owned provider in every subsequently created Pi runtime. */
export function registerPiProvider(provider: Provider): void {
  additionalProviders.set(provider.id, provider);
}

export function unregisterPiProvider(providerId: string): void {
  additionalProviders.delete(providerId);
}

export async function createPiModelRuntime(options?: {
  allowModelNetwork?: boolean;
  catalogBaseUrl?: string;
  modelsStore?: ModelsStore;
}): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({
    credentials: createDbCredentialStore(),
    allowModelNetwork: options?.allowModelNetwork ?? false,
    modelRefreshTimeoutMs: 3_000,
    catalogBaseUrl: options?.catalogBaseUrl,
    modelsStore: options?.modelsStore,
  });

  for (const provider of additionalProviders.values()) {
    modelRuntime.registerNativeProvider(provider);
  }

  return modelRuntime;
}

export interface PiContext {
  modelRuntime: ModelRuntime;
  resourceLoader: DefaultResourceLoader;
}

export async function createPiContext(params: {
  cwd: string;
  allowModelNetwork?: boolean;
  resourceLoaderOptions?: Partial<Omit<DefaultResourceLoaderOptions, "cwd">>;
}): Promise<PiContext> {
  const resourceLoader = new DefaultResourceLoader({
    agentDir: getAgentDir(),
    ...params.resourceLoaderOptions,
    cwd: params.cwd,
  });
  await resourceLoader.reload();

  return {
    modelRuntime: await createPiModelRuntime({ allowModelNetwork: params.allowModelNetwork }),
    resourceLoader,
  };
}
