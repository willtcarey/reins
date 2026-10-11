import type { NodeView } from "@backend/models/node.js";
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { StoreController } from "../../controllers/store-controller.js";
import { copyTextToClipboard } from "../../helpers/clipboard.js";
import { isRemovable, nodeStatus, type NodesStore, type NodeStatus, type Pairing } from "../../models/stores/nodes-store.js";
import { checkIcon, copyIcon } from "../../ui/icons.js";
import { confirmDialog } from "../../ui/confirm-dialog.js";
import { dialogButton } from "../../ui/dialog.js";
import { showToast } from "../toast.js";

/** What a node's build says, when it is not the server's: it was told to update (and is restarting on the
 * server's build), or it was served on its own because the server has no build to offer. */
const BUILD_LABELS: Record<"outdated" | "updating", { label: string; title: string }> = {
  updating: { label: "updating…", title: "Installing the server's node code and restarting on it" },
  outdated: { label: "old build", title: "Runs other node code than this server's; the server has none to offer it (its build failed)" },
};

const STATUS_CLASSES: Record<NodeStatus, string> = {
  connected: "bg-green-500",
  offline: "bg-zinc-500",
  revoked: "bg-red-500",
};

/** "12 sources", "1 source" or "No sources": a node's projects' working copies on it. */
function sourceCount(node: NodeView): string {
  const count = node.sources.length;
  if (count === 0) return "No sources";
  return count === 1 ? "1 source" : `${count} sources`;
}

/** The one-line command that installs a node on the machine and pairs it with this server using the
 * pairing's code (`/nodes/install`, docs/features/nodes.md). Safe to run again. */
function pairCommand(pairing: Pairing): string {
  return `curl -fsSL ${location.origin}/nodes/install | sh -s -- ${pairing.code}`;
}

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
  /** The node the rename dialog is open for, and the name typed in it. */
  @state() private _renaming: NodeView | null = null;
  @state() private _renameDraft = "";

  /** Leaving the section ends pairing: a code is shown only once. */
  override disconnectedCallback() {
    this._adding = false;
    this._name = "";
    this._renaming = null;
    this.store?.dismissPairingCode();
    super.disconnectedCallback();
  }

  /** Creates a code named as the form says, or `name` (another code for an expired one). */
  private async _createPairingCode(name = this._name) {
    const store = this.store;
    if (!store || store.creatingPairingCode) return;

    const result = await store.createPairingCode(name);
    if ("error" in result) {
      showToast(`Failed to create pairing code: ${result.error}`, "error");
      return;
    }

    this._adding = false;
    this._name = "";
  }

  /** The code is gone once dismissed; the list is refreshed in case a node message was missed. */
  private async _dismissPairingCode() {
    const store = this.store;
    if (!store) return;

    store.dismissPairingCode();
    const result = await store.load();
    if ("error" in result) {
      showToast(`Failed to load nodes: ${result.error}`, "error");
    }
  }

  private async _remove(node: NodeView) {
    const store = this.store;
    if (!store) return;
    const confirmed = await confirmDialog({
      title: `Remove ${node.name}?`,
      message: "This is permanent: it can never connect again; pair the machine again to use it. Sessions that ran on it stay readable: move one to another node to continue it.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;

    const result = await store.remove(node.id);
    if ("error" in result) {
      showToast(`Failed to remove node: ${result.error}`, "error");
    }
  }

  private _openRename(node: NodeView) {
    this._renaming = node;
    this._renameDraft = node.name;
  }

  private _closeRename = () => {
    this._renaming = null;
  };

  /** Saves the typed name; the dialog stays open, saying why, if it is refused. */
  private _saveRename = async () => {
    const store = this.store;
    const node = this._renaming;
    if (!store || !node || store.renamingNodeId) return;
    if (this._renameDraft.trim() === node.name) {
      this._closeRename();
      return;
    }

    const result = await store.rename(node.id, this._renameDraft);
    if ("error" in result) {
      showToast(`Failed to rename node: ${result.error}`, "error");
      return;
    }
    this._closeRename();
  };

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
        ${node.hostname && node.hostname !== node.name
          ? html`<span class="text-[10px] text-zinc-500 font-mono truncate">${node.hostname}</span>`
          : nothing}
        <span class="ml-auto flex items-center gap-2 shrink-0">
          ${node.build && node.build.status !== "current"
            ? html`<span class="text-[10px] text-amber-400/90" title=${BUILD_LABELS[node.build.status].title}>${BUILD_LABELS[node.build.status].label}</span>`
            : nothing}
          <span class="text-[10px] ${status === "revoked" ? "text-red-400/80" : "text-zinc-500"}">${status}</span>
          <button
            class="text-[10px] text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
            @click=${() => this._openRename(node)}
            title="Change the name this node is shown with"
          >Rename</button>
          ${isRemovable(node)
            ? html`<button
                class="text-[10px] text-red-400 hover:text-red-300 cursor-pointer transition-colors"
                @click=${() => void this._remove(node)}
                title="Delete this node for good"
              >Remove</button>`
            : nothing}
        </span>
      </div>
      <p
        class="pl-4 pb-1.5 text-[11px] text-zinc-500"
        title="Projects' working copies on this node. Add one from a project's settings (Add source), or create a project on this node."
      >${sourceCount(node)}</p>
    `;
  }

  private _renderRenameDialog(store: NodesStore) {
    const node = this._renaming;
    const saving = node !== null && store.renamingNodeId === node.id;

    return html`
      <app-dialog
        .open=${node !== null}
        heading=${node ? `Rename ${node.name}` : ""}
        selectOnOpen
        .onSubmit=${() => void this._saveRename()}
        .body=${node ? html`
          <label for="node-name" class="block text-[10px] font-medium text-zinc-400 uppercase tracking-wide mb-1">Name</label>
          <input
            id="node-name"
            type="text"
            autofocus
            maxlength="100"
            class="w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
            .value=${this._renameDraft}
            @input=${(e: Event) => {
              if (e.target instanceof HTMLInputElement) this._renameDraft = e.target.value;
            }}
          />
        ` : nothing}
        .actions=${html`
          ${dialogButton({ label: "Cancel", onClick: this._closeRename })}
          ${dialogButton({ label: saving ? "Saving..." : "Save", variant: "primary", type: "submit", disabled: saving || this._renameDraft.trim() === "" })}
        `}
        @dialog-cancel=${this._closeRename}
      ></app-dialog>
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

  /** How pairing is going: waiting for the machine (with the command and code to give it), paired and
   * waiting for the node to connect (with the command again, should it not), connected, or expired. A
   * used or expired code pairs nothing, so it is no longer shown on its own. */
  private _renderPairingCode(pairing: Pairing) {
    switch (pairing.status) {
      case "waiting": return this._renderWaiting(pairing);
      case "paired": return html`
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-2">
            ${checkIcon("h-4 w-4 text-green-400 shrink-0")}
            <span class="text-xs text-zinc-200">Paired as <span class="font-medium">${pairing.node.name}</span></span>
          </div>
          <span class="text-xs text-zinc-300 mt-1">If it does not connect, run this on the machine again:</span>
          ${this._renderCopyable(pairCommand(pairing), "Command")}
          <div class="flex items-center justify-between gap-2 mt-1">
            ${this._renderPulse(html`Waiting for ${pairing.node.name} to connect…`)}
            ${this._renderDismiss("Done")}
          </div>
        </div>
      `;
      case "connected": return html`
        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-2" role="status">
            ${checkIcon("h-4 w-4 text-green-400 shrink-0")}
            <span class="text-xs text-zinc-200"><span class="font-medium">${pairing.node.name}</span> is connected</span>
          </div>
          ${this._renderDismiss("Done")}
        </div>
      `;
      case "expired": return html`
        <div class="flex flex-col gap-3">
          <p class="text-xs text-zinc-300" role="status">This code expired before a machine used it.</p>
          <div class="flex items-center justify-between gap-2">
            <button
              class="px-2.5 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors disabled:opacity-50"
              @click=${() => void this._createPairingCode(pairing.name)}
              ?disabled=${this.store?.creatingPairingCode}
            >Create another code</button>
            ${this._renderDismiss("Cancel")}
          </div>
        </div>
      `;
    }
  }

  private _renderWaiting(pairing: Pairing) {
    const expiresAt = new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

    return html`
      <div class="flex flex-col gap-2">
        <span class="text-xs text-zinc-300">Run this on the machine (Linux or macOS) to install a node and pair it. Then add its sources from a project's settings, or create a project on it.</span>
        ${this._renderCopyable(pairCommand(pairing), "Command")}
        <span class="text-xs text-zinc-300 mt-1">Pairing code:</span>
        ${this._renderCopyable(pairing.code, "Code")}
        <p class="text-[11px] text-zinc-500 leading-relaxed">
          The code works once and expires in 10 minutes, at ${expiresAt}, so it can stay in your shell history. It is not shown again once you leave this page.
        </p>
        <div class="flex items-center justify-between gap-2 mt-1">
          ${this._renderPulse("Waiting for the machine to pair…")}
          ${this._renderDismiss("Cancel")}
        </div>
      </div>
    `;
  }

  /** A status the page is waiting on, with a pulsing dot. */
  private _renderPulse(label: unknown) {
    return html`
      <span class="flex items-center gap-2 text-xs text-zinc-300" role="status">
        <span class="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
          <span class="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 motion-safe:animate-ping"></span>
          <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500 shadow-[0_0_8px_2px] shadow-blue-500/60"></span>
        </span>
        ${label}
      </span>
    `;
  }

  private _renderDismiss(label: string) {
    return html`
      <button
        class="self-end px-3 py-1.5 text-xs text-zinc-100 bg-zinc-600 hover:bg-zinc-500 rounded cursor-pointer transition-colors"
        @click=${() => void this._dismissPairingCode()}
      >${label}</button>
    `;
  }

  private _renderAddNodeForm(store: NodesStore) {
    return html`
      <div class="flex flex-col gap-3">
        <p class="text-[11px] text-zinc-500 leading-relaxed">
          Name the machine, then create a single-use pairing code to run on it.
        </p>
        <div class="flex items-center gap-2">
          <input
            type="text"
            placeholder="Name (optional: defaults to its hostname)"
            aria-label="Node name"
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
        </div>
        <button
          class="self-start text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors"
          @click=${() => { this._adding = false; }}
        >Cancel</button>
      </div>
    `;
  }

  /** Pairing replaces the node list until it is done or cancelled. */
  private _renderPairing(store: NodesStore, pairing: Pairing | null) {
    return html`
      <div class="space-y-3 p-4 bg-zinc-800/60 border border-zinc-700 rounded-lg">
        <h3 class="text-sm font-medium text-zinc-200">Add a node</h3>
        ${pairing ? this._renderPairingCode(pairing) : this._renderAddNodeForm(store)}
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

    const pairing = store.pairing;
    if (this._adding || pairing) return this._renderPairing(store, pairing);

    return html`
      <div class="space-y-3">
        ${this._renderNodes(store)}
        <button
          class="px-2.5 py-1.5 text-xs text-zinc-100 bg-blue-600 hover:bg-blue-500 rounded cursor-pointer transition-colors"
          @click=${() => { this._adding = true; }}
        >Add node</button>
      </div>
      ${this._renderRenameDialog(store)}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-nodes-section": SettingsNodesSection;
  }
}
