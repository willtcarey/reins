/**
 * A model to choose, as a `choice-selector` that opens the providers' models and the thinking level.
 * It shows `model` and gives each change to `choose`. While a promise `choose` returns is pending, it
 * shows the change and its controls are busy; if the promise rejects, it shows the error and `model` again.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ModelSetting } from "@backend/settings-store.js";
import { formatModelSettingLabel } from "../models/settings.js";
import { ModelRegistryStore } from "../models/stores/model-registry-store.js";
import type { PopoverAnchor } from "../ui/popover-menu.js";
import { showToast } from "./toast.js";
import "../ui/choice-selector.js";
import "./settings/model-selector-controls.js";

@customElement("model-picker")
export class ModelPicker extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** The model shown; the picker shows nothing without one. */
  @property({ attribute: false }) model: ModelSetting | null = null;
  @property({ attribute: false }) choose: ((model: ModelSetting) => void | Promise<void>) | null = null;
  /** What the choice applies to, under the panel's heading. */
  @property({ type: String }) caption = "";
  @property({ type: String }) anchor: PopoverAnchor = "left";

  @state() private registry = new ModelRegistryStore();
  @state() private loading = false;
  @state() private pending: ModelSetting | null = null;

  private get shown(): ModelSetting | null {
    const model = this.pending ?? this.model;
    if (!model || model.runtimeType) return model;
    // A session older than its runtime column has none; its provider's is the one its model runs on.
    const provider = this.registry.providers.find((candidate) =>
      candidate.provider === model.provider && candidate.models.some((entry) => entry.id === model.modelId));
    return { ...model, runtimeType: provider?.runtimeType ?? "" };
  }

  private async ensureLoaded() {
    if (this.loading || this.registry.providers.length > 0) return;
    this.loading = true;
    const result = await this.registry.load();
    this.loading = false;
    if ("error" in result) showToast(`Failed to load models: ${result.error}`, "error");
  }

  private async change(update: Partial<ModelSetting>) {
    const next: ModelSetting = { runtimeType: "", provider: "", modelId: "", thinkingLevel: "high", ...this.shown, ...update };
    if (!next.provider || !next.modelId || !this.choose) return;

    this.pending = next;
    try {
      await this.choose(next);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to change the model", "error");
    } finally {
      if (this.pending === next) this.pending = null;
    }
  }

  private renderPopoverContent() {
    if (this.loading) return html`<div class="p-3 text-xs text-zinc-400">Loading models...</div>`;
    const shown = this.shown;
    return html`
      <div class="w-full p-3 space-y-3">
        <div>
          <div class="text-xs font-medium text-zinc-200">Session model</div>
          ${this.caption ? html`<div class="text-[10px] text-zinc-500 mt-1">${this.caption}</div>` : nothing}
        </div>
        <model-selector-controls
          .providers=${this.registry.availableProviders}
          .selectedRuntimeType=${shown?.runtimeType ?? ""}
          .selectedProvider=${shown?.provider ?? ""}
          .selectedModel=${shown?.modelId ?? ""}
          .selectedThinking=${shown?.thinkingLevel ?? "high"}
          .saving=${this.pending !== null}
          .showClear=${false}
          .showCurrent=${false}
          emptyMessage="Add a provider in Settings → Models to choose the model."
          @selection-change=${(e: CustomEvent<{ runtimeType: string; provider: string; modelId: string }>) => void this.change(e.detail)}
          @thinking-change=${(e: CustomEvent<{ thinkingLevel: ModelSetting["thinkingLevel"] }>) => void this.change({ thinkingLevel: e.detail.thinkingLevel })}
        ></model-selector-controls>
      </div>
    `;
  }

  override render() {
    const shown = this.shown;
    if (!shown) return nothing;
    return html`
      <choice-selector
        label=${formatModelSettingLabel({ providers: this.registry.providers, model: shown })}
        anchor=${this.anchor}
        panelClass="w-80"
        .content=${() => this.renderPopoverContent()}
        @click=${() => void this.ensureLoaded()}
      ></choice-selector>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "model-picker": ModelPicker;
  }
}
