/**
 * The libraries the app provides to added extensions' frontend parts (docs/dev/extension-loading.md
 * *Provided libraries*): each public module of Lit, built as ES modules into `dist/vendor/lit/` with their
 * shared code split into chunks, so every extension that imports `lit` and `lit/decorators.js` gets one Lit.
 * index.html's import map points `lit` and `lit/` there. Extensions build with these left external.
 *
 * Run by the frontend's build (`bun src/vendor/build.ts`) and by the dev supervisor before its watchers.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FRONTEND = join(import.meta.dir, "../..");

/** Builds the provided libraries into `outdir` (`dist/vendor` by default). Throws with the build's logs. */
export async function buildVendor(outdir = join(FRONTEND, "dist/vendor")): Promise<void> {
  const root = dirname(Bun.resolveSync("lit/package.json", FRONTEND));
  const exports: Record<string, unknown> = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports;
  const entrypoints = Object.keys(exports)
    .filter(key => key !== "./polyfill-support.js")
    .map(key => join(root, key === "." ? "index.js" : key));
  const result = await Bun.build({
    entrypoints,
    root,
    outdir: join(outdir, "lit"),
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
    throw: false,
  });
  if (!result.success) throw new Error(`Building the provided libraries failed:\n${result.logs.join("\n")}`);
}

if (import.meta.main) await buildVendor();
