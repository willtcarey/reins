/**
 * An installed node's code in its node home (`REINS_NODE_DATA_DIR`, default `~/.reins`): what the install
 * script and `reins node setup` (setup.ts) put there, beside the pairing (config.ts) and the running
 * node's files (background.ts). See docs/dev/node-bundle.md *The node home*.
 *
 *   bun                      the pinned Bun (the install script's)
 *   builds/<buildId>/        reins.js, the node bundle, and the docs it unpacks beside itself
 *   current -> builds/<id>   the build the launcher runs
 *   bin/reins                the launcher
 *   logs/node.log            the detached node's output (background.ts)
 *
 * The build ID is the bundle's sha256, as the server names it.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** The exit code that has the launcher run the node again at once, on whatever `current` then names: a
 * node that flipped `current` to a new build exits with it. 75 (EX_TEMPFAIL), like the supervisor's
 * reload code. */
export const RESTART_EXIT_CODE = 75;

export function launcherPath(home: string): string {
  return join(home, "bin", "reins");
}

/** The sha256 of a bundle's bytes, in hex: its build ID. */
export async function bundleBuildId(bundle: string): Promise<string> {
  return createHash("sha256").update(await Bun.file(bundle).bytes()).digest("hex");
}

/** The build `current` names, or null when there is none. */
export async function currentBuildId(home: string): Promise<string | null> {
  const target = await readlink(join(home, "current")).catch(() => null);
  return target === null ? null : basename(target);
}

/**
 * Makes the bundle at `bundle` the home's current build: it is put in `builds/<buildId>/reins.js` if it
 * runs from elsewhere (a copy renamed into place), and `current` is flipped to it atomically (a new
 * symlink renamed over the old one), so the launcher always finds a whole build. Resolves with the build ID.
 */
export async function activateBuild(home: string, bundle: string): Promise<string> {
  const buildId = await bundleBuildId(bundle);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const dir = join(home, "builds", buildId);
  const installed = join(dir, "reins.js");
  const inPlace = await realpath(installed).then(path => realpath(bundle).then(own => own === path), () => false);
  if (!inPlace && await bundleBuildId(installed).catch(() => null) !== buildId) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await replace(installed, temp => copyFile(bundle, temp));
  }
  await replace(join(home, "current"), temp => symlink(join("builds", buildId), temp));
  return buildId;
}

/**
 * Writes the launcher, `bin/reins`: a few lines of sh with the home written in, which run the current
 * build with `REINS_NODE_DATA_DIR` set to the home and `REINS_NODE_RESTART_EXIT_CODE` to `RESTART_EXIT_CODE`
 * (so a node knows something restarts it), and run it again whenever it exits with that code; any other
 * exit is the launcher's. The same home writes the same launcher, so
 * writing it again changes nothing. Resolves with its path.
 */
export async function writeLauncher(home: string): Promise<string> {
  const path = launcherPath(home);
  await mkdir(join(home, "bin"), { recursive: true, mode: 0o700 });
  await replace(path, async temp => {
    await writeFile(temp, launcherScript(home), { mode: 0o755 });
    await chmod(temp, 0o755);
  });
  return path;
}

function launcherScript(home: string): string {
  return `#!/bin/sh
# The Reins node launcher, written by \`reins node setup\`: runs the node home's current build, and runs it
# again when it exits with ${RESTART_EXIT_CODE} (a new build was made current). See docs/dev/node-bundle.md.
REINS_NODE_DATA_DIR=${shellQuote(home)}
REINS_NODE_RESTART_EXIT_CODE=${RESTART_EXIT_CODE}
export REINS_NODE_DATA_DIR REINS_NODE_RESTART_EXIT_CODE
while :; do
  "$REINS_NODE_DATA_DIR/bun" --no-install "$REINS_NODE_DATA_DIR/current/reins.js" "$@"
  status=$?
  [ "$status" -eq ${RESTART_EXIT_CODE} ] || exit "$status"
done
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Puts a new file at `path` by writing it under a temporary name beside it (`write`) and renaming that
 * over `path`, so a reader sees the old one or the new one. */
async function replace(path: string, write: (temp: string) => Promise<void>): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await write(temp);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
