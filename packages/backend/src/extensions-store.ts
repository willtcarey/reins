/** The `extensions` table (core migration 065): which extensions exist and which are on. Only `Extensions` reads it. */

import { getDb } from "./app-globals.js";

export type ExtensionSource = { kind: "built-in" } | { kind: "path"; path: string };

export interface ExtensionRow {
  name: string;
  source: ExtensionSource;
  enabled: boolean;
  /** In bundle URLs, so browsers import again after a reload even when the build did not change. */
  generation: number;
  /** An added one's installed copy (`<builds dir>/<name>/<build ID>`); null before its first install. */
  buildId: string | null;
}

export interface AddedExtensionRow extends ExtensionRow { source: { kind: "path"; path: string } }

interface Row { name: string; source_kind: string; path: string | null; enabled: number; generation: number; build_id: string | null }

const COLUMNS = "name, source_kind, path, enabled, generation, build_id";

export function recordBuiltInExtensions(names: readonly string[]): void {
  const insert = getDb().query("INSERT OR IGNORE INTO extensions (name, source_kind) VALUES (?, 'built-in')");
  for (const name of names) insert.run(name);
}

export function getExtensionRow(name: string): ExtensionRow | null {
  const row = getDb().query<Row, [string]>(`SELECT ${COLUMNS} FROM extensions WHERE name = ?`).get(name);
  return row && toRow(row);
}

export function listAddedExtensions(): AddedExtensionRow[] {
  return getDb().query<Row, []>(`SELECT ${COLUMNS} FROM extensions WHERE source_kind = 'path' ORDER BY added_at, name`).all()
    .map(toRow).filter(isAdded);
}

export function insertAddedExtension(name: string, path: string): void {
  getDb().query("INSERT INTO extensions (name, source_kind, path) VALUES (?, 'path', ?)").run(name, path);
}

export function setExtensionEnabled(name: string, enabled: boolean): void {
  getDb().query("UPDATE extensions SET enabled = ? WHERE name = ?").run(enabled ? 1 : 0, name);
}

export function bumpExtensionGeneration(name: string): void {
  getDb().query("UPDATE extensions SET generation = generation + 1 WHERE name = ?").run(name);
}

export function setExtensionBuild(name: string, buildId: string): void {
  getDb().query("UPDATE extensions SET build_id = ? WHERE name = ?").run(buildId, name);
}

export function deleteExtensionRow(name: string): void {
  getDb().query("DELETE FROM extensions WHERE name = ?").run(name);
}

export function isAdded(row: ExtensionRow): row is AddedExtensionRow {
  return row.source.kind === "path";
}

function toRow({ name, source_kind, path, enabled, generation, build_id }: Row): ExtensionRow {
  return {
    name,
    source: source_kind === "path" && path !== null ? { kind: "path", path } : { kind: "built-in" },
    enabled: enabled === 1,
    generation,
    buildId: build_id,
  };
}
