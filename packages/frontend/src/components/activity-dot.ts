/**
 * Activity Dot
 *
 * A small status indicator dot for session activity state.
 * Green pulsing dot for "running", amber dot for "finished", nothing if undefined.
 */

import { LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ActivityState } from "../models/stores/session-cache.js";
import { statusDot } from "../ui/status-dot.js";

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

    return this.state === "running"
      ? statusDot("success", { label: "Running", pulse: true })
      : statusDot("warning", { label: "New activity" });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "activity-dot": ActivityDot;
  }
}
