import type { ModelsStore, Provider } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { ReinsResourceLoader } from "../resource-loader.js";
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

interface PiResourceOptions {
  cwd: string;
  reinsAgentDir?: string;
  piAgentDir?: string;
  resourceLoaderOptions?: Partial<Omit<DefaultResourceLoaderOptions, "cwd" | "skillsOverride" | "agentsFilesOverride">>;
}

/** Adapt Reins-owned context and skill discovery to Pi's runtime resource interface. */
export async function createPiResources(params: PiResourceOptions): Promise<{
  resourceLoader: DefaultResourceLoader;
  resources: ReinsResourceLoader;
}> {
  const resources = new ReinsResourceLoader({ cwd: params.cwd, agentDir: params.reinsAgentDir });
  resources.load();
  const resourceLoader = new DefaultResourceLoader({
    agentDir: params.piAgentDir ?? getAgentDir(),
    ...params.resourceLoaderOptions,
    cwd: params.cwd,
    noSkills: true,
    noContextFiles: true,
    skillsOverride: () => ({
      skills: params.resourceLoaderOptions?.noSkills ? [] : resources.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        disableModelInvocation: skill.disableModelInvocation,
        sourceInfo: {
          path: skill.filePath,
          source: skill.source,
          scope: skill.source === "user" ? "user" as const : "project" as const,
          origin: "top-level" as const,
          baseDir: skill.baseDir,
        },
      })),
      diagnostics: [],
    }),
    agentsFilesOverride: () => ({ agentsFiles: [...resources.contextFiles] }),
  });
  await resourceLoader.reload();
  return { resourceLoader, resources };
}

export interface PiContext {
  modelRuntime: ModelRuntime;
  resourceLoader: DefaultResourceLoader;
  resources: ReinsResourceLoader;
}

export async function createPiContext(params: PiResourceOptions & { allowModelNetwork?: boolean }): Promise<PiContext> {
  return {
    ...await createPiResources(params),
    modelRuntime: await createPiModelRuntime({ allowModelNetwork: params.allowModelNetwork }),
  };
}
