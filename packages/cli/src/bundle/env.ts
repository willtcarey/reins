/**
 * What the node bundle's entry (entry.ts) sets of the environment for itself, from the directory it runs
 * from, before any of Pi is evaluated; and what a process it starts must not inherit of that. See
 * docs/dev/node-bundle.md *Running it*.
 */
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** Named after the build's directory: another build started from this one must find its own. */
const BUILD_ENV = new Set(["PI_PACKAGE_DIR", "REINS_DOCS_DIR"]);

/**
 * Sets, where unset (an empty value counts as unset): `PI_PACKAGE_DIR` to `dir`, so Pi does not adopt the
 * `package.json` of a directory above it; `PI_OFFLINE=1`, so Pi never installs the packages its settings
 * list; `REINS_DOCS_DIR` to `<dir>/docs`, where the entry writes the docs it carries.
 */
export function applyBundleEnv(env: Env, dir: string): void {
  env.PI_PACKAGE_DIR ||= dir;
  env.PI_OFFLINE ||= "1";
  env.REINS_DOCS_DIR ||= join(dir, "docs");
}

/** `env` without what names the running build's directory (`applyBundleEnv`). */
export function withoutBundleEnv(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !BUILD_ENV.has(name)));
}
