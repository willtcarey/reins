/**
 * An added extension's built files (docs/dev/extension-loading.md *Built files*): in its author's directory, and
 * the copy Reins installs, which it loads from. Reins builds nothing: a file the manifest names must be there.
 */

import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Migration, ServerExtension } from "@reins/sdk/server";
import { ManifestError, readManifest, type Manifest } from "./manifest.js";
import { scopeStyles } from "./styles.js";

/** The scoped stylesheet's path in a bundle URL. `~` keeps it apart from the author's files, which a
 * bundler names without it. */
export const SCOPED_STYLES = "~styles.css";
/** Where an install writes it in the copy: outside the frontend directory, so it is not in the build ID. */
const SCOPED_STYLES_FILE = ".reins/styles.css";

/** `manifest` is the manifest once read, so a failed extension can still be named. */
export class PackageFailure extends Error {
  constructor(readonly stage: "manifest" | "load", readonly manifest: Manifest | null, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PackageFailure";
  }
}

export interface ExtensionPackage {
  readonly dir: string;
  readonly manifest: Manifest;
  /** A hash of every file in `files`, so a change to any of them (a chunk too) is a new URL. */
  readonly buildId: string;
  /** What an install copies, relative to `dir`: the manifest, the backend file, the icon and the frontend
   * directory. Never the sources or `node_modules`. */
  readonly files: readonly string[];
  readonly frontendEntry: string | null;
  /** `SCOPED_STYLES` when the package is an installed copy with a stylesheet; null otherwise. */
  readonly styles: string | null;
  /** Never the backend file, nor one outside the frontend directory: browsers may load only those. */
  file(path: string): Promise<string | null>;
  /** Another module instance at each call, so a reload runs the new code. */
  importBackend(): Promise<ServerExtension | null>;
}

/** `installed`: the build ID of an installed copy, its directory's name, so its files are not hashed again. */
export async function openPackage(dir: string, name: string, installed?: { buildId: string }): Promise<ExtensionPackage> {
  let manifest: Manifest;
  try {
    manifest = await readManifest(dir);
    if (manifest.name !== name) throw new ManifestError(`Its manifest now names it ${manifest.name}: remove ${name} and add it again`);
  } catch (error) {
    throw new PackageFailure("manifest", null, error);
  }
  let files: string[];
  let buildId: string;
  try {
    files = await packageFiles(dir, manifest);
    buildId = installed?.buildId ?? await filesHash(dir, files);
  } catch (error) {
    throw new PackageFailure("load", manifest, error);
  }
  const { backend, frontend } = manifest;
  const frontendDir = frontend ? dirname(frontend) : null;
  const scopedStyles = join(dir, SCOPED_STYLES_FILE);
  const styles = manifest.styles && (await stat(scopedStyles).catch(() => null)) ? SCOPED_STYLES : null;
  return {
    dir,
    manifest,
    buildId,
    files,
    frontendEntry: frontend && frontendDir ? relative(frontendDir, frontend).split("/").map(encodeURIComponent).join("/") : null,
    styles,
    async file(path) {
      if (styles && path === SCOPED_STYLES) return scopedStyles;
      if (!frontendDir) return null;
      const file = resolve(frontendDir, path);
      const inside = relative(frontendDir, file);
      if (inside === "" || inside.startsWith("..") || isAbsolute(inside) || file === backend) return null;
      return (await stat(file).catch(() => null))?.isFile() ? file : null;
    },
    async importBackend() {
      if (!backend) return null;
      try {
        return await importBackend(backend);
      } catch (error) {
        throw new PackageFailure("load", manifest, error);
      }
    },
  };
}

/** The query makes Bun evaluate the module anew: its module cache is keyed by the URL. */
async function importBackend(file: string): Promise<ServerExtension> {
  const module: unknown = await import(`${file}?load=${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const extension = typeof module === "object" && module !== null && "default" in module ? module.default : undefined;
  if (typeof extension !== "object" || extension === null || !("register" in extension) || typeof extension.register !== "function") {
    throw new Error("Its backend module's default export must be { register, migrations? }");
  }
  const register = extension.register;
  const declared = "migrations" in extension ? extension.migrations : [];
  if (!Array.isArray(declared)) throw new Error("Its migrations must be a list");
  const migrations: Migration[] = declared.map((migration: unknown, index) => {
    if (typeof migration !== "object" || migration === null || !("id" in migration) || typeof migration.id !== "string"
      || !("up" in migration) || typeof migration.up !== "function") {
      throw new Error(`Its migration ${index + 1} must be { id, up(db) }`);
    }
    const up = migration.up;
    return { id: migration.id, up: db => { Reflect.apply(up, migration, [db]); } };
  });
  return {
    migrations,
    register: sdk => {
      const dispose: unknown = Reflect.apply(register, extension, [sdk]);
      if (isThenable(dispose)) {
        // Not awaited: what it registers after its first await would be registered after it was started, and
        // its errors would be unhandled. Its rejection is dropped, as the load fails with this error.
        void Promise.resolve(dispose).catch(() => {});
        throw new Error("Its register function returned a promise: it must register synchronously (start async work in a service)");
      }
      return async () => { if (typeof dispose === "function") await Reflect.apply(dispose, undefined, []); };
    },
  };
}

/**
 * Copies the package into `<buildsDir>/<name>/<build ID>/` and opens the copy. A build already there is used as
 * it is: copies never change, which is what lets browsers cache their files for good. The copy is written
 * aside and renamed into place, so a failed or interrupted one is never loaded.
 */
export async function installPackage(pkg: ExtensionPackage, buildsDir: string): Promise<ExtensionPackage> {
  const { name, styles } = pkg.manifest;
  // Each file is read once, and its build ID and its copy are made of those bytes: a build writing the files
  // meanwhile must not give a copy whose content is not its ID's, which every later install would reuse.
  let contents: Uint8Array[];
  try {
    contents = await Promise.all(pkg.files.map(file => readFile(join(pkg.dir, file))));
  } catch (error) {
    throw new PackageFailure("load", pkg.manifest, error);
  }
  const buildId = contentsHash(pkg.files, contents);
  const target = join(buildsDir, name, buildId);
  if (!(await stat(target).catch(() => null))) {
    const partial = `${target}.partial-${Math.random().toString(36).slice(2)}`;
    try {
      for (const [index, file] of pkg.files.entries()) {
        await mkdir(dirname(join(partial, file)), { recursive: true });
        await writeFile(join(partial, file), contents[index]!);
      }
      if (styles) {
        const css = contents[pkg.files.indexOf(relative(pkg.dir, styles))]!;
        await mkdir(dirname(join(partial, SCOPED_STYLES_FILE)), { recursive: true });
        await writeFile(join(partial, SCOPED_STYLES_FILE), scopeStyles(new TextDecoder().decode(css), name));
      }
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      if (!(await stat(target).catch(() => null))) throw new PackageFailure("load", pkg.manifest, error);
    }
  }
  return openPackage(target, name, { buildId });
}

/** The installed copy of `buildId`, or null when there is none (never installed, or deleted). */
export async function openInstalled(buildsDir: string, name: string, buildId: string): Promise<ExtensionPackage | null> {
  const dir = join(buildsDir, name, buildId);
  return (await stat(dir).catch(() => null)) ? openPackage(dir, name, { buildId }) : null;
}

/** Deletes the extension's copies but `keep` (all when null). */
export async function removeBuilds(buildsDir: string, name: string, keep: string | null = null): Promise<void> {
  const dir = join(buildsDir, name);
  if (keep === null) return rm(dir, { recursive: true, force: true });
  const builds = await readdir(dir).catch(() => []);
  await Promise.all(builds.filter(build => build !== keep).map(build => rm(join(dir, build), { recursive: true, force: true })));
}

async function packageFiles(dir: string, manifest: Manifest): Promise<string[]> {
  for (const [part, file] of [["backend", manifest.backend], ["frontend", manifest.frontend], ["styles", manifest.styles]] as const) {
    if (file && !(await stat(file).catch(() => null))?.isFile()) {
      throw new Error(`Its ${part} file ${relative(dir, file)} does not exist: build the extension first`);
    }
  }
  const files = new Set(["package.json"]);
  for (const file of [manifest.backend, manifest.iconFile]) if (file) files.add(relative(dir, file));
  if (manifest.frontend) {
    const frontendDir = dirname(manifest.frontend);
    for (const entry of await readdir(frontendDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files.add(relative(dir, join(entry.parentPath, entry.name)));
    }
  }
  return [...files].toSorted();
}

/** Part of every build ID: raise it when an install processes files differently (how it scopes styles), so
 * that a copy made the old way is not used again. */
const INSTALL_VERSION = 2;

async function filesHash(dir: string, files: readonly string[]): Promise<string> {
  return contentsHash(files, await Promise.all(files.map(file => readFile(join(dir, file)))));
}

function contentsHash(files: readonly string[], contents: readonly Uint8Array[]): string {
  const hash = createHash("sha256").update(`reins-install:${INSTALL_VERSION}\0`);
  files.forEach((file, index) => hash.update(file).update("\0").update(contents[index]!).update("\0"));
  return hash.digest("hex").slice(0, 16);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
