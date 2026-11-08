/** The frontend part: runs in the browser. Its build leaves Lit out: the app provides it. */
import type { ReinsSdk } from "@reins/sdk";
import { html } from "lit";
import type { Api } from "./api.js";
import { ScopedElement, defineElement, mountElement } from "./elements.js";

class Settings extends ScopedElement {
  static override properties = { message: { state: true } };
  declare message: string;
  reins: ReinsSdk<Api> | null = null;

  constructor() {
    super();
    this.message = "";
  }

  private async greet(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement) || !this.reins) return;
    const name = String(new FormData(form).get("name") ?? "");
    const { message, count } = await this.reins.http.call("greet", { name });
    this.message = `${message} (${count})`;
  }

  override render() {
    return html`
      <form class="flex gap-2" @submit=${this.greet}>
        <input name="name" aria-label="Name" class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100" />
        <button class="rounded bg-zinc-700 px-2.5 py-1 text-xs text-zinc-100 hover:bg-zinc-600">Greet</button>
      </form>
      <p class="mt-2 text-xs text-zinc-400">${this.message}</p>
    `;
  }
}
const SETTINGS = defineElement("hello-settings", Settings);

export default function register(reins: ReinsSdk<Api>) {
  return reins.settings.register({
    mount: target => mountElement(target, SETTINGS, Settings, settings => { settings.reins = reins; }),
  });
}
