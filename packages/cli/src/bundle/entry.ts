/**
 * The node bundle's entry: `reins.js`, the `reins` command and all of the node in one file, built by the
 * server (`buildNodeBundle`, packages/backend/src/node-bundle/build.ts) and run as `bun --no-install
 * <dir>/reins.js …`. Bundle only (embedded-docs.ts fails from source); `bun run reins` runs cli.ts. See
 * docs/dev/node-bundle.md.
 *
 * It sets what the node needs of the environment, where the launcher has not (`applyBundleEnv`, with the
 * node's install in `@reins/node/install`): `REINS_DOCS_DIR` is `<dir>/docs`, where it writes the docs it
 * carries (`unpackDocs`) unless they are there. Then it runs the command line, telling it the bundle it
 * runs from, hashed here once (`runningBundle`: its build ID, and whether a launcher runs it again;
 * `reins node setup` installs it, `reins node run` announces its build).
 */
import { join } from "node:path";
import { applyBundleEnv, runningBundle } from "@reins/node/install";
import { runCli } from "../cli.js";
import { processContext } from "../command.js";
import { unpackDocs } from "./docs.js";
import { embeddedDocs } from "./embedded-docs.js";

const dir = import.meta.dir;
applyBundleEnv(process.env, dir);
try {
  await unpackDocs(dir, embeddedDocs);
} catch (error) {
  console.error(`[reins] could not write the docs to ${join(dir, "docs")}: ${error instanceof Error ? error.message : String(error)}`);
}

process.exit(await runCli(process.argv.slice(2), { ...processContext(), bundle: await runningBundle(import.meta.path, process.env) }));
