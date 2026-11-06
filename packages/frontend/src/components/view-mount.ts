/**
 * Where the app shows what an extension draws with a mount function (docs/dev/reins-sdk.md *Views*): a view's
 * presentation wherever a view is shown (an Inspector tab, a tab's icon, a decorated piece of a message), and,
 * without a view, an extension's Settings page or its icon. Features never see it as anything but their target.
 * A throw is the extension's failure, so it stays here and never reaches the page around it.
 */

import { ReactiveElement, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { MountedView, Subject, View } from "@reins/sdk";

/** Anything with a mount: a view's presentation (`ViewPresentation`), or a Settings page or icon, which take no view. */
export interface Mountable {
  mount(target: HTMLElement, view?: View, context?: object): MountedView<View, object> | void;
}

interface Mounted {
  presentation: Mountable;
  view: View | null;
  context: object | null;
  instance: MountedView<View, object> | void;
  fallback: Node[];
}

/**
 * Mounts its presentation while it is on the page, with its view and context when it has them; a new view or
 * context updates it (or mounts it again, for one without `update`); leaving the page disposes it. Its
 * children until then are the fallback (a piece's original text), put back after a dispose. Properties set
 * together are applied once, after they are all set. A throw from `mount` or `update` puts the fallback back,
 * or shows the error where there is none; one from `dispose` is logged.
 */
@customElement("reins-view-mount")
export class ViewMount extends ReactiveElement {
  @property({ attribute: false }) presentation: Mountable | null = null;
  @property({ attribute: false }) view: View | null = null;
  @property({ attribute: false }) context: object | null = null;

  private mounted: Mounted | null = null;

  override createRenderRoot() {
    return this;
  }

  /** What the mounted view says it is about (`MountedView.subject`); nothing when it says nothing, is not mounted or throws. */
  subject(): readonly Subject[] {
    try {
      return this.mounted?.instance?.subject?.() ?? [];
    } catch (error) {
      console.error("A view failed to give its subject", error);
      return [];
    }
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
    if (!this.isConnected || !presentation) {
      this.unmount();
      return;
    }
    const mounted = this.mounted;
    if (mounted?.presentation === presentation) {
      if (mounted.view === view && mounted.context === context) return;
      if (mounted.instance?.update && view && context) {
        mounted.view = view;
        mounted.context = context;
        try {
          mounted.instance.update(view, context);
        } catch (error) {
          this.fail(error);
        }
        return;
      }
    }
    this.unmount();
    const fallback = [...this.childNodes];
    this.replaceChildren();
    this.mounted = { presentation, view, context, fallback, instance: undefined };
    try {
      this.mounted.instance = view && context ? presentation.mount(this, view, context) : presentation.mount(this);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Stops what failed and shows the fallback, or the error where there is none. */
  private fail(error: unknown) {
    const mounted = this.mounted;
    if (!mounted) return;
    this.dispose(mounted);
    mounted.instance = undefined;
    if (mounted.fallback.length) {
      // The fallback hides the failure, so it is logged.
      console.error("A view failed to mount", error);
      this.replaceChildren(...mounted.fallback);
      return;
    }
    const message = this.ownerDocument.createElement("p");
    message.setAttribute("role", "alert");
    message.className = "text-xs text-red-400";
    message.textContent = `Failed to load: ${error instanceof Error ? error.message : String(error)}`;
    this.replaceChildren(message);
  }

  private unmount() {
    const mounted = this.mounted;
    if (!mounted) return;
    this.mounted = null;
    this.dispose(mounted);
    this.replaceChildren(...mounted.fallback);
  }

  private dispose(mounted: Mounted) {
    try {
      mounted.instance?.dispose?.();
    } catch (error) {
      console.error("A view failed to dispose", error);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "reins-view-mount": ViewMount;
  }
}
