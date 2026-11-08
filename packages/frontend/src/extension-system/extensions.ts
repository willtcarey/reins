/**
 * Which frontend parts run in this browser: those the server's report has on (docs/dev/extensions-overview.md,
 * docs/dev/extension-loading.md *In the browser*). A part is replaced when its script URL changes, so a new
 * build or a reload is imported again.
 */

import type { ExtensionView } from "@backend/extension-system/report.js";
import type { Disposer, ExtensionInfo, ExtensionRegistration, ReinsSdk } from "@reins/sdk";
import type { ExtensionHost } from "./host.js";

export interface ExtensionsOptions {
  /** Where each one is activated, with its own SDK: what it registers is kept there. */
  host: Pick<ExtensionHost, "activate">;
  /** `scope`: an added extension's, so its views mount where its scoped stylesheet applies. */
  sdkFor(extension: ExtensionInfo, scope?: string): ReinsSdk;
  importModule(url: string): Promise<unknown>;
  builtIns: readonly ExtensionRegistration[];
  /** The names of SDKs the app makes for itself (`app`), which no added extension may take. */
  reserved: ReadonlySet<string>;
  /** Links the stylesheet at `url` into the page, once it has loaded, so its views never show unstyled. */
  addStyles(name: string, url: string): Promise<Disposer>;
  /** A frontend part fails in a browser, where nobody may look: the server keeps the failure for Settings. */
  report(name: string, script: string, error: string | null): void;
}

interface Active { script: string; dispose: Disposer }
interface Wanted { script: string; activate(): Promise<Disposer> }

const BUILT_IN = "built-in";

export class Extensions {
  private readonly active = new Map<string, Active>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: ExtensionsOptions) {}

  /** Reports apply in order: an older one must not undo a newer one. */
  sync(report: readonly ExtensionView[]): Promise<void> {
    // Caught: a rejected chain would skip every later report until the page reloads.
    this.chain = this.chain.then(() => this.apply(report)).catch((error: unknown) => console.error("Applying the server's extensions failed:", error));
    return this.chain;
  }

  dispose(): void {
    for (const { dispose } of this.active.values()) dispose();
    this.active.clear();
  }

  private async apply(report: readonly ExtensionView[]): Promise<void> {
    const wanted = new Map<string, Wanted>();
    const reported = new Map(report.map((view) => [view.name, view]));
    for (const registration of this.options.builtIns) {
      const view = reported.get(registration.name);
      // A report without it is of a server that does not record it: it is on.
      if (view && (view.status === "disabled" || view.source.kind !== "built-in")) continue;
      wanted.set(registration.name, {
        script: BUILT_IN,
        activate: async () => this.options.host.activate(registration, this.options.sdkFor(registration)),
      });
    }
    for (const view of report) {
      const frontend = view.source.kind === "path" && view.status === "loaded" ? view.build?.frontend : null;
      if (frontend) wanted.set(view.name, { script: frontend.script, activate: () => this.activateAdded(view, frontend) });
    }
    for (const [name, active] of this.active) {
      if (wanted.get(name)?.script === active.script) continue;
      active.dispose();
      this.active.delete(name);
    }
    for (const [name, { script, activate }] of wanted) {
      if (!this.active.has(name)) this.active.set(name, { script, dispose: await activate() });
    }
  }

  private async activateAdded(view: ExtensionView, { script, styles }: { script: string; styles: string | null }): Promise<Disposer> {
    const info = extensionInfo(view);
    const register = await this.registerFunction(view.name, script);
    const unlink = styles ? await this.options.addStyles(view.name, styles) : null;
    let failure: unknown = null;
    const registration: ExtensionRegistration = {
      ...info,
      register: (reins) => {
        try {
          return register(reins);
        } catch (error) {
          failure = error;
          throw error;
        }
      },
    };
    const dispose = this.options.host.activate(registration, this.options.sdkFor(info, view.name));
    this.options.report(view.name, script, failure === null ? null : describe(failure));
    return () => {
      dispose();
      unlink?.();
    };
  }

  /** One that throws why there is none, so the host records the failure as any other. */
  private async registerFunction(name: string, script: string): Promise<ExtensionRegistration["register"]> {
    if (this.options.reserved.has(name)) return () => { throw new Error(`The app keeps the name ${name}`); };
    let module: unknown;
    try {
      module = await this.options.importModule(script);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = new Error(`Its frontend module could not be loaded: ${message}`, { cause: error });
      if (error instanceof Error && error.stack) failure.stack = `${failure.message}\n${stackFrames(error)}`;
      return () => { throw failure; };
    }
    const register = typeof module === "object" && module !== null && "default" in module ? module.default : undefined;
    if (typeof register !== "function") return () => { throw new Error("Its frontend module's default export is not a register function"); };
    return (reins) => Reflect.apply(register, undefined, [reins]);
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const frames = stackFrames(error);
  return frames ? `${error.name}: ${error.message}\n${frames}` : `${error.name}: ${error.message}`;
}

/** V8 writes "    at …" lines, Firefox and Safari "fn@url" lines. */
function stackFrames(error: Error): string {
  const lines = (error.stack ?? "").split("\n").filter((line) => /^\s+at |@/.test(line));
  return lines.slice(0, 8).map((line) => (line.startsWith(" ") ? line : `    at ${line}`)).join("\n");
}

function extensionInfo(view: ExtensionView): ExtensionInfo {
  const manifest = view.manifest;
  const icon = manifest?.icon;
  return {
    name: view.name,
    label: manifest?.label ?? view.name,
    ...(manifest?.description ? { description: manifest.description } : {}),
    ...(icon ? { icon: { mount: (target: HTMLElement) => { target.innerHTML = icon; return {}; } } } : {}),
  };
}
