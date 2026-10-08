import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { SessionMoveTargetView } from "@backend/routes/sessions.js";
import type { CachedSession } from "../models/stores/session-cache.js";
import { Loadable } from "../helpers/loadable.js";
import { dialogButton } from "../ui/dialog.js";

type Result<T> = T | { error: string };

export interface SessionMoveActions {
  loadTargets: () => Promise<Result<SessionMoveTargetView[]>>;
  move: (nodeId: string) => Promise<Result<{ ok: true }>>;
}

const REASON_LABELS = { current: "current", no_source: "no project source" } as const;

/** "Laptop (offline) — no project source": the node, whether it is connected and, if it cannot take the session, why. */
function targetLabel(target: SessionMoveTargetView): string {
  const name = target.connected ? target.name : `${target.name} (offline)`;
  return target.eligible ? name : `${name} — ${REASON_LABELS[target.reason]}`;
}

/** Offers every node (those that cannot take the session disabled, with why) and moves it to the chosen one. */
@customElement("session-move-dialog")
export class SessionMoveDialog extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private isOpen = false;
  @state() private sessionLabel = "";
  @state() private targets = Loadable.idle<SessionMoveTargetView[]>();
  @state() private selectedNodeId = "";
  @state() private moving = false;
  @state() private moveError: string | null = null;

  private actions: SessionMoveActions | null = null;

  async open(session: Pick<CachedSession, "id" | "name" | "firstMessage">, actions: SessionMoveActions): Promise<void> {
    this.actions = actions;
    this.sessionLabel = session.name || session.firstMessage || "Empty session";
    this.selectedNodeId = "";
    this.moving = false;
    this.moveError = null;
    this.targets = Loadable.idle<SessionMoveTargetView[]>().asLoading();
    this.isOpen = true;
    const result = await actions.loadTargets();
    if (this.actions !== actions) return;
    if ("error" in result) {
      this.targets = this.targets.asError(result.error);
      return;
    }
    this.targets = this.targets.asLoaded(result);
    this.selectedNodeId = result.find((target) => target.eligible)?.nodeId ?? "";
  }

  close() {
    this.actions = null;
    this.isOpen = false;
  }

  private get selectedTarget(): SessionMoveTargetView | undefined {
    return this.targets.data?.find((target) => target.nodeId === this.selectedNodeId && target.eligible);
  }

  private async handleMove() {
    const actions = this.actions;
    const target = this.selectedTarget;
    if (!actions || !target || this.moving) return;
    this.moving = true;
    this.moveError = null;
    const result = await actions.move(target.nodeId);
    if (this.actions !== actions) return;
    this.moving = false;
    if ("error" in result) {
      this.moveError = result.error;
      return;
    }
    this.close();
  }

  private renderTargets() {
    const { data, loading, error } = this.targets;
    if (loading) return html`<p class="text-[10px] text-zinc-500">Loading nodes…</p>`;
    if (error) return html`<p class="text-[10px] text-red-400">${error}</p>`;
    if (!data) return nothing;
    return html`
      <label class="block text-[10px] text-zinc-400 mb-1">Node</label>
      <select
        class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 outline-none focus:border-blue-500 transition-colors cursor-pointer appearance-none disabled:opacity-50 disabled:cursor-not-allowed"
        ?disabled=${this.moving}
        @change=${(event: Event) => {
          if (event.target instanceof HTMLSelectElement) this.selectedNodeId = event.target.value;
        }}
      >
        ${data.map((target) => html`<option value=${target.nodeId} ?disabled=${!target.eligible} ?selected=${target.nodeId === this.selectedNodeId}>${targetLabel(target)}</option>`)}
      </select>
      ${data.some((target) => target.eligible) ? nothing : html`
        <p class="mt-1.5 text-[10px] text-zinc-500">No other node has a source for this project.</p>
      `}
    `;
  }

  override render() {
    return html`
      <app-dialog
        .open=${this.isOpen}
        heading="Move Session"
        width="md"
        .subtitle=${this.sessionLabel}
        .body=${html`
          ${this.renderTargets()}
          ${this.moveError ? html`<p class="mt-2 text-[10px] text-red-400">${this.moveError}</p>` : nothing}
        `}
        .actions=${html`
          ${dialogButton({ label: "Cancel", onClick: () => this.close() })}
          ${dialogButton({ label: this.moving ? "Moving…" : "Move", variant: "primary", onClick: () => this.handleMove(), disabled: this.moving || !this.selectedTarget })}
        `}
        @dialog-cancel=${() => this.close()}
      ></app-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-move-dialog": SessionMoveDialog;
  }
}
