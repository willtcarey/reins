/**
 * The node bundle: `reins.js`, one platform-independent file holding the `reins` command and all of the
 * node, which the server builds from this checkout and hands to remote nodes (docs/dev/node-bundle.md).
 * Its build ID is the sha256 of its bytes, which also hold docs/features (the bundle writes them beside
 * itself), so one ID names the code and the docs it ships.
 *
 * The build itself (bundler.ts) runs in a `bun` process of its own. Its entry
 * (`packages/cli/src/bundle/entry.ts`) is read by path: the server never imports the CLI or the node (Oxlint
 * `reins/cli-import-boundary`, `reins/node-import-boundary`).
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const BUNDLER = join(import.meta.dir, "bundler.ts");

/** What bundler.ts prints. */
const bundlerOutput = z.object({ externals: z.array(z.string()) });

/** Not built in, but Bun provides them, so they may stay external. */
const BUN_PROVIDED = new Set(["ws", "undici", "node-fetch"]);

export interface NodeBundle {
  bytes: Uint8Array;
  /** The sha256 of `bytes`, in hex. */
  buildId: string;
}

export interface NodeBundleOptions {
  /** Keeps the node's test hooks (`REINS_NODE_TEST_FAUX_PROVIDER`), for process tests. Production bundles
   * leave their code out. */
  testHooks?: boolean;
}

/**
 * Builds the bundle. The same sources give the same bytes wherever the checkout is. Not minified: it is
 * about 2.3 MB gzipped against 1.9 MB, starts about 20 ms slower, and a node's stack traces stay readable.
 * Throws with the build's logs if it fails, or naming what makes it unshippable (`shippingProblems`).
 */
export async function buildNodeBundle(options: NodeBundleOptions = {}): Promise<NodeBundle> {
  const dir = await mkdtemp(join(tmpdir(), "reins-node-bundle-"));
  try {
    const outfile = join(dir, "reins.js");
    const proc = Bun.spawn([process.execPath, BUNDLER, outfile, ...options.testHooks ? ["--test-hooks"] : []], { cwd: REPO_ROOT, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`Node bundle build failed:\n${stderr.trim()}`);
    const { externals } = bundlerOutput.parse(JSON.parse(stdout));
    const bytes = new Uint8Array(await readFile(outfile));
    const problems = shippingProblems({ text: new TextDecoder().decode(bytes), externals }, [REPO_ROOT, `${homedir()}${sep}`]);
    if (problems.length > 0) throw new Error(`Node bundle is not shippable:\n${problems.join("\n")}`);
    return { bytes, buildId: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * What makes a built bundle unshippable, one line each: a path of the build machine in its text (`buildPaths`:
 * it would break on another machine, and make the build ID depend on where the checkout is), or an external
 * import Bun does not provide (with `--no-install` it fails to load; without, Bun fetches it from npm).
 */
export function shippingProblems(output: { text: string; externals: readonly string[] }, buildPaths: readonly string[]): string[] {
  const paths = buildPaths.filter(path => output.text.includes(path)).map(path => `It contains the build machine's path ${path}`);
  const externals = [...new Set(output.externals)].filter(specifier => !isBuiltin(specifier) && !BUN_PROVIDED.has(specifier))
    .map(specifier => `It imports ${specifier}, which Bun does not provide`);
  return [...paths, ...externals];
}
