/**
 * Toast Notification Component
 *
 * Minimal toast system for brief user feedback. Auto-dismisses success
 * messages after 3 seconds; errors stay longer (8s) or can be clicked
 * to dismiss. Positioned at bottom-center of the viewport.
 *
 * The container is a manual popover, re-shown with each toast: an open
 * modal dialog sits in the browser's top layer above any z-index, and the
 * top layer stacks in the order things were shown, so a toast about a
 * dialog (a failed save) shows above it.
 *
 * Usage:
 *   import { showToast } from "./toast.js";
 *   showToast("File uploaded!", "success");
 *   showToast("Upload failed", "error");
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

export type ToastLevel = "success" | "error" | "info";

interface ToastEntry {
  id: number;
  message: string;
  level: ToastLevel;
  /** Whether the exit animation is running. */
  exiting: boolean;
}

let nextId = 0;

/** The singleton container instance (created on first showToast call). */
let container: ToastContainer | null = null;

/** Show a toast notification. */
export function showToast(message: string, level: ToastLevel = "info"): void {
  if (!container) {
    container = document.createElement("toast-container");
    document.body.appendChild(container);
  }
  container.add(message, level);
}

const AUTO_DISMISS_MS: Record<ToastLevel, number> = {
  success: 3000,
  info: 4000,
  error: 8000,
};

@customElement("toast-container")
export class ToastContainer extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private toasts: ToastEntry[] = [];

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("popover", "manual");
    // Undo the browser's popover box: the toasts position themselves.
    this.classList.add("m-0", "p-0", "border-0", "bg-transparent", "overflow-visible");
  }

  /** Puts the toasts on top of the top layer, above any modal dialog shown before. */
  private raise() {
    if (typeof this.showPopover !== "function") return;
    if (this.matches(":popover-open")) this.hidePopover();
    this.showPopover();
  }

  add(message: string, level: ToastLevel) {
    this.raise();
    const id = nextId++;
    this.toasts = [...this.toasts, { id, message, level, exiting: false }];

    setTimeout(() => this.dismiss(id), AUTO_DISMISS_MS[level]);
  }

  private dismiss(id: number) {
    // Start exit animation
    this.toasts = this.toasts.map((t) =>
      t.id === id ? { ...t, exiting: true } : t,
    );
    // Remove after animation
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    }, 200);
  }

  override render() {
    if (this.toasts.length === 0) return nothing;

    return html`
      <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-[var(--layer-toast)] flex flex-col items-center gap-2 pointer-events-none">
        ${this.toasts.map((t) => {
          const bg =
            t.level === "success"
              ? "bg-green-900/90 border-green-700 text-green-200"
              : t.level === "error"
                ? "bg-red-900/90 border-red-700 text-red-200"
                : "bg-zinc-800/90 border-zinc-600 text-zinc-200";
          const anim = t.exiting
            ? "opacity-0 translate-y-2"
            : "opacity-100 translate-y-0";
          return html`
            <div
              class="pointer-events-auto px-4 py-2 rounded-lg border text-sm shadow-lg backdrop-blur-sm cursor-pointer transition-all duration-200 ${bg} ${anim}"
              @click=${() => this.dismiss(t.id)}
            >
              ${t.message}
            </div>
          `;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "toast-container": ToastContainer;
  }
}
