/**
 * Which extensions run in this app, and every operation on them (docs/dev/extensions-overview.md,
 * docs/dev/extension-loading.md). Added extensions run with the server's full trust, as built-ins do (ADR-038).
 */

import { isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";
import type { Migration, ServerExtension } from "@reins/sdk/server";
import type { ExtensionStorage } from "../database.js";
import { logger } from "../logger.js";
import type { Broadcast } from "../models/broadcast.js";
import {
  bumpExtensionGeneration, deleteExtensionRow, getExtensionRow, insertAddedExtension, isAdded, listAddedExtensions, recordBuiltInExtensions,
  setExtensionBuild, setExtensionEnabled, type AddedExtensionRow, type ExtensionRow,
} from "../extensions-store.js";
import { EXTENSION_NAME, ExtensionHost } from "./host.js";
import type { AppState } from "../state.js";
import { BackendFailure, startBackend, type RunningBackend } from "./backend.js";
import { installPackage, openInstalled, openPackage, PackageFailure, removeBuilds, type ExtensionPackage } from "./package.js";
import { ManifestError, readManifest, type Manifest } from "./manifest.js";
import { describe, type ExtensionOrigin, type ExtensionView } from "./report.js";
import { stopProcessesOfStoppedExtensions } from "./extension-processes.js";

export interface BuiltInBackendPart extends ServerExtension { name: string }

/** `/extension-bundles/<name>/<build ID>/<path in the frontend directory>`: the build ID in the URL lets
 * browsers cache a file for good. */
export const BUNDLES_PATH = "/extension-bundles";

type FailureStage = NonNullable<ExtensionView["failure"]>["stage"];

/**
 *   (no record) ─▶ loading ─▶ loaded        an added one: its package opened, its backend part started
 *        │            └─────▶ failed        manifest · load · storage · migration · register
 *        ├───────────────────▶ loaded       a built-in, at once (or failed)
 *        └───────────────────▶ disabled     turned off
 *
 * No state goes back: turning one off or on and reloading it delete the record and make a new one, so a late
 * load can tell it is stale (`current`) and nothing has to be undone in place.
 */
export type ExtensionState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "failed"; stage: FailureStage; message: string; backend: { storage: ExtensionStorage | null; migrations: readonly Migration[] } | null }
  | { kind: "loaded"; backend: RunningBackend | null };

export interface ExtensionRecord {
  readonly name: string;
  origin: ExtensionOrigin;
  state: ExtensionState;
  readonly errors: ExtensionView["errors"];
  frontendFailure: ExtensionView["frontendFailure"];
}

/** How many of an extension's later errors are kept: enough to see a pattern, not a log. */
const KEPT_ERRORS = 10;

const BUILT_IN_SOURCE = { kind: "built-in" } as const;

export class ExtensionsError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = "ExtensionsError";
  }
}

export interface ExtensionsOptions {
  /** Read at each SDK call, not kept: the state is built after this. */
  app: () => AppState;
  /** The core's script namespaces, which no extension may take. */
  reservedNamespaces: ReadonlySet<string>;
  builtIns: readonly BuiltInBackendPart[];
  /** Also those with only a frontend part, so they can be turned off and no added extension takes their name. */
  builtInNames: readonly string[];
  openStorage: (name: string) => ExtensionStorage;
  buildsDir: string;
  broadcast: Broadcast;
  onError: (extension: string, error: unknown) => void;
}

export class Extensions {
  private readonly records = new Map<string, ExtensionRecord>();
  private readonly packages = new Map<string, ExtensionPackage>();
  /** Two requests on one extension (a reload and a turn off) must not interleave their unload and load. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly builtIns: ReadonlyMap<string, BuiltInBackendPart | null>;
  private disposed = false;
  /** Settles when the added extensions `start` found have loaded or failed; tests await it. */
  loaded: Promise<void> = Promise.resolve();

  /** Owned here so that a record and what its extension registered come and go together. */
  readonly host: ExtensionHost;

  constructor(private readonly options: ExtensionsOptions) {
    this.host = new ExtensionHost(options.app, options.reservedNamespaces, (extension, error) => this.reportError(extension, error));
    this.builtIns = new Map([
      ...options.builtInNames.map(name => [name, null] as const),
      ...options.builtIns.map(registration => [registration.name, registration] as const),
    ]);
  }

  /** Added ones load in the background: importing them must not hold up the app. Once all are in, the processes
   * kept for extensions that did not load are stopped. */
  start(): void {
    this.registerBuiltIns();
    this.loaded = this.loadAllAdded().catch((error: unknown) => logger.error("Loading added extensions failed:", error))
      .then(() => this.settleProcesses());
  }



  private registerBuiltIns(): void {
    recordBuiltInExtensions([...this.builtIns.keys()]);
    for (const name of this.builtIns.keys()) {
      const row = getExtensionRow(name);
      if (row && isAdded(row)) {
        logger.error(`Built-in extension ${name} is not loaded: the extension added from ${row.source.path} has its name. Remove that one to use it.`);
      } else if (row) {
        this.startBuiltIn(row);
      }
    }
  }

  private async loadAllAdded(): Promise<void> {
    const rows = listAddedExtensions();
    // Settled, not all: one that throws must not keep browsers from hearing that the others loaded.
    const results = await Promise.allSettled(rows.map(row => this.serial(row.name, () => this.loadAdded(row))));
    results.forEach((result, index) => {
      if (result.status === "rejected") logger.error(`Loading extension ${rows[index]!.name} failed:`, result.reason);
    });
    if (rows.length > 0 && !this.disposed) this.changed();
  }

  /** A load that fails keeps it added, so the author can fix it and reload. */
  async add(path: string): Promise<ExtensionView> {
    if (!isAbsolute(path)) throw new ExtensionsError(`Not an absolute path: ${path}`, 400);
    const dir = resolve(path);
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new ExtensionsError(`Not a directory: ${dir}`, 400);
    let manifest: Manifest;
    try {
      manifest = await readManifest(dir);
    } catch (error) {
      if (error instanceof ManifestError) throw new ExtensionsError(error.message, 400);
      throw error;
    }
    const { name } = manifest;
    if (this.builtIns.has(name)) throw new ExtensionsError(`${name} is the name of a built-in extension`, 409);
    const added = listAddedExtensions();
    if (added.some(row => row.name === name)) throw new ExtensionsError(`An extension named ${name} is already added`, 409);
    const sameDir = added.find(row => row.source.path === dir);
    if (sameDir) throw new ExtensionsError(`${dir} is already added, as ${sameDir.name}`, 409);
    insertAddedExtension(name, dir);
    return this.serial(name, async () => {
      await this.loadAdded(this.addedRow(name), { install: true });
      this.changed();
      return this.view(name);
    });
  }

  async reload(name: string): Promise<ExtensionView> {
    return this.serial(name, async () => {
      if (!this.addedRow(name).enabled) throw new ExtensionsError(`${name} is turned off: turn it on first`, 409);
      bumpExtensionGeneration(name);
      await this.unload(name);
      await this.loadAdded(this.addedRow(name), { install: true });
      await this.settleProcesses(name);
      this.changed();
      return this.view(name);
    });
  }

  /** Its data directory, database and secrets stay (ADR-032), so adding it again finds them. */
  async remove(name: string): Promise<void> {
    await this.serial(name, async () => {
      this.addedRow(name);
      await this.unload(name);
      deleteExtensionRow(name);
      await this.settleProcesses(name);
      await removeBuilds(this.options.buildsDir, name);
      this.changed();
    });
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.serial(name, async () => {
      const row = getExtensionRow(name);
      if (!row) throw new ExtensionsError(`No extension named ${name}`, 404);
      if (row.enabled === enabled) return;
      setExtensionEnabled(name, enabled);
      await this.unload(name);
      const now = { ...row, enabled };
      if (isAdded(now)) await this.loadAdded(now);
      else this.startBuiltIn(now);
      await this.settleProcesses(name);
      this.changed();
    });
  }

  /** A browser still on an older build reports another script: that report is ignored. */
  reportFrontend(name: string, script: string, error: string | null): void {
    const record = this.records.get(name);
    if (!record || record.origin.build?.frontend?.script !== script) return;
    record.frontendFailure = error === null ? null : { message: error, at: new Date().toISOString() };
    if (error !== null) logger.warn(`Extension ${name}: its frontend part failed in a browser: ${error}`);
  }

  reportError(name: string, error: unknown): void {
    const errors = this.records.get(name)?.errors;
    if (errors) {
      errors.push({ message: errorMessage(error), at: new Date().toISOString() });
      errors.splice(0, errors.length - KEPT_ERRORS);
    }
    this.options.onError(name, error);
  }

  list(): ExtensionView[] {
    return [...this.records.values()].map(record => describe(record, this.host));
  }

  /** Only the current build's files: an old build ID must not serve files that have changed since. */
  async bundleFile(name: string, buildId: string, path: string): Promise<string | null> {
    const pkg = this.packages.get(name);
    return pkg && pkg.buildId === buildId ? pkg.file(path) : null;
  }

  /** Services stop first, all at once, so none calls an extension already disposed; then the last started
   * is disposed first, since it may use what earlier ones registered. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.options.app().processes.close();
    await this.loaded;
    await this.host.stopServices();
    const records = [...this.records.values()].toReversed();
    this.records.clear();
    this.packages.clear();
    for (const record of records) await this.disposeBackend(record);
  }

  /** The processes kept for an extension (`only`, else every one) that is not loaded now are stopped. */
  private async settleProcesses(only?: string): Promise<void> {
    if (this.disposed) return;
    const running = (name: string) => { const state = this.records.get(name)?.state; return state?.kind === "loaded" && state.backend !== null; };
    await stopProcessesOfStoppedExtensions(this.options.app().processes, running, only)
      .catch((error: unknown) => logger.error("Stopping the processes of extensions not loaded failed:", error));
  }

  private startBuiltIn(row: ExtensionRow): void {
    const registration = this.builtIns.get(row.name) ?? null;
    const origin: ExtensionOrigin = { source: BUILT_IN_SOURCE, manifest: null, build: null, backendPart: registration !== null };
    const record = this.newRecord(row.name, origin, row.enabled ? { kind: "loading" } : { kind: "disabled" });
    if (record && row.enabled) this.startBackendOf(record, registration);
  }

  /**
   * `install`: copy its files from its author's directory first (add, reload). Otherwise it loads the copy
   * installed before, so it runs without that directory; one never installed is installed now. A disabled one
   * still reads its manifest, so Settings can name it.
   */
  private async loadAdded(row: AddedExtensionRow, { install = false } = {}): Promise<void> {
    const { name, source, generation, buildId } = row;
    const { buildsDir } = this.options;
    const unread: ExtensionOrigin = { source, manifest: null, build: null, backendPart: true };
    if (!row.enabled) {
      const installed = buildId ? await openInstalled(buildsDir, name, buildId).catch(() => null) : null;
      const manifest = installed?.manifest ?? await readManifest(source.path).catch(() => null);
      this.newRecord(name, { ...unread, manifest: manifest && manifestView(manifest), backendPart: Boolean(manifest?.backend) }, { kind: "disabled" });
      return;
    }
    const record = this.newRecord(name, unread, { kind: "loading" });
    if (!record) return;
    let pkg: ExtensionPackage;
    let extension: ServerExtension | null;
    try {
      const installed = !install && buildId ? await openInstalled(buildsDir, name, buildId) : null;
      pkg = installed ?? await installPackage(await openPackage(source.path, name), buildsDir);
      if (pkg.buildId !== buildId && this.current(record)) {
        setExtensionBuild(name, pkg.buildId);
        await removeBuilds(buildsDir, name, pkg.buildId);
      }
      extension = await pkg.importBackend();
    } catch (error) {
      if (!this.current(record)) return;
      // The next apps must not run the build a failed reload was to replace: they install from its directory
      // again, so it stays failed until its files are fixed.
      if (install) setExtensionBuild(name, null);
      // Any other error is a load failure too: a record left `loading` would never change.
      const failure = error instanceof PackageFailure ? error : null;
      record.origin = { ...unread, manifest: failure?.manifest ? manifestView(failure.manifest) : null };
      this.fail(record, failure?.stage ?? "load", failure ? failure.cause : error, null);
      return;
    }
    if (!this.current(record)) return;
    const { manifest, frontendEntry } = pkg;
    record.origin = {
      source,
      manifest: manifestView(manifest),
      build: {
        id: pkg.buildId,
        frontend: frontendEntry ? {
          script: `${BUNDLES_PATH}/${name}/${pkg.buildId}/${frontendEntry}?g=${generation}`,
          styles: pkg.styles ? `${BUNDLES_PATH}/${name}/${pkg.buildId}/${pkg.styles}` : null,
        } : null,
      },
      backendPart: extension !== null,
    };
    this.packages.set(name, pkg);
    this.startBackendOf(record, extension);
  }

  private startBackendOf(record: ExtensionRecord, extension: ServerExtension | null): void {
    if (!extension) {
      record.state = { kind: "loaded", backend: null };
      return;
    }
    try {
      record.state = { kind: "loaded", backend: startBackend(record.name, extension, { host: this.host, openStorage: this.options.openStorage }) };
    } catch (error) {
      if (!(error instanceof BackendFailure)) throw error;
      this.fail(record, error.stage, error.cause, { storage: error.storage, migrations: error.migrations });
    }
  }

  private async unload(name: string): Promise<void> {
    const record = this.records.get(name);
    this.packages.delete(name);
    if (!record) return;
    this.records.delete(name);
    await this.disposeBackend(record);
  }

  private async disposeBackend({ name, state }: ExtensionRecord): Promise<void> {
    if (state.kind !== "loaded" || !state.backend) return;
    try {
      await state.backend.dispose();
    } catch (error) {
      this.options.onError(name, error);
    }
  }

  /** Null once disposed. A record already there is a bug: every operation unloads first. */
  private newRecord(name: string, origin: ExtensionOrigin, state: ExtensionState): ExtensionRecord | null {
    if (!EXTENSION_NAME.test(name)) throw new Error(`Not an extension name: ${name}`);
    if (this.disposed) return null;
    if (this.records.has(name)) throw new Error(`Extension already registered: ${name}`);
    const record: ExtensionRecord = { name, origin, state, errors: [], frontendFailure: null };
    this.records.set(name, record);
    return record;
  }

  /** False when it was unloaded, or the app disposed, while it loaded: a late load then records nothing. */
  private current(record: ExtensionRecord): boolean {
    return this.records.get(record.name) === record;
  }

  private fail(record: ExtensionRecord, stage: FailureStage, error: unknown, backend: Extract<ExtensionState, { kind: "failed" }>["backend"]): void {
    record.state = { kind: "failed", stage, message: errorMessage(error), backend };
    this.options.onError(record.name, error);
  }

  private view(name: string): ExtensionView {
    const record = this.records.get(name);
    if (!record) throw new ExtensionsError(`No extension named ${name}`, 404);
    return describe(record, this.host);
  }

  private addedRow(name: string): AddedExtensionRow {
    const row = getExtensionRow(name);
    if (!row) throw new ExtensionsError(`No extension named ${name}`, 404);
    if (!isAdded(row)) throw new ExtensionsError(`${name} is built in: turn it off instead`, 400);
    return row;
  }

  private changed(): void {
    this.options.broadcast({ type: "extensions_changed" });
  }

  private serial<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const tail = next.catch(() => {});
    this.chains.set(name, tail);
    void tail.then(() => { if (this.chains.get(name) === tail) this.chains.delete(name); });
    return next;
  }
}

function manifestView(manifest: Manifest): NonNullable<ExtensionOrigin["manifest"]> {
  return { label: manifest.label, description: manifest.description, version: manifest.version, icon: manifest.icon };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
