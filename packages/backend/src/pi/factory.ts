import type { ModelsStore, Provider } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDbCredentialStore } from "./credential-store.js";

/**
 * The server's own Pi model context, built directly from Pi with the server's credential store: the
 * model catalog (listing and validating models, OAuth provider metadata) and one-shot utility asks.
 * Sessions run on nodes, which build their own Pi runtimes; nothing here comes from the node package.
 */

const additionalProviders = new Map<string, Provider>();

/** Adds a provider to every model runtime the server builds from now on (tests register faux providers). */
export function registerPiProvider(provider: Provider): void { additionalProviders.set(provider.id, provider); }
export function unregisterPiProvider(providerId: string): void { additionalProviders.delete(providerId); }

/** Pi's model runtime over the server's stored credentials. Offline catalog unless `allowModelNetwork`. */
export async function createPiModelRuntime(options: {
  allowModelNetwork?: boolean;
  catalogBaseUrl?: string;
  modelsStore?: ModelsStore;
} = {}): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({
    credentials: createDbCredentialStore(),
    allowModelNetwork: options.allowModelNetwork ?? false,
    modelRefreshTimeoutMs: 3_000,
    catalogBaseUrl: options.catalogBaseUrl,
    modelsStore: options.modelsStore,
  });
  for (const provider of additionalProviders.values()) modelRuntime.registerNativeProvider(provider);
  return modelRuntime;
}

/** Pi context for a one-shot utility ask: the model runtime and a resource loader carrying only
 * `systemPrompt`. The server has no source checkout, so it discovers no skills, prompt templates or
 * context files (AGENTS.md); those belong to sessions on nodes. */
export async function createPiUtilityContext(params: { cwd: string; systemPrompt?: string }) {
  const resourceLoader = new DefaultResourceLoader({
    agentDir: getAgentDir(),
    cwd: params.cwd,
    systemPrompt: params.systemPrompt,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  return { resourceLoader, modelRuntime: await createPiModelRuntime() };
}
