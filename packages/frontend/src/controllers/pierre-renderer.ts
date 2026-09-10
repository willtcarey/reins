import type { ReactiveController, ReactiveControllerHost } from "lit";
import { ref } from "lit/directives/ref.js";

export interface PierreRendererInstance {
  cleanUp(): void;
}

export interface PierreRendererAdapter<Input extends object, Renderer extends PierreRendererInstance> {
  create(input: Input, rendered: () => void): Renderer;
  render(renderer: Renderer, input: Input, container: HTMLElement): void;
  sameInput?: (left: Input, right: Input) => boolean;
  onRendered?: (input: Input) => void;
}

/** Adapts a Pierre renderer to a ref-backed Lit render target. */
export class PierreRenderer<Input extends object, Renderer extends PierreRendererInstance>
  implements ReactiveController {
  private containerValue: HTMLElement | null = null;
  private requested: Input | null = null;
  private submitted: Input | null = null;
  private completed: Input | null = null;
  private generation = 0;

  public instance: Renderer | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly adapter: PierreRendererAdapter<Input, Renderer>,
  ) {
    host.addController(this);
  }

  get container(): HTMLElement | null {
    return this.containerValue;
  }

  get rendered(): boolean {
    return this.requested !== null
      && this.completed !== null
      && this.sameInput(this.completed, this.requested);
  }

  bind(input: Input) {
    this.requested = input;
    return ref(this.captureContainer);
  }

  hostUpdated() {
    this.sync();
  }

  hostDisconnected() {
    this.unmount();
  }

  unmount() {
    this.cleanUp();
    this.containerValue = null;
  }

  private readonly captureContainer = (element: Element | undefined) => {
    const container = element instanceof HTMLElement ? element : null;
    if (container === this.containerValue) return;
    this.cleanUp();
    this.containerValue = container;
    this.sync();
  };

  private cleanUp() {
    const instance = this.instance;
    const container = this.containerValue;
    this.generation += 1;
    this.instance = null;
    this.submitted = null;
    this.completed = null;
    try {
      instance?.cleanUp();
    } finally {
      // Pierre owns the contents of its shadow root. Its cleanup can leave the
      // previous render behind, so release those nodes without replacing the
      // Lit-owned host or its adopted style sheets.
      container?.shadowRoot?.replaceChildren();
    }
  }

  private sync() {
    const input = this.requested;
    const container = this.containerValue;
    if (!input || !container) {
      this.cleanUp();
      return;
    }
    if (this.instance && this.submitted && this.sameInput(this.submitted, input)) return;

    this.cleanUp();
    this.submitted = input;
    const generation = this.generation;
    this.instance = this.adapter.create(input, () => {
      if (
        generation !== this.generation
        || container !== this.containerValue
        || !this.requested
        || !this.sameInput(input, this.requested)
      ) return;
      this.completed = input;
      this.host.requestUpdate();
      this.adapter.onRendered?.(input);
    });
    this.adapter.render(this.instance, input, container);
  }

  private sameInput(left: Input, right: Input): boolean {
    return this.adapter.sameInput?.(left, right) ?? Object.is(left, right);
  }
}
