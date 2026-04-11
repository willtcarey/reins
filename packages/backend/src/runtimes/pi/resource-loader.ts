import { DefaultResourceLoader } from "@mariozechner/pi-coding-agent";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

export function createPiResourceLoader(options: DefaultResourceLoaderOptions = {}): DefaultResourceLoader {
  return new DefaultResourceLoader(options);
}
