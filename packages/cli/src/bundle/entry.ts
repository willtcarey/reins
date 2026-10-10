/**
 * The node bundle's entry: `reins.js`, the `reins` command and all of the node in one file, built by the
 * server (`buildNodeBundle`, packages/backend/src/node-bundle/build.ts) and run as `bun --no-install
 * <dir>/reins.js …`. Bundle only (embedded-docs.ts fails from source); `bun run reins` runs cli.ts. See
 * docs/dev/node-bundle.md.
 *
 * Before any of Pi is evaluated (Pi reads `PI_PACKAGE_DIR` as its modules load), it sets what Pi and the
 * node need of the environment, where the launcher has not: `PI_PACKAGE_DIR` is the bundle's directory, so
 * Pi does not adopt the `package.json` of a directory above it; `PI_OFFLINE=1`, so Pi never installs the
 * packages its settings list; `REINS_DOCS_DIR` is `<dir>/docs`, where it writes the docs it carries
 * (`unpackDocs`) unless they are there. Then it registers the Pi modules a bundle cannot load lazily
 * (`registerBundledPiModules`) and runs the command line, telling it the bundle it runs from, hashed here
 * once (`runningBundle`: its build ID, and whether a launcher runs it again; `reins node setup` installs it,
 * `reins node run` announces its build).
 */
import { join } from "node:path";
import { unpackDocs } from "./docs.js";
import { embeddedDocs } from "./embedded-docs.js";
import { applyBundleEnv } from "./env.js";

const dir = import.meta.dir;
applyBundleEnv(process.env, dir);
try {
  await unpackDocs(dir, embeddedDocs);
} catch (error) {
  console.error(`[reins] could not write the docs to ${join(dir, "docs")}: ${error instanceof Error ? error.message : String(error)}`);
}

const { registerBundledPiModules } = await import("@reins/node/bundled-pi");
registerBundledPiModules();
const { runCli } = await import("../cli.js");
const { processContext } = await import("../command.js");
const { runningBundle } = await import("../node/install.js");
process.exit(await runCli(process.argv.slice(2), { ...processContext(), bundle: await runningBundle(import.meta.path, process.env) }));
