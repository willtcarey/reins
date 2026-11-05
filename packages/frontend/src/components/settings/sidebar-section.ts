/**
 * Settings → Sidebar: every section registered for the sidebar, in the order it shows them, each with a switch
 * and buttons to move it up or down. Changes show in the sidebar at once and are stored as a setting
 * (`SidebarSections`); one that cannot be stored is put back, with a toast.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { ArrangedSection, SidebarSections } from "../../sdk-host/sidebar-sections.js";
import { StoreController } from "../../controllers/store-controller.js";
import { chevronDownIcon } from "../../ui/icons.js";
import { showToast } from "../../ui/toast.js";

@customElement("settings-sidebar-section")
export class SettingsSidebarSection extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private sectionsController = new StoreController<SidebarSections>(this);

  @property({ attribute: false })
  set sections(sections: SidebarSections | null) {
    this.sectionsController.store = sections;
  }

  get sections(): SidebarSections | null {
    return this.sectionsController.store;
  }

  private async change(run: () => Promise<void>) {
    try {
      await run();
    } catch (error) {
      showToast(`Failed to save the sidebar: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  private renderRow(sections: SidebarSections, { section, visible }: ArrangedSection, index: number, count: number) {
    const title = section.title ?? section.id;
    const moveClass = "cursor-pointer rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";
    return html`
      <li class="flex items-center gap-3 px-4 py-2.5">
        <span class="min-w-0 flex-1 truncate text-sm ${visible ? "text-zinc-200" : "text-zinc-500"}">${title}</span>
        <button type="button" class=${moveClass} title="Move up" ?disabled=${index === 0}
          @click=${() => void this.change(() => sections.move(section.id, -1))}
        ><span class="sr-only">Move ${title} up</span>${chevronDownIcon("rotate-180", 14)}</button>
        <button type="button" class=${moveClass} title="Move down" ?disabled=${index === count - 1}
          @click=${() => void this.change(() => sections.move(section.id, 1))}
        ><span class="sr-only">Move ${title} down</span>${chevronDownIcon("", 14)}</button>
        <button
          type="button"
          role="switch"
          aria-checked=${visible ? "true" : "false"}
          title=${visible ? `Hide ${title}` : `Show ${title}`}
          class="relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors ${visible ? "bg-blue-600" : "bg-zinc-600"}"
          @click=${() => void this.change(() => sections.setVisible(section.id, !visible))}
        ><span class="sr-only">Show ${title}</span><span class="inline-block h-3 w-3 rounded-full bg-white transition-transform ${visible ? "translate-x-3.5" : "translate-x-0.5"}" aria-hidden="true"></span></button>
      </li>
    `;
  }

  override render() {
    const sections = this.sections;
    if (!sections) return nothing;
    const arranged = sections.arrangement();
    if (arranged.length === 0) return html`<p class="text-xs text-zinc-500">No extension has registered a sidebar section.</p>`;
    return html`
      <ul class="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/25" aria-label="Sidebar sections">
        ${repeat(arranged, ({ section }) => section.id, (entry, index) => this.renderRow(sections, entry, index, arranged.length))}
      </ul>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "settings-sidebar-section": SettingsSidebarSection;
  }
}
