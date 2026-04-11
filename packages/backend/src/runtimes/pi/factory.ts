import {
  DefaultResourceLoader,
  ModelRegistry,
  type AuthStorage,
} from "@mariozechner/pi-coding-agent";
import { createPiResourceLoader } from "./resource-loader.js";
import { createDbBackedAuthStorage } from "./auth-storage.js";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface PiContext {
  authStorage: AuthStorage;
  resourceLoader: DefaultResourceLoader;
  modelRegistry: ModelRegistry;
}

export async function createPiContext(params: {
  cwd: string;
  resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd">;
}): Promise<PiContext> {
  const resourceLoader = createPiResourceLoader({
    ...params.resourceLoaderOptions,
    cwd: params.cwd,
  });
  await resourceLoader.reload();

  const authStorage = createDbBackedAuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);

  return {
    authStorage,
    resourceLoader,
    modelRegistry,
  };
}
