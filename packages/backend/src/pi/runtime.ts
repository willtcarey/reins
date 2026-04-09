import {
  DefaultResourceLoader,
  ModelRegistry,
  type AuthStorage,
} from "@mariozechner/pi-coding-agent";
import { createPiResourceLoader } from "./resource-loader.js";
import { createDbBackedAuthStorage } from "./auth-storage.js";

type ProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1];
type ExtensionRuntimeLike = ReturnType<DefaultResourceLoader["getExtensions"]>["runtime"] & {
  pendingProviderRegistrations?: Array<{ name: string; config: ProviderConfig; extensionPath?: string }>;
};

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface PiProviderRegistration {
  name: string;
  config: ProviderConfig;
  extensionPath: string;
}

export interface PiRuntimeForCwdResult {
  authStorage: AuthStorage;
  resourceLoader: DefaultResourceLoader;
  modelRegistry: ModelRegistry;
  providerRegistrations: PiProviderRegistration[];
  extensionErrors: Array<{ path: string; error: string }>;
}

export function getPiProviderRegistrations(
  resourceLoader: DefaultResourceLoader,
): PiProviderRegistration[] {
  const runtime: ExtensionRuntimeLike = resourceLoader.getExtensions().runtime;
  const registrations: Array<{
    name: string;
    config: ProviderConfig;
    extensionPath?: string;
  }> | undefined = runtime.pendingProviderRegistrations;

  return (registrations ?? []).map((registration) => ({
    name: registration.name,
    config: registration.config,
    extensionPath: registration.extensionPath ?? "(unknown)",
  }));
}

export function applyPiProviderRegistrations(
  modelRegistry: ModelRegistry,
  providerRegistrations: PiProviderRegistration[],
): void {
  for (const registration of providerRegistrations) {
    modelRegistry.registerProvider(registration.name, registration.config);
  }
}

export async function createPiRuntimeForCwd(params: {
  cwd: string;
  resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd">;
}): Promise<PiRuntimeForCwdResult> {
  const resourceLoader = createPiResourceLoader({
    ...params.resourceLoaderOptions,
    cwd: params.cwd,
  });
  await resourceLoader.reload();

  const authStorage = createDbBackedAuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);
  const providerRegistrations = getPiProviderRegistrations(resourceLoader);
  applyPiProviderRegistrations(modelRegistry, providerRegistrations);

  return {
    authStorage,
    resourceLoader,
    modelRegistry,
    providerRegistrations,
    extensionErrors: resourceLoader.getExtensions().errors,
  };
}
