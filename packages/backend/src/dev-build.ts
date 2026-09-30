/**
 * The dev server's handler bundle (see docs/dev/hot-reload.md). Owned by `server-process.ts`, which is
 * restart-required, so changes here need a server restart.
 *
 * Bundles product sources and reloadable workspace packages (telemetry). Process-owned
 * `@reins/node-protocol`, third-party packages and builtins stay external, with one module instance
 * across reloads (error constructors and Pi's provider registry, for example).
 */
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BunPlugin } from "bun";

/** Workspace packages are bundled unless explicitly process-owned (node-protocol). */
export const WORKSPACE_SCOPE = "@reins/";

/** Active process-owned code is not replaced by an HTTP-handler reload. */
export const RESTART_REQUIRED_SOURCES = new Set([
  "index.ts", "server-process.ts", "state.ts", "dev-build.ts", "db.ts", "logger.ts",
  "runtimes/node-hub.ts", "node-transport/server-peer.ts", "node-transport/local-socket.ts", "node-transport/commands.ts",
  "models/node-command-dispatcher.ts", "models/node-command-delivery.ts", "models/node-command-notifications.ts",
  "models/broadcast.ts", "node-command-store.ts", "node-command-recovery.ts", "session-store.ts",
]);

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
      // Rewrite static references to process-owned modules to external file URLs. Keeping a relative
      // import external would resolve it against .dev-build, not src/. This also prevents a later
      // route reload from accidentally bundling an edited copy of the dispatcher, stores or database.
      const source = (await Bun.file(args.path).text()).replace(
        /\b(from\s*|import\s*)(["'])([^"']+)\2/g,
        (match, prefix: string, quote: string, specifier: string) => {
          if (!specifier.startsWith(".")) return match;
          const target = resolve(dirname(args.path), specifier.replace(/\.js$/, ".ts"));
          return RESTART_REQUIRED_SOURCES.has(relative(import.meta.dirname, target))
            ? `${prefix}${quote}${pathToFileURL(target).href}${quote}` : match;
        },
      );
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
