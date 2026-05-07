/**
 * Activity Dot
 *
 * A small status indicator dot for session activity state.
 * Green pulsing dot for "running", amber dot for "finished", nothing if undefined.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ActivityState } from "../models/stores/activity-store.js";

@customElement("activity-dot")
export class ActivityDot extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String })
  state: ActivityState | undefined = undefined;

  /** When true, only render the dot for "running" state. */
  @property({ type: Boolean })
  runningOnly = false;

  override render() {
    if (!this.state) return nothing;
    if (this.runningOnly && this.state !== "running") return nothing;

    const classes =
      this.state === "running"
        ? "block w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0"
        : "block w-2 h-2 rounded-full bg-amber-500 shrink-0";
    const title = this.state === "running" ? "Running" : "New activity";

    return html`<span class="${classes}" title="${title}"></span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "activity-dot": ActivityDot;
  }
}
