import type { ServiceView } from "@backend/extensions/services.js";
import { html } from "lit";
import { statusDot, type StatusTone } from "../../ui/status-dot.js";

const TONES: Record<ServiceView["state"], StatusTone> = {
  starting: "warning",
  running: "success",
  restarting: "warning",
  stopped: "neutral",
  failed: "danger",
};

/** A backend service's dot and state, as Settings → Extensions shows it. */
export function serviceState(service: ServiceView) {
  return html`<span class="inline-flex items-center gap-1.5">${statusDot(TONES[service.state], { pulse: service.state === "starting" })}${service.state}</span>`;
}
