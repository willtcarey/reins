/** The report (`GET /api/installed-extensions`): what Settings, the CLI and browsers read of each extension. */

import { statSync } from "fs";
import type { Migration } from "@reins/sdk/server";
import type { ExtensionStorage } from "../database.js";
import type { ExtensionSource } from "../extensions-store.js";
import { extensionSecretKeys } from "../extension-secrets-store.js";
import type { ServiceView } from "./services.js";
import type { ExtensionHost } from "./host.js";
import type { ExtensionRecord } from "./extensions.js";


export interface ExtensionOrigin {
  source: ExtensionSource;
  manifest: { label: string; description: string | null; version: string; icon: string | null } | null;
  /** `styles`: its stylesheet as Reins scoped it, which browsers link while its frontend part is active. */
  build: { id: string; frontend: { script: string; styles: string | null } | null } | null;
  /** Whether it has a backend part: not a built-in with only a frontend part, nor an added one whose
   * manifest names no backend file. */
  backendPart: boolean;
}

export interface ExtensionView {
  name: string;
  status: "loaded" | "failed" | "loading" | "disabled";
  /** `manifest` and `load` (a file it names is missing, or its module could not be imported or is not an
   * extension) are an added extension's stages, before the others. */
  failure: { stage: "manifest" | "load" | "storage" | "migration" | "register"; message: string } | null;
  source: ExtensionSource;
  manifest: ExtensionOrigin["manifest"];
  build: ExtensionOrigin["build"];
  backendPart: ExtensionOrigin["backendPart"];
  /** Frontend parts fail in browsers, not here: the last browser that loaded it says how. */
  frontendFailure: { message: string; at: string } | null;
  errors: { message: string; at: string }[];
  registrations: {
    /** Its tool provider. No count of tools: that would ask the provider, which may go to the network. */
    tools: { title: string } | null;
    promptSections: number;
    settlementListeners: number;
    scriptFunctions: string[];
    httpMethods: string[];
    pages: string[];
  };
  services: ServiceView[];
  storage: {
    dataDir: string;
    /** `db.sqlite` with its WAL file, on disk. */
    databaseBytes: number;
    migrations: { applied: { id: string; appliedAt: string }[]; pending: string[] };
    /** How many secrets it keeps: not their keys, which can name the user's things (a server's ID), nor values. */
    secrets: number;
  } | null;
}

export function describe({ name, origin, state, errors, frontendFailure }: ExtensionRecord, host: ExtensionHost): ExtensionView {
  const backend = state.kind === "loaded" ? state.backend : state.kind === "failed" ? state.backend : null;
  return {
    name,
    status: state.kind,
    failure: state.kind === "failed" ? { stage: state.stage, message: state.message } : null,
    source: origin.source,
    manifest: origin.manifest,
    build: origin.build,
    backendPart: origin.backendPart,
    frontendFailure,
    errors: [...errors],
    registrations: host.registrationsOf(name),
    services: host.servicesOf(name),
    storage: backend?.storage ? storageView(name, backend.storage, backend.migrations) : null,
  };
}

function storageView(extension: string, { dataDir, db }: ExtensionStorage, migrations: readonly Migration[]): NonNullable<ExtensionView["storage"]> {
  let applied: { id: string; appliedAt: string }[] = [];
  try {
    applied = db.query<{ id: string; appliedAt: string }, []>("SELECT id, applied_at AS appliedAt FROM reins_migrations ORDER BY rowid").all();
  } catch {
    // No table yet: the migrations' check failed before the host made it.
  }
  const ids = new Set(applied.map(migration => migration.id));
  return {
    dataDir,
    databaseBytes: fileSize(db.filename) + fileSize(`${db.filename}-wal`),
    migrations: { applied, pending: migrations.map(migration => migration.id).filter(id => !ids.has(id)) },
    secrets: extensionSecretKeys(extension).length,
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

