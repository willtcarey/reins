/**
 * The dev server's handler bundle (see docs/dev/hot-reload.md). Owned by `server-process.ts`, which is
 * restart-required, so changes here need a server restart.
 *
 * Bundles the entrypoint with every workspace source it reaches: `src/` and the workspace packages
 * (`@reins/*`: `@reins/node-protocol` and `@reins/telemetry`), so a reload picks up changes to
 * either. Third-party packages and builtins stay external, imported by bare specifier from the bundle's location: they load once per
 * process and keep one module instance across reloads (Pi's provider registry, for example).
 */
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { BunPlugin } from "bun";

/** Bare specifiers of these scopes are workspace packages: bundled, not external. */
export const WORKSPACE_SCOPE = "@reins/";

const IMPORT_META = /\bimport\.meta\.(url|dirname|dir|filename|path)\b/g;

/** Every bare specifier outside the workspace scope is external. Bundled sources keep the paths they have
 * on disk: `import.meta.url`/`dirname`/`dir`/`filename`/`path` are replaced by the source file's own
 * values, so code that locates files relative to itself (e.g. the system prompt's docs paths) behaves as
 * it does unbundled. */
const devBundlePlugin: BunPlugin = {
  name: "reins-dev-bundle",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, args => (
      args.path.startsWith(WORKSPACE_SCOPE) ? undefined : { path: args.path, external: true }
    ));
    build.onLoad({ filter: /\.tsx?$/ }, async args => {
      const source = await Bun.file(args.path).text();
      const values: Record<string, string> = {
        url: pathToFileURL(args.path).href,
        dirname: dirname(args.path),
        dir: dirname(args.path),
        filename: args.path,
        path: args.path,
      };
      return {
        contents: source.replace(IMPORT_META, (_match, key: string) => JSON.stringify(values[key])),
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
