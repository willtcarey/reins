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

/** Lists the nodes a session can move to and moves it to the chosen one. */
@customElement("session-move-dialog")
export class SessionMoveDialog extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private sessionLabel = "";
  @state() private targets = Loadable.idle<SessionMoveTargetView[]>();
  @state() private movingNodeId: string | null = null;
  @state() private moveError: string | null = null;

  private actions: SessionMoveActions | null = null;

  @query("dialog") private dialog?: HTMLDialogElement;

  async open(session: Pick<CachedSession, "id" | "name" | "firstMessage">, actions: SessionMoveActions): Promise<void> {
    this.actions = actions;
    this.sessionLabel = session.name || session.firstMessage || "Empty session";
    this.movingNodeId = null;
    this.moveError = null;
    this.targets = Loadable.idle<SessionMoveTargetView[]>().asLoading();
    void this.updateComplete.then(() => this.dialog?.showModal());
    const result = await actions.loadTargets();
    if (this.actions !== actions) return;
    this.targets = "error" in result ? this.targets.asError(result.error) : this.targets.asLoaded(result);
  }

  close() {
    this.actions = null;
    this.dialog?.close();
  }

  private async moveTo(target: SessionMoveTargetView) {
    const actions = this.actions;
    if (!actions || target.current || this.movingNodeId) return;
    this.movingNodeId = target.nodeId;
    this.moveError = null;
    const result = await actions.move(target.nodeId);
    if (this.actions !== actions) return;
    this.movingNodeId = null;
    if ("error" in result) {
      this.moveError = result.error;
      return;
    }
    this.close();
  }

  private handleBackdropClick(event: MouseEvent) {
    if (event.target === this.dialog) this.close();
  }

  private renderTarget(target: SessionMoveTargetView) {
    const moving = this.movingNodeId === target.nodeId;
    return html`
      <button
        type="button"
        data-node-id=${target.nodeId}
        class="w-full flex items-center gap-2 px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-700 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:hover:bg-transparent ${target.current ? "" : "disabled:opacity-50"}"
        ?disabled=${target.current || this.movingNodeId !== null}
        @click=${() => this.moveTo(target)}
      >
        <span
          class="w-2 h-2 rounded-full shrink-0 ${target.connected ? "bg-green-500" : "bg-zinc-600"}"
          title=${target.connected ? "Connected" : "Not connected"}
        ></span>
        <span class="min-w-0 flex-1 truncate">${target.name}</span>
        ${target.current ? html`<span class="shrink-0 text-[10px] text-zinc-500">Current</span>`
          : moving ? html`<span class="shrink-0 text-[10px] text-zinc-500">Moving…</span>` : nothing}
      </button>
    `;
  }

  private renderTargets() {
    const { data, loading, error } = this.targets;
    if (loading) return html`<p class="px-2.5 py-2 text-[10px] text-zinc-500">Loading nodes…</p>`;
    if (error) return html`<p class="px-2.5 py-2 text-[10px] text-red-400">${error}</p>`;
    if (!data || data.length === 0) {
      return html`<p class="px-2.5 py-2 text-[10px] text-zinc-500">No node has a source for this project.</p>`;
    }
    return html`
      <div class="divide-y divide-zinc-700/60 rounded border border-zinc-700 overflow-hidden">
        ${data.map((target) => this.renderTarget(target))}
      </div>
      ${data.every((target) => target.current) ? html`
        <p class="mt-1.5 text-[10px] text-zinc-500">No other node has a source for this project.</p>
      ` : nothing}
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
