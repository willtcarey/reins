/**
 * The dev server's handler bundle (see docs/dev/hot-reload.md), rebuilt by `server-process.ts` on every
 * reload. Changes here need a server restart.
 *
 * Bundles every local source the handler module reaches, node hub included, and the reloadable workspace
 * packages (telemetry), so a reload replaces all of it. `@reins/node-protocol`, third-party packages and
 * builtins stay external, with one module instance for the process (Pi's provider registry, for example).
 * The protocol stays external because the node does not hot reload: the server keeps the protocol it
 * started with until both restart.
 */
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { BunPlugin } from "bun";

/** Workspace packages are bundled, except node-protocol. */
const WORKSPACE_SCOPE = "@reins/";

const IMPORT_META = /\bimport\.meta\.(url|dirname|dir|filename|path)\b/g;

/** Bare specifiers outside the workspace scope, and node-protocol, are external. Bundled sources keep the paths they have
 * on disk: `import.meta.url`/`dirname`/`dir`/`filename`/`path` are replaced by the source file's own
 * values, so code that locates files relative to itself (e.g. the system prompt's docs paths) behaves as
 * it does unbundled. */
const devBundlePlugin: BunPlugin = {
  name: "reins-dev-bundle",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, args => (
      args.path.startsWith(WORKSPACE_SCOPE) && args.path !== "@reins/node-protocol"
        ? undefined : { path: args.path, external: true }
    ));
    build.onLoad({ filter: /\.tsx?$/ }, async args => {
      const values: Record<string, string> = {
        url: pathToFileURL(args.path).href,
        dirname: dirname(args.path),
        dir: dirname(args.path),
        filename: args.path,
        path: args.path,
      };
      return {
        contents: (await Bun.file(args.path).text()).replace(IMPORT_META, (_match, key: string) => JSON.stringify(values[key])),
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      };
    });
  },
};

/** Bundles `entrypoint` into `outdir` (as `<entry name>.js`); throws with the build logs on failure. */
export async function buildDevBundle(entrypoint: string, outdir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "bun",
    format: "esm",
    plugins: [devBundlePlugin],
  });
  if (!result.success) {
    const messages = result.logs.map(log => log.message ?? String(log)).join("\n");
    throw new Error(`Dev build failed:\n${messages}`);
  }
}
