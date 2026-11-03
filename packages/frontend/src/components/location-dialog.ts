import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Loadable } from "../helpers/loadable.js";
import { dialogButton } from "../ui/dialog.js";

type Result<T> = T | { error: string };

/** A node offered, whether it is connected, whether the session is on it now (for a move), and the paths
 * suggested on it. */
export interface LocationTarget { nodeId: string; name: string; connected: boolean; current?: boolean; paths: string[] }

export interface LocationDialogOptions {
  heading: string;
  /** What is placed: the session moved, or the new session's project. */
  subtitle: string;
  confirmLabel: string;
  /** Shown on the button while `choose` is pending. */
  busyLabel: string;
  loadTargets: () => Promise<Result<LocationTarget[]>>;
  /** Selected first when it is one of the targets' nodes; else another node where the project has worked. */
  initial?: { nodeId: string; path: string };
  choose: (nodeId: string, path: string) => Promise<Result<{ ok: true }>>;
}

const INPUT_CLASS = "w-full px-2.5 py-1.5 text-base md:text-xs bg-zinc-700 border border-zinc-600 rounded text-zinc-100 outline-none focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

/** "Laptop (offline) — current": the node, whether it is connected and whether the session is on it. */
function targetLabel(target: LocationTarget): string {
  const name = target.connected ? target.name : `${target.name} (offline)`;
  return target.current ? `${name} — current` : name;
}

/** The node offered first: another one where the project has worked, else any other, else the current one. */
function firstTarget(targets: readonly LocationTarget[]): LocationTarget | undefined {
  return targets.find((target) => !target.current && target.paths.length > 0) ?? targets.find((target) => !target.current) ?? targets[0];
}

/** Chooses a node and a path there, for a session to move to or a new session to work in: the paths its
 * project's sessions used on the chosen node are suggested, and any other can be typed (the node checks a
 * directory it has not been used in yet, when the choice is used). */
@customElement("location-dialog")
export class LocationDialog extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private isOpen = false;
  @state() private targets = Loadable.idle<LocationTarget[]>();
  @state() private selectedNodeId = "";
  @state() private path = "";
  @state() private choosing = false;
  @state() private chooseError: string | null = null;

  @state() private options: LocationDialogOptions | null = null;

  async open(options: LocationDialogOptions): Promise<void> {
    this.options = options;
    this.selectedNodeId = "";
    this.path = "";
    this.choosing = false;
    this.chooseError = null;
    this.targets = Loadable.idle<LocationTarget[]>().asLoading();
    this.isOpen = true;
    const result = await options.loadTargets();
    if (this.options !== options) return;
    if ("error" in result) {
      this.targets = this.targets.asError(result.error);
      return;
    }
    this.targets = this.targets.asLoaded(result);
    const initial = options.initial && result.find((target) => target.nodeId === options.initial!.nodeId);
    if (initial && options.initial) {
      this.selectedNodeId = initial.nodeId;
      this.path = options.initial.path;
    } else {
      this.select(firstTarget(result));
    }
  }

  close() {
    this.options = null;
    this.isOpen = false;
  }

  private select(target: LocationTarget | undefined) {
    this.selectedNodeId = target?.nodeId ?? "";
    this.path = target?.paths[0] ?? "";
  }

  private get selectedTarget(): LocationTarget | undefined {
    return this.targets.data?.find((target) => target.nodeId === this.selectedNodeId);
  }

  private async handleChoose() {
    const options = this.options;
    const target = this.selectedTarget;
    const path = this.path.trim();
    if (!options || !target || !path || this.choosing) return;
    this.choosing = true;
    this.chooseError = null;
    const result = await options.choose(target.nodeId, path);
    if (this.options !== options) return;
    this.choosing = false;
    if ("error" in result) {
      this.chooseError = result.error;
      return;
    }
    this.close();
  }

  private renderTargets() {
    const { data, loading, error } = this.targets;
    if (loading) return html`<p class="text-[10px] text-zinc-500">Loading nodes…</p>`;
    if (error) return html`<p class="text-[10px] text-red-400">${error}</p>`;
    if (!data) return nothing;
    const suggestions = this.selectedTarget?.paths ?? [];
    return html`
      <label class="block text-[10px] text-zinc-400 mb-1">Node</label>
      <select
        class="${INPUT_CLASS} cursor-pointer appearance-none"
        aria-label="Node"
        ?disabled=${this.choosing}
        @change=${(event: Event) => {
          if (!(event.target instanceof HTMLSelectElement)) return;
          const nodeId = event.target.value;
          this.select(data.find((target) => target.nodeId === nodeId));
        }}
      >
        ${data.map((target) => html`<option value=${target.nodeId} ?selected=${target.nodeId === this.selectedNodeId}>${targetLabel(target)}</option>`)}
      </select>
      <label class="block text-[10px] text-zinc-400 mt-2 mb-1">Path</label>
      <input
        type="text"
        aria-label="Path"
        placeholder="/path/to/checkout"
        list="location-dialog-paths"
        class="${INPUT_CLASS} font-mono"
        ?disabled=${this.choosing}
        .value=${this.path}
        @input=${(event: InputEvent) => { if (event.target instanceof HTMLInputElement) this.path = event.target.value; }}
      />
      <datalist id="location-dialog-paths">
        ${suggestions.map((path) => html`<option value=${path}></option>`)}
      </datalist>
      <p class="mt-1.5 text-[10px] text-zinc-500">${suggestions.length > 0 ? "Where this project has worked on that node, or another directory there." : "A directory on that node."}</p>
    `;
  }

  override render() {
    const options = this.options;
    return html`
      <app-dialog
        .open=${this.isOpen}
        heading=${options?.heading ?? ""}
        width="md"
        .subtitle=${options?.subtitle ?? ""}
        .onSubmit=${() => void this.handleChoose()}
        .body=${html`
          ${this.renderTargets()}
          ${this.chooseError ? html`<p class="mt-2 text-[10px] text-red-400">${this.chooseError}</p>` : nothing}
        `}
        .actions=${html`
          ${dialogButton({ label: "Cancel", onClick: () => this.close() })}
          ${dialogButton({ label: this.choosing ? options?.busyLabel ?? "" : options?.confirmLabel ?? "", variant: "primary", type: "submit", disabled: this.choosing || !this.selectedTarget || !this.path.trim() })}
        `}
        @dialog-cancel=${() => this.close()}
      ></app-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "location-dialog": LocationDialog;
  }
}
