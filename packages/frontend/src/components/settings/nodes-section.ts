import type { NodeView } from "@backend/routes/nodes.js";
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { copyTextToClipboard } from "../../helpers/clipboard.js";
import { isRevocable, nodeStatus, type NodesStore, type NodeStatus, type PairingCode } from "../../models/stores/nodes-store.js";
import { copyIcon } from "../../ui/icons.js";
import { showToast } from "../toast.js";

const STATUS_CLASSES: Record<NodeStatus, string> = {
  connected: "bg-green-500",
  offline: "bg-zinc-500",
  revoked: "bg-red-500",
};

@customElement("settings-nodes-section")
export class SettingsNodesSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private _storeCtrl = new StoreController<NodesStore>(this);

  @property({ attribute: false })
  set store(store: NodesStore | null) {
    this._storeCtrl.store = store;
  }

  get store(): NodesStore | null {
    return this._storeCtrl.store;
  }

  @state() private _adding = false;
  @state() private _name = "";

  private async _createPairingCode() {
    const store = this.store;
    if (!store || store.creatingPairingCode) return;

    const result = await store.createPairingCode(this._name);
    if ("error" in result) {
      showToast(`Failed to create pairing code: ${result.error}`, "error");
      return;
    }

    this._adding = false;
    this._name = "";
  }

  /** The code is gone once dismissed; the list is refreshed to show a node paired meanwhile. */
  private async _dismissPairingCode() {
    const store = this.store;
    if (!store) return;

    store.dismissPairingCode();
    const result = await store.load();
    if ("error" in result) {
      showToast(`Failed to load nodes: ${result.error}`, "error");
    }
  }

  private async _revoke(node: NodeView) {
    const store = this.store;
    if (!store) return;
    if (!confirm(`Revoke "${node.name}"?\n\nIt is disconnected and can never connect again. To use the machine again, pair it as a new node.`)) return;

    const result = await store.revoke(node.id);
    if ("error" in result) {
      showToast(`Failed to revoke node: ${result.error}`, "error");
    }
  }

  private async _copy(text: string, label: string) {
    try {
      await copyTextToClipboard(text);
      showToast(`${label} copied`, "success");
    } catch {
      showToast(`Could not copy the ${label.toLowerCase()}`, "error");
    }
  }

  private _handleNameKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void this._createPairingCode();
    }
  }

  private _renderNode(node: NodeView) {
    const status = nodeStatus(node);

    return html`
      <div class="flex items-center gap-2 py-1.5">
        <span class="w-2 h-2 rounded-full shrink-0 ${STATUS_CLASSES[status]}"></span>
        <span class="text-xs font-medium text-zinc-200 truncate">${node.name}</span>
        ${node.paired
          ? nothing
          : html`<span class="text-[10px] text-zinc-500 bg-zinc-700/50 px-1.5 py-0.5 rounded">local</span>`}
        ${node.hostname
          ? html`<span class="text-[10px] text-zinc-500 font-mono truncate">${node.hostname}</span>`
          : nothing}
        <span class="ml-auto flex items-center gap-2 shrink-0">
          <span class="text-[10px] ${status === "revoked" ? "text-red-400/80" : "text-zinc-500"}">${status}</span>
          ${isRevocable(node)
            ? html`<button
                class="text-[10px] text-red-400 hover:text-red-300 cursor-pointer transition-colors"
                @click=${() => void this._revoke(node)}
                title="Refuse this node from now on"
              >Revoke</button>`
            : nothing}
        </span>
      </div>
    `;
  }

  private _renderCopyable(text: string, label: string) {
    return html`
      <div class="flex items-start gap-2 px-2 py-1.5 bg-zinc-900/60 border border-zinc-700 rounded">
        <code class="flex-1 text-[11px] text-zinc-100 font-mono break-all select-all">${text}</code>
        <button
          class="p-0.5 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors shrink-0"
          @click=${() => void this._copy(text, label)}
          aria-label="Copy ${label.toLowerCase()}"
          title="Copy ${label.toLowerCase()}"
        >${copyIcon("w-3.5 h-3.5")}</button>
      </div>
    `;
  }

  private _renderPairingCode(pairingCode: PairingCode) {
    const command = `bun run reins node pair ${location.origin} ${pairingCode.code}`;
    const expiresAt = new Date(pairingCode.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    return html`
      <div class="flex flex-col gap-2 p-2.5 bg-zinc-700/50 border border-zinc-600 rounded">
        <span class="text-[10px] text-zinc-400">Run this on the machine to pair, in a Reins checkout (until there is an install script):</span>
        ${this._renderCopyable(command, "Command")}
        <span class="text-[10px] text-zinc-400">Pairing code:</span>
        ${this._renderCopyable(pairingCode.code, "Code")}
        <p class="text-[10px] text-zinc-500 leading-relaxed">
          The code works once and expires in 10 minutes, at ${expiresAt}. It is not shown again once you close this.
        </p>
        <button
          class="self-end px-2.5 py-1 text-xs text-zinc-100 bg-zinc-600 hover:bg-zinc-500 rounded cursor-pointer transition-colors"
          @click=${() => void this._dismissPairingCode()}
        >Done</button>
      </div>
    `;
  }

  private _renderAddNodeForm(store: NodesStore) {
    return html`
      <div class="flex items-center gap-2 pt-1">
        <input
          type="text"
          placeholder="Name (optional: defaults to its hostname)"
          class="flex-1 px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100
                 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
          .value=${this._name}
          @input=${(e: InputEvent) => {
            if (e.target instanceof HTMLInputElement) {
              this._name = e.target.value;
            }
          }}
          @keydown=${this._handleNameKeyDown}
          ?disabled=${store.creatingPairingCode}
        />
        <button
          class="px-2.5 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer
                 transition-colors disabled:opacity-50 shrink-0"
          @click=${() => void this._createPairingCode()}
          ?disabled=${store.creatingPairingCode}
        >${store.creatingPairingCode ? "Creating..." : "Create code"}</button>
        <button
          class="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors shrink-0"
          @click=${() => { this._adding = false; }}
        >Cancel</button>
      </div>
    `;
  }

  private _renderNodes(store: NodesStore) {
    const nodes = store.nodes.data;
    if (!nodes) {
      return store.nodes.loading
        ? html`<div class="text-xs text-zinc-500 py-2">Loading nodes...</div>`
        : nothing;
    }

    return html`
      <div class="divide-y divide-zinc-700/50">
        ${nodes.map((node) => this._renderNode(node))}
      </div>
    `;
  }

  override render() {
    const store = this.store;
    if (!store) return nothing;

    const pairingCode = store.pairingCode;

    return html`
      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-xs font-medium text-zinc-400 uppercase tracking-wider">Nodes</h3>
          ${this._adding || pairingCode
            ? nothing
            : html`<button
                class="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer transition-colors"
                @click=${() => { this._adding = true; }}
              >Add node</button>`}
        </div>
        ${this._renderNodes(store)}
        ${pairingCode
          ? this._renderPairingCode(pairingCode)
          : this._adding ? this._renderAddNodeForm(store) : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-nodes-section": SettingsNodesSection;
  }
}
