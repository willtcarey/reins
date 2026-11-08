/** The `reins` key of an added extension's `package.json` (docs/features/building-extensions.md *The manifest*). */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import sdkPackage from "../../../sdk/package.json";

/** The SDK version this Reins provides (`@reins/sdk`'s); a manifest's `sdk` range must include it. */
export const SDK_VERSION = sdkPackage.version;

const EXTENSION_NAME = "^[a-z][a-z0-9-]*$";
const MAX_ICON_BYTES = 16 * 1024;

const ManifestSchema = Type.Object({
  name: Type.String({ pattern: EXTENSION_NAME, maxLength: 64 }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 300 })),
  /** An SVG file, drawn in `currentColor` beside its label. */
  icon: Type.Optional(Type.String({ minLength: 1 })),
  /** A semver range of the SDK it was written for. */
  sdk: Type.String({ minLength: 1 }),
  backend: Type.Optional(Type.String({ minLength: 1 })),
  /** Its directory is what browsers may load: its chunks and files. */
  frontend: Type.Optional(Type.String({ minLength: 1 })),
  /** A stylesheet in the frontend directory, which Reins scopes to the extension's views when it installs it. */
  styles: Type.Optional(Type.String({ minLength: 1 })),
  /** Reserved for parts that run on nodes, which the server would install there: not supported yet. */
  node: Type.Optional(Type.Unknown()),
}, { additionalProperties: false });

export type ManifestFields = Static<typeof ManifestSchema>;

/** A manifest as Reins uses it: its entries absolute, inside the extension's directory. */
export interface Manifest {
  name: string;
  label: string;
  description: string | null;
  version: string;
  sdk: string;
  icon: string | null;
  iconFile: string | null;
  backend: string | null;
  frontend: string | null;
  styles: string | null;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export async function readManifest(dir: string): Promise<Manifest> {
  const file = join(dir, "package.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ManifestError(`No package.json in ${dir}`);
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof pkg !== "object" || pkg === null || !("reins" in pkg)) throw new ManifestError(`${file} has no "reins" key: it is not a Reins extension`);
  const fields: unknown = pkg.reins;
  if (!Value.Check(ManifestSchema, fields)) {
    const first = Value.Errors(ManifestSchema, fields).First();
    throw new ManifestError(`Its manifest ("reins" in package.json) is invalid: ${first ? `${first.path || "/"}: ${first.message}` : "does not match"}`);
  }
  const version = "version" in pkg && typeof pkg.version === "string" ? pkg.version : "0.0.0";
  if (fields.node !== undefined) throw new ManifestError("Its manifest has a node part, which this Reins cannot install yet");
  if (!fields.backend && !fields.frontend) throw new ManifestError("Its manifest names neither a backend nor a frontend entry");
  if (!Bun.semver.satisfies(SDK_VERSION, fields.sdk)) throw new ManifestError(`It needs SDK ${fields.sdk}; this Reins provides ${SDK_VERSION}`);
  const icon = fields.icon ? await readIcon(dir, fields.icon) : null;
  const frontend = fields.frontend ? inside(dir, fields.frontend, "frontend") : null;
  if (frontend && dirname(frontend) === resolve(dir)) {
    throw new ManifestError(`Its frontend file ${relative(dir, frontend)} must be in a directory of its own (such as dist/): Reins copies that whole directory`);
  }
  const styles = fields.styles ? inside(dir, fields.styles, "styles") : null;
  if (styles && !frontend) throw new ManifestError("Its manifest names styles but no frontend: styles are for a frontend part's views");
  if (styles && frontend && relative(dirname(frontend), styles).startsWith("..")) {
    throw new ManifestError(`Its styles file ${relative(dir, styles)} must be in its frontend directory (${relative(dir, dirname(frontend))})`);
  }
  return {
    name: fields.name,
    label: fields.label,
    description: fields.description ?? null,
    version,
    sdk: fields.sdk,
    icon,
    iconFile: fields.icon ? inside(dir, fields.icon, "icon") : null,
    backend: fields.backend ? inside(dir, fields.backend, "backend") : null,
    frontend,
    styles,
  };
}

function inside(dir: string, entry: string, field: string): string {
  const path = resolve(dir, entry);
  const rel = relative(dir, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new ManifestError(`Its ${field} entry ${entry} is outside its directory`);
  return path;
}

async function readIcon(dir: string, entry: string): Promise<string> {
  const path = inside(dir, entry, "icon");
  let svg: string;
  try {
    svg = await readFile(path, "utf8");
  } catch {
    throw new ManifestError(`Its icon ${entry} cannot be read`);
  }
  if (svg.length > MAX_ICON_BYTES) throw new ManifestError(`Its icon ${entry} is larger than ${MAX_ICON_BYTES / 1024} KiB`);
  if (!/<svg[\s>]/.test(svg)) throw new ManifestError(`Its icon ${entry} is not an SVG`);
  return svg;
}
