import type { SessionContextSnapshot } from "@backend/models/session-context.js";
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { computePosition } from "../ui/position.js";

let nextTooltipId = 0;

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const thousands = tokens / 1_000;
  return `${thousands >= 10 || Number.isInteger(thousands) ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

@customElement("session-context-usage")
export class SessionContextUsage extends LitElement {
  override createRenderRoot() { return this; }

  @property({ attribute: false }) snapshot: SessionContextSnapshot | null = null;

  @state() private tooltipVisible = false;
  private tooltipPinned = false;
  private tooltipElement: HTMLDivElement | null = null;
  private readonly tooltipId = `session-context-usage-tooltip-${++nextTooltipId}`;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.addEventListener("scroll", this.handleScroll, true);
    this.createTooltip();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    document.removeEventListener("scroll", this.handleScroll, true);
    this.tooltipElement?.remove();
    this.tooltipElement = null;
  }

  private handleDocumentPointerDown = (event: PointerEvent) => {
    if (!this.tooltipPinned) return;
    if (event.target instanceof Node && this.contains(event.target)) return;
    this.closeTooltip();
  };

  private handleScroll = () => {
    if (this.tooltipVisible) this.closeTooltip();
  };

  private toggleTooltip(event: Event) {
    event.stopPropagation();
    if (this.tooltipPinned) {
      this.closeTooltip();
      return;
    }

    this.tooltipPinned = true;
    this.tooltipVisible = true;
  }

  private closeTooltip() {
    this.tooltipPinned = false;
    this.tooltipVisible = false;
  }

  override updated() {
    if (!this.tooltipElement) return;

    const detail = this.contextDetail();
    this.tooltipElement.textContent = detail;
    this.tooltipElement.classList.toggle("hidden", !this.tooltipVisible || !detail);
    if (this.tooltipVisible && detail) this.positionTooltip();
  }

  private createTooltip() {
    const tooltip = document.createElement("div");
    tooltip.id = this.tooltipId;
    tooltip.role = "tooltip";
    tooltip.className = "context-usage-tooltip fixed hidden z-[var(--layer-overlay)] max-w-[calc(100vw-1rem)] rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs font-mono text-zinc-100 shadow-xl whitespace-nowrap pointer-events-none";
    document.body.append(tooltip);
    this.tooltipElement = tooltip;
  }

  private contextDetail(): string {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.usedTokens === null || snapshot.utilization === null) {
      return snapshot ? "Context unknown" : "";
    }

    const percent = Math.max(0, Math.round(snapshot.utilization * 100));
    return `${snapshot.measurement === "estimated" ? "~" : ""}${formatTokens(snapshot.usedTokens)} / ${formatTokens(snapshot.contextWindow)} · ${percent}%`;
  }

  private positionTooltip() {
    const button = this.querySelector("button");
    const tooltip = this.tooltipElement;
    if (!button || !tooltip) return;

    const position = computePosition({
      anchor: button.getBoundingClientRect(),
      width: tooltip.offsetWidth,
      height: tooltip.offsetHeight,
      placement: "top-end",
      gap: 6,
      viewportPad: 8,
    });
    tooltip.style.top = `${position.top}px`;
    tooltip.style.left = `${position.left}px`;
  }

  override render() {
    const snapshot = this.snapshot;
    if (!snapshot) return nothing;

    const known = snapshot.usedTokens !== null && snapshot.utilization !== null;
    const percent = known ? Math.max(0, Math.round(snapshot.utilization! * 100)) : null;
    const progressPercent = percent === null ? 0 : Math.min(100, percent);
    const atThreshold = known && snapshot.usedTokens! >= snapshot.compactionThresholdTokens;
    const nearThreshold = known && !atThreshold
      && snapshot.usedTokens! >= snapshot.compactionThresholdTokens * 0.9;
    const stateText = atThreshold
      ? "Context compaction threshold reached"
      : nearThreshold
        ? "Context nearing compaction threshold"
        : "Session context usage";
    const detail = this.contextDetail();
    const fillClass = atThreshold ? "bg-red-400" : nearThreshold ? "bg-amber-400" : "bg-blue-400";
    const accessibleDetail = `${stateText}: ${detail}`;

    return html`
      <button
        type="button"
        class="flex min-h-6 min-w-0 items-center gap-1.5 rounded px-1 text-[10px] text-zinc-500 transition-colors cursor-pointer"
        aria-label=${accessibleDetail}
        aria-expanded=${this.tooltipVisible}
        aria-describedby=${this.tooltipVisible ? this.tooltipId : nothing}
        @click=${this.toggleTooltip}
      >
        ${known ? html`
          <span
            class="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-zinc-800 ring-1 ring-inset ring-zinc-700/70"
            role="progressbar"
            aria-label="Session context usage"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow=${progressPercent}
            aria-valuetext=${accessibleDetail}
          >
            <span class="block h-full rounded-full ${fillClass} transition-[width]" style=${`width: ${progressPercent}%`}></span>
          </span>
        ` : html`
          <span
            class="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-zinc-800 ring-1 ring-inset ring-zinc-700/70"
            role="progressbar"
            aria-label="Session context usage"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuetext=${accessibleDetail}
          >
            <span class="block h-full rounded-full bg-zinc-600"></span>
          </span>
        `}
        <span class="hidden whitespace-nowrap sm:inline">${detail}</span>
        ${(nearThreshold || atThreshold) ? html`
          <span class="sr-only">${stateText}</span>
          <span aria-hidden="true" class=${atThreshold ? "text-red-300" : "text-amber-300"}>!</span>
        ` : nothing}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-context-usage": SessionContextUsage;
  }
}
