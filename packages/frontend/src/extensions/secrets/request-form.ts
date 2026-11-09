/**
 * The secrets extension's form (`<secrets-request-form>`): one masked field per name a session asked for, each with a
 * show/hide control. The values go only to `submit` (the extension's own API), and are forgotten once sent or when the
 * form goes.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HttpOutput } from "@reins/sdk";
import type { SecretsApi } from "@backend/extensions/secrets/api.js";
import { eyeIcon, eyeOffIcon } from "../../ui/icons.js";

export type SecretsRequest = HttpOutput<SecretsApi["requests"]>[number];

const MAX_VALUE_BYTES = 16 * 1024;
const isOneLine = (value: string | undefined) =>
  !!value && !["\r", "\n", "\0"].some(character => value.includes(character)) && new TextEncoder().encode(value).byteLength <= MAX_VALUE_BYTES;

const INPUT = "w-full rounded border border-zinc-600 bg-zinc-800 py-1.5 pl-2.5 pr-9 font-mono text-base text-zinc-100 outline-none transition-colors focus:border-blue-500 md:text-xs";
const BUTTON = "rounded-md px-3 py-1.5 text-xs transition-colors disabled:cursor-default disabled:opacity-50";

@customElement("secrets-request-form")
export class SecretsRequestForm extends LitElement {
  /** Null once it has ended (answered or cancelled, maybe in another browser). */
  @property({ attribute: false }) request: SecretsRequest | null = null;
  @property({ attribute: false }) submit: (values: Record<string, string>) => Promise<void> = async () => {};
  @property({ attribute: false }) cancel: () => Promise<void> = async () => {};

  @state() private values: Record<string, string> = {};
  @state() private revealed: Record<string, boolean> = {};
  @state() private busy = false;
  @state() private error = "";
  @state() private outcome: "stored" | "cancelled" | null = null;

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.values = {};
  }

  private send = async (event: Event) => {
    event.preventDefault();
    const fields = this.request?.fields ?? [];
    if (!fields.every(({ name }) => isOneLine(this.values[name]))) {
      this.error = "Each value must be one non-empty line of at most 16 KiB";
      return;
    }
    await this.finish(() => this.submit(Object.fromEntries(fields.map(({ name }) => [name, this.values[name]!]))), "stored");
  };

  private stop = () => this.finish(() => this.cancel(), "cancelled");

  private async finish(work: () => Promise<void>, outcome: "stored" | "cancelled") {
    this.busy = true;
    this.error = "";
    try {
      await work();
      this.values = {};
      this.outcome = outcome;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  override render() {
    if (this.outcome === "stored") return this.notice("Stored. The session has a reference to each value, not the value.");
    if (this.outcome === "cancelled") return this.notice("Cancelled: nothing was stored.");
    const request = this.request;
    if (!request) return this.notice("This request has ended.");
    return html`
      <form class="flex flex-col gap-4 p-3 text-sm" @submit=${this.send}>
        <div class="flex flex-col gap-1.5">
          ${request.purpose ? html`<p class="leading-relaxed text-zinc-200">${request.purpose}</p>` : nothing}
          <p class="text-xs text-zinc-500">The values are kept encrypted by Reins. The agent gets a reference to each, never the value.</p>
        </div>
        ${request.fields.map(({ name, description }) => {
          const shown = this.revealed[name] ?? false;
          return html`
            <label class="flex min-w-0 flex-col gap-1">
              <span class="font-mono text-xs font-semibold text-zinc-100" translate="no">${name}</span>
              ${description ? html`<span class="text-xs text-zinc-400">${description}</span>` : nothing}
              <span class="relative">
                <input
                  class=${INPUT}
                  type=${shown ? "text" : "password"}
                  aria-label=${name}
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck="false"
                  .value=${this.values[name] ?? ""}
                  ?disabled=${this.busy}
                  @input=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.values = { ...this.values, [name]: event.target.value }; }}
                />
                <button
                  type="button"
                  class="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-100"
                  aria-pressed=${shown ? "true" : "false"}
                  ?disabled=${this.busy}
                  @click=${() => { this.revealed = { ...this.revealed, [name]: !shown }; }}
                >${shown ? eyeOffIcon("w-4 h-4") : eyeIcon("w-4 h-4")}<span class="sr-only">${shown ? "Hide" : "Show"} ${name}</span></button>
              </span>
            </label>
          `;
        })}
        ${this.error ? html`<p class="rounded-md border border-red-800/60 bg-red-950/40 px-2 py-1 text-xs text-red-300" aria-live="polite">${this.error}</p>` : nothing}
        <div class="flex justify-end gap-2 border-t border-zinc-700/70 pt-3">
          <button type="button" class="${BUTTON} text-zinc-300 hover:bg-zinc-800" ?disabled=${this.busy} @click=${this.stop}>Cancel</button>
          <button type="submit" class="${BUTTON} bg-blue-600 text-white hover:bg-blue-500" ?disabled=${this.busy}>Store secrets</button>
        </div>
      </form>
    `;
  }

  private notice(text: string) {
    return html`<p class="p-3 text-sm text-zinc-400">${text}</p>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "secrets-request-form": SecretsRequestForm;
  }
}
