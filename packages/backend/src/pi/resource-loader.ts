import {
  DefaultResourceLoader,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import claudeAgentSdkExtension from "./vendor/claude-agent-sdk-pi.js";

const PI_EXTENSION_FACTORIES: ExtensionFactory[] = [claudeAgentSdkExtension];

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export function createPiResourceLoader(options: DefaultResourceLoaderOptions = {}): DefaultResourceLoader {
  const extensionFactories = [...PI_EXTENSION_FACTORIES, ...(options.extensionFactories ?? [])];

  return new DefaultResourceLoader({
    ...options,
    extensionFactories,
  });
}
