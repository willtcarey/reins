import {
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  type AuthStorage,
} from "@mariozechner/pi-coding-agent";
import { createDbBackedAuthStorage } from "./auth-storage.js";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export interface PiContext {
  authStorage: AuthStorage;
  resourceLoader: DefaultResourceLoader;
  modelRegistry: ModelRegistry;
}

export async function createPiContext(params: {
  cwd: string;
  resourceLoaderOptions?: Partial<Omit<DefaultResourceLoaderOptions, "cwd">>;
}): Promise<PiContext> {
  const resourceLoader = new DefaultResourceLoader({
    agentDir: getAgentDir(),
    ...params.resourceLoaderOptions,
    cwd: params.cwd,
  });
  await resourceLoader.reload();

  const authStorage = createDbBackedAuthStorage();
  const modelRegistry = ModelRegistry.create(authStorage);

  return {
    authStorage,
    resourceLoader,
    modelRegistry,
  };
}
