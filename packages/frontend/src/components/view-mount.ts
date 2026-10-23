/**
 * Where the app shows a view (docs/dev/reins-sdk.md *Views*): the element a presentation's `mount`
 * draws into, wherever a view is shown (an Inspector tab, a decorated piece of a message). Features
 * never see it as anything but their target.
 */

import { ReactiveElement, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { MountedView, View, ViewPresentation } from "../reins-sdk/contract.js";

interface Mounted {
  presentation: ViewPresentation<View, object>;
  view: View;
  context: object;
  instance: MountedView<View, object> | void;
  fallback: Node[];
}

/**
 * Mounts its view while it is on the page and has a presentation, a view and a context; a new view
 * or context updates it (or mounts it again, for a view without `update`); leaving the page disposes
 * it. Its children until then are the fallback (a piece's original text), put back after a dispose.
 * Properties set together are applied once, after they are all set.
 */
@customElement("reins-view-mount")
export class ViewMount extends ReactiveElement {
  @property({ attribute: false }) presentation: ViewPresentation<View, object> | null = null;
  @property({ attribute: false }) view: View | null = null;
  @property({ attribute: false }) context: object | null = null;

  private mounted: Mounted | null = null;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) this.requestUpdate();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unmount();
  }

  protected override update(changed: PropertyValues) {
    super.update(changed);
    const { presentation, view, context } = this;
    if (!this.isConnected || !presentation || !view || !context) {
      this.unmount();
      return;
    }
    const mounted = this.mounted;
    if (mounted?.presentation === presentation) {
      if (mounted.view === view && mounted.context === context) return;
      if (mounted.instance?.update) {
        mounted.instance.update(view, context);
        mounted.view = view;
        mounted.context = context;
        return;
      }
    }
    this.unmount();
    const fallback = [...this.childNodes];
    this.replaceChildren();
    this.mounted = { presentation, view, context, fallback, instance: undefined };
    this.mounted.instance = presentation.mount(this, view, context);
  }

  private unmount() {
    const mounted = this.mounted;
    if (!mounted) return;
    this.mounted = null;
    mounted.instance?.dispose?.();
    this.replaceChildren(...mounted.fallback);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "reins-view-mount": ViewMount;
  }
}
