/**
 * Settings → Secrets (`<settings-secrets-section>`): the requests no one has answered, which the user can cancel, and
 * the stored secrets, by name and without their values, which the user can delete. Read again when the backend part
 * says they changed.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Disposer, HttpOutput, ReinsSdk } from "@reins/sdk";
import type { SecretsApi } from "@backend/extensions/secrets/api.js";
import { confirmDialog } from "../../ui/confirm-dialog.js";
import { showToast } from "../../ui/toast.js";

type Stored = HttpOutput<SecretsApi["stored"]>[number];
type Request = HttpOutput<SecretsApi["requests"]>[number];

const ROW_BUTTON = "shrink-0 rounded-md border border-zinc-600 px-2.5 py-1 text-xs text-zinc-200 transition-colors hover:bg-zinc-800";
const date = (iso: string) => new Date(iso).toLocaleString();

@customElement("settings-secrets-section")
export class SettingsSecretsSection extends LitElement {
  @property({ attribute: false }) reins: ReinsSdk<SecretsApi> | null = null;
  @state() private stored: readonly Stored[] = [];
  @state() private requests: readonly Request[] = [];
  @state() private loaded = false;

  private stops: Disposer[] = [];

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    const reins = this.reins;
    if (!reins) return;
    this.stops = [reins.onMessage(() => void this.load()), reins.onReconnect(() => void this.load())];
    void this.load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    for (const stop of this.stops) stop();
    this.stops = [];
  }

  private async load() {
    const reins = this.reins;
    if (!reins) return;
    try {
      [this.stored, this.requests] = await Promise.all([reins.http.call("stored"), reins.http.call("requests")]);
      this.loaded = true;
    } catch (error) {
      showToast(`Failed to load secrets: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private async act(failure: string, work: () => Promise<void>) {
    try {
      await work();
      await this.load();
    } catch (error) {
      showToast(`${failure}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private async deleteSecret(secret: Stored) {
    const confirmed = await confirmDialog({
      title: `Delete ${secret.name}?`,
      message: "Reins deletes the stored value. The session's handle for it no longer works. Copies already written to files stay.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (confirmed) await this.act("Failed to delete the secret", () => this.reins!.http.call("remove", { id: secret.id }));
  }

  override render() {
    if (!this.loaded) return nothing;
    return html`
      <div class="flex flex-col gap-6 text-sm">
        <p class="text-xs text-zinc-500">A stored secret is deleted 7 days after its last use.</p>
        ${this.requests.length > 0 ? html`
          <section class="flex flex-col gap-2">
            <h3 class="text-xs font-medium uppercase tracking-wide text-zinc-500">Waiting for you</h3>
            ${this.requests.map(request => html`
              <div class="flex items-center justify-between gap-3 rounded-md border border-zinc-700 px-3 py-2">
                <span class="min-w-0 truncate font-mono text-xs text-zinc-200">${request.fields.map(field => field.name).join(", ")}</span>
                <button type="button" class=${ROW_BUTTON} @click=${() => this.act("Failed to cancel the request", () => this.reins!.http.call("cancel", { id: request.id }))}>Cancel</button>
              </div>
            `)}
          </section>
        ` : nothing}
        <section class="flex flex-col gap-2">
          <h3 class="text-xs font-medium uppercase tracking-wide text-zinc-500">Stored</h3>
          ${this.stored.length === 0 ? html`<p class="text-xs text-zinc-500">No secrets are stored.</p>` : this.stored.map(secret => html`
            <div class="flex items-center justify-between gap-3 rounded-md border border-zinc-700 px-3 py-2">
              <span class="flex min-w-0 flex-col">
                <span class="truncate font-mono text-xs text-zinc-100">${secret.name}</span>
                <span class="text-[11px] text-zinc-500">Stored ${date(secret.createdAt)}${secret.lastUsedAt ? ` · last used ${date(secret.lastUsedAt)}` : " · not used yet"}</span>
              </span>
              <button type="button" class=${ROW_BUTTON} @click=${() => this.deleteSecret(secret)}>Delete</button>
            </div>
          `)}
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-secrets-section": SettingsSecretsSection;
  }
}
