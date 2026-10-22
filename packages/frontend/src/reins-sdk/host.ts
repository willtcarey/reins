/**
 * The host side of the Reins SDK (docs/dev/reins-sdk.md): the page's one host, which `reins-sdk`
 * (index.ts) gives features once app-shell installs it. It keeps what they register and connects
 * them to the workspace on screen.
 */

import type { ProjectFiles } from "../models/stores/project-files.js";
import {
  sameSource,
  type ContainerId,
  type Disposer,
  type MessageDecorator,
  type OpenOptions,
  type ReinsSdk,
  type Source,
  type View,
  type ViewName,
  type ViewOf,
  type ViewRendererMap,
} from "./contract.js";
import { MessageDecorations } from "./decorations.js";

/** The workspace on screen, as the host reaches it. */
export interface MountedWorkspace {
  /** `projectId`: the project of the source the caller named, when it named a known one. */
  open(view: View, container: ContainerId, projectId: number | null): void;
}

const ELEMENT_NAME = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/;

let installed: ReinsHost | null = null;

/**
 * Makes a host the page's, the one `reins` reaches, until the returned disposer runs. There is one
 * per page: installing a second throws.
 */
export function installHost(host: ReinsHost): Disposer {
  if (installed) throw new Error("A Reins host is already installed");
  installed = host;
  return () => {
    if (installed === host) installed = null;
  };
}

/** The installed host's SDK; throws before app-shell installs one. */
export function installedSdk(): ReinsSdk {
  if (!installed) throw new Error("The Reins SDK was used before app-shell installed its host");
  return installed.sdk;
}

export class ReinsHost {
  readonly sdk: ReinsSdk;

  private workspace: MountedWorkspace | null = null;
  private renderers: Partial<ViewRendererMap> = {};
  private decorators: Array<{ decorator: MessageDecorator; unsubscribe: Disposer }> = [];
  // Bumped whenever messages must be decorated again: a decorator registered, gone or changed.
  private generation = 0;
  private current: { generation: number; decorations: MessageDecorations } | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly files: ProjectFiles) {
    this.sdk = Object.freeze({
      files,
      workspace: Object.freeze({ open: (view: View, options?: OpenOptions) => this.open(view, options) }),
      views: Object.freeze({
        register: <K extends ViewName>(name: K, renderer: ViewRendererMap[K]) => this.registerView(name, renderer),
      }),
      messages: Object.freeze({ registerDecorator: (decorator: MessageDecorator) => this.registerDecorator(decorator) }),
    });
  }

  /** Makes a workspace the one `workspace.open` reaches, until the returned disposer runs. */
  mountWorkspace(workspace: MountedWorkspace): Disposer {
    this.workspace = workspace;
    return () => {
      if (this.workspace === workspace) this.workspace = null;
    };
  }

  /** The registered renderer of a view, or null (the Inspector renders `changes` itself). */
  renderer<K extends ViewName>(view: ViewOf<K>): ViewRendererMap[K] | null {
    return this.renderers[view.view] ?? null;
  }

  /**
   * The registered decorators for messages of a source, or null with none to apply. The same object
   * until a decorator changes or the source does, so rendered messages can keep what they parsed.
   */
  decorations(source: Source | null): MessageDecorations | null {
    if (!source || this.decorators.length === 0) return null;
    const current = this.current;
    if (current?.generation === this.generation && sameSource(current.decorations.context.source, source)) return current.decorations;
    const decorations = new MessageDecorations(
      this.decorators.map(({ decorator }) => decorator),
      { source },
      (view) => this.open(view, { in: "inspector", source }),
    );
    this.current = { generation: this.generation, decorations };
    return decorations;
  }

  /** Listens for registrations and decorators changing, after which views and messages render again. */
  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const { unsubscribe } of this.decorators) unsubscribe();
    this.decorators = [];
    this.renderers = {};
    this.listeners.clear();
    this.workspace = null;
  }

  private open(view: View, { in: container = "inspector", source }: OpenOptions = {}): void {
    this.workspace?.open(view, container, source ? this.files.projectOf(source) : null);
  }

  private registerView<K extends ViewName>(name: K, renderer: ViewRendererMap[K]): Disposer {
    if (name === "changes") throw new Error("The changes view is the Inspector's own");
    if (this.renderers[name]) throw new Error(`The ${name} view already has a renderer`);
    if (!ELEMENT_NAME.test(renderer.element)) throw new Error(`Not a custom element name: ${renderer.element}`);
    this.renderers[name] = renderer;
    this.changed();
    return () => {
      if (this.renderers[name] !== renderer) return;
      delete this.renderers[name];
      this.changed();
    };
  }

  private registerDecorator(decorator: MessageDecorator): Disposer {
    const registration = { decorator, unsubscribe: decorator.onChange(() => this.changed()) };
    this.decorators = [...this.decorators, registration];
    this.changed();
    return () => {
      if (!this.decorators.includes(registration)) return;
      registration.unsubscribe();
      this.decorators = this.decorators.filter((entry) => entry !== registration);
      this.changed();
    };
  }

  private changed(): void {
    this.generation += 1;
    for (const listener of this.listeners) listener();
  }
}
