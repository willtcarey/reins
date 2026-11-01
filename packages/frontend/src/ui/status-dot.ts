/**
 * A small colored dot that shows a status: connected, running, failed. Callers map their own states to a
 * tone, so the same status looks the same everywhere.
 */

import { html } from "lit";

export type StatusTone = "success" | "warning" | "danger" | "neutral";

const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-green-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  neutral: "bg-zinc-500",
};

/**
 * `label` names the status (its tooltip, and its name for assistive technology); leave it out when text beside
 * the dot already says it. `pulse` shows work in progress.
 */
export function statusDot(tone: StatusTone, { label, pulse = false }: { label?: string; pulse?: boolean } = {}) {
  const classes = `block size-2 shrink-0 rounded-full ${TONE_CLASSES[tone]}${pulse ? " animate-pulse" : ""}`;
  return label
    ? html`<span class="${classes}" role="img" aria-label="${label}" title="${label}"></span>`
    : html`<span class="${classes}" aria-hidden="true"></span>`;
}
