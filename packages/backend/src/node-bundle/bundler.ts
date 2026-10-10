/**
 * `bun bundler.ts <outfile> [--test-hooks]`: the node bundle's `Bun.build`, run by `buildNodeBundle`
 * (build.ts) in a process of its own. In a process that has already loaded some of the same files (Pi, which
 * the server loads too), Bun 1.3.9 can fail to read them for a build ("Unexpected reading file", seen
 * after `bun test` moves to another test file), and the build's memory goes when the process does.
 *
 * Writes the bundle to `<outfile>` and prints one JSON line, `{"externals": [...]}`: every import left
 * external. On a failed build it prints the build's logs to stderr and exits 1.
 */
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const ENTRY = join(REPO_ROOT, "packages/cli/src/bundle/entry.ts");
/** Replaced in the build by the docs it carries. */
const EMBEDDED_DOCS_MODULE = join(REPO_ROOT, "packages/cli/src/bundle/embedded-docs.ts");
const DOCS_DIR = join(REPO_ROOT, "docs");
/** The docs the bundle carries, under `DOCS_DIR`. */
const SHIPPED_DOCS = ["features"];

/** Every file of the shipped docs, by path under `DOCS_DIR`, sorted so the bytes do not depend on the
 * order the file system lists them in. */
async function readShippedDocs(): Promise<Array<{ path: string; text: string }>> {
  const docs: Array<{ path: string; text: string }> = [];
  for (const dir of SHIPPED_DOCS) {
    for (const entry of await readdir(join(DOCS_DIR, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      docs.push({ path: relative(DOCS_DIR, path).split(sep).join("/"), text: await Bun.file(path).text() });
    }
  }
  return docs.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The bundle's copy of embedded-docs.ts: the docs it carries. */
function embeddedDocs(docs: ReadonlyArray<{ path: string; text: string }>): BunPlugin {
  return {
    name: "reins-embedded-docs",
    setup(build) {
      const filter = new RegExp(`^${EMBEDDED_DOCS_MODULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      build.onLoad({ filter }, () => ({ contents: `export const embeddedDocs = ${JSON.stringify(docs)};`, loader: "js" }));
    },
  };
}

/** Photon (Pi's image resizing) reads its WASM through CommonJS `__dirname`, which Bun writes as the build
 * machine's path. The node never resizes images, and Pi treats a photon that fails to load as no resizing. */
const photonStub: BunPlugin = {
  name: "reins-photon-stub",
  setup(build) {
    build.onResolve({ filter: /^@silvia-odwyer\/photon-node$/ }, args => ({ path: args.path, namespace: "reins-photon-stub" }));
    build.onLoad({ filter: /.*/, namespace: "reins-photon-stub" }, () => ({ contents: "throw new Error(\"photon is not part of the Reins node bundle\");", loader: "js" }));
  },
};

const [outfile, ...flags] = process.argv.slice(2);
if (!outfile || flags.some(flag => flag !== "--test-hooks")) {
  process.stderr.write("Usage: bun bundler.ts <outfile> [--test-hooks]\n");
  process.exit(2);
}
const result = await Bun.build({
  entrypoints: [ENTRY],
  root: REPO_ROOT,
  target: "bun",
  format: "esm",
  metafile: true,
  define: {
    // The node's test hooks test the defined name itself (node-process.ts), so false eliminates their code.
    REINS_TEST_HOOKS: String(flags.includes("--test-hooks")),
    // Bun otherwise writes in this process's NODE_ENV in places, so the bytes would depend on it.
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [photonStub, embeddedDocs(await readShippedDocs())],
  throw: false,
});
const [output] = result.outputs;
if (!result.success || !output || result.outputs.length !== 1) {
  process.stderr.write(`${result.success ? `The build wrote ${result.outputs.length} files, not one` : result.logs.map(log => log.message).join("\n")}\n`);
  process.exit(1);
}
await Bun.write(outfile, output);
const externals = Object.values(result.metafile?.inputs ?? {}).flatMap(input => input.imports.filter(entry => entry.external).map(entry => entry.path));
process.stdout.write(`${JSON.stringify({ externals: [...new Set(externals)].toSorted() })}\n`);
