import { LitElement, html, nothing } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import type { SessionMoveTargetView } from "@backend/routes/sessions.js";
import type { CachedSession } from "../models/stores/session-cache.js";
import { Loadable } from "../helpers/loadable.js";

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

  @state() private sessionLabel = "";
  @state() private targets = Loadable.idle<SessionMoveTargetView[]>();
  @state() private selectedNodeId = "";
  @state() private moving = false;
  @state() private moveError: string | null = null;

  private actions: SessionMoveActions | null = null;

  @query("dialog") private dialog?: HTMLDialogElement;

  async open(session: Pick<CachedSession, "id" | "name" | "firstMessage">, actions: SessionMoveActions): Promise<void> {
    this.actions = actions;
    this.sessionLabel = session.name || session.firstMessage || "Empty session";
    this.selectedNodeId = "";
    this.moving = false;
    this.moveError = null;
    this.targets = Loadable.idle<SessionMoveTargetView[]>().asLoading();
    void this.updateComplete.then(() => this.dialog?.showModal());
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
    this.dialog?.close();
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

  private handleBackdropClick(event: MouseEvent) {
    if (event.target === this.dialog) this.close();
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
      <dialog
        class="bg-transparent p-0 m-auto max-h-dvh overflow-hidden backdrop:bg-black/50 backdrop:backdrop-blur-sm"
        @click=${this.handleBackdropClick}
        @close=${() => { this.actions = null; }}
      >
        <div class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl w-[calc(100vw-2rem)] max-w-[28rem] p-4">
          <h3 class="text-sm font-medium text-zinc-200">Move Session</h3>
          <p class="mt-0.5 mb-3 truncate text-[10px] text-zinc-500">${this.sessionLabel}</p>

          ${this.renderTargets()}
          ${this.moveError ? html`<p class="mt-2 text-[10px] text-red-400">${this.moveError}</p>` : nothing}

          <div class="flex items-center gap-2 mt-4 justify-end">
            <button
              type="button"
              class="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
              @click=${() => this.close()}
            >Cancel</button>
            <button
              type="button"
              class="px-3 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              @click=${() => this.handleMove()}
              ?disabled=${this.moving || !this.selectedTarget}>${this.moving ? "Moving…" : "Move"}</button>
          </div>
        </div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "session-move-dialog": SessionMoveDialog;
  }
}
