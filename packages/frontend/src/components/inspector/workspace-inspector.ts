import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { StoreController } from "../../controllers/store-controller.js";
import type { InspectorTab } from "../../models/inspector.js";
import type { IconName, ViewName, ViewOf, WorkspaceContext } from "../../reins-sdk/contract.js";
import type { ViewRegistry } from "../../reins-sdk/view-registry.js";
import { closeIcon, codeIcon, diffIcon, fileIcon, folderIcon, previewIcon } from "../../ui/icons.js";
import { inspectorTabCloseEvent, inspectorTabFocusEvent } from "../events.js";
import "../view-mount.js";

const ICONS: Record<IconName, () => TemplateResult> = {
  file: () => fileIcon("shrink-0"),
  folder: () => folderIcon("shrink-0", 14),
  code: () => codeIcon("shrink-0 size-3.5"),
  preview: () => previewIcon("shrink-0 size-3.5"),
  diff: () => diffIcon("shrink-0"),
};

interface TabLabel {
  title: string;
  description: string;
  icon: TemplateResult;
}

/** Truncates a title before its extension, so `workspace-inspector.ts` and `.md` stay apart. */
function renderTitle(title: string) {
  const dot = title.lastIndexOf(".");
  if (dot <= 0) return html`<span class="truncate">${title}</span>`;
  return html`<span class="flex min-w-0"><span class="truncate">${title.slice(0, dot)}</span><span class="shrink-0">${title.slice(dot)}</span></span>`;
}

/**
 * The Inspector: a strip of tabs, each showing a view. Every tab stays rendered while hidden, so a
 * file keeps its place and mode while another tab is shown. On a phone the tabs' panels sit side by
 * side in a track, one page each, which the workspace's swipe moves.
 */
@customElement("workspace-inspector")
export class WorkspaceInspector extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) tabs: readonly InspectorTab[] = [];
  @property({ attribute: false }) activeKey = "";
  /** Where the Inspector finds how to show each tab's view; it renders again when a renderer comes or goes. */
  @property({ attribute: false })
  set views(views: ViewRegistry | null) { this.viewsController.store = views; this.requestUpdate(); }
  get views(): ViewRegistry | null { return this.viewsController.store; }
  /** What views are shown for: every view is given it. */
  @property({ attribute: false }) context: WorkspaceContext | null = null;
  /** On a phone, where a swipe has dragged the track of panels (null at rest, on the active tab). */
  @property({ attribute: false }) swipeX: number | null = null;

  private viewsController = new StoreController<ViewRegistry>(this);
  private resizeObserver: ResizeObserver | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.resizeObserver = new ResizeObserver(() => this.revealActiveTab());
    this.resizeObserver.observe(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("activeKey") || changed.has("tabs")) this.revealActiveTab();
  }

  /**
   * Scrolls the strip, and only the strip, to the active tab: `scrollIntoView` would also scroll
   * the workspace's clipped ancestors and shift the mobile pages.
   */
  private revealActiveTab() {
    const strip = this.querySelector<HTMLElement>("[role=tablist]");
    const tab = strip?.querySelector<HTMLElement>("[aria-selected=true]")?.parentElement;
    if (!strip || !tab) return;
    const inset = 8;
    const stripBox = strip.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    if (tabBox.left < stripBox.left + inset) strip.scrollLeft -= stripBox.left + inset - tabBox.left;
    else if (tabBox.right > stripBox.right - inset) strip.scrollLeft += tabBox.right - (stripBox.right - inset);
  }

  // The strip hides its scrollbar, so a mouse wheel is the only way a mouse can reach hidden tabs.
  private scrollStrip(event: WheelEvent) {
    const strip = event.currentTarget;
    if (!(strip instanceof HTMLElement) || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += event.deltaY;
    event.preventDefault();
  }

  private label<K extends ViewName>(view: ViewOf<K>): TabLabel {
    const pane = this.views?.rendererFor(view)?.pane;
    if (!pane) return { title: view.view, description: `${view.view} (unavailable)`, icon: fileIcon("shrink-0") };
    return { title: pane.title(view), description: pane.description(view), icon: ICONS[pane.icon]() };
  }

  private renderContent<K extends ViewName>(view: ViewOf<K>) {
    const pane = this.views?.rendererFor(view)?.pane;
    if (!pane) return html`<p class="p-4 text-sm text-zinc-500">This view is not available.</p>`;
    return html`<reins-view-mount class="flex h-full min-h-0 flex-col" .presentation=${pane} .view=${view} .context=${this.context}></reins-view-mount>`;
  }

  private renderTab(tab: InspectorTab) {
    const active = tab.key === this.activeKey;
    const { title, description, icon } = this.label(tab.view);
    const closable = tab.closable;
    return html`
      <div
        class="group flex h-8 max-w-[min(12rem,85%)] shrink-0 items-center rounded-md text-xs font-medium transition-colors pointer-coarse:h-9 has-[[role=tab]:focus-visible]:ring-2 has-[[role=tab]:focus-visible]:ring-blue-500/60 ${active ? "bg-zinc-800 text-zinc-100 ring-1 ring-zinc-700/70" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}"
        @mousedown=${(event: MouseEvent) => { if (event.button === 1) event.preventDefault(); }}
        @auxclick=${(event: MouseEvent) => { if (event.button === 1 && closable) this.dispatchEvent(inspectorTabCloseEvent(tab.key)); }}
      >
        <button
          role="tab"
          aria-selected=${active ? "true" : "false"}
          title=${description}
          class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md outline-none ${closable ? "pl-2.5 pr-1" : "px-2.5"}"
          @click=${() => this.dispatchEvent(inspectorTabFocusEvent(tab.key))}
        ><span class="flex shrink-0 ${active ? "text-zinc-300" : "text-zinc-500 group-hover:text-zinc-400"}">${icon}</span>${renderTitle(title)}</button>
        ${closable ? html`
          <button
            class="mr-1.5 grid size-5 shrink-0 cursor-pointer place-items-center rounded text-zinc-500 outline-none transition-[color,background-color,opacity] hover:bg-zinc-700 hover:text-zinc-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-500/60 pointer-coarse:size-7 pointer-coarse:opacity-100 ${active ? "" : "opacity-0 group-hover:opacity-100"}"
            title="Close"
            @click=${() => this.dispatchEvent(inspectorTabCloseEvent(tab.key))}
          >${closeIcon("", 12)}<span class="sr-only">Close ${title}</span></button>
        ` : nothing}
      </div>
    `;
  }

  override render() {
    const activeIndex = Math.max(0, this.tabs.findIndex((tab) => tab.key === this.activeKey));
    const trackX = this.swipeX == null ? `${-activeIndex * 100}%` : `${this.swipeX}px`;
    return html`
      <div class="flex h-full min-h-0 min-w-0 flex-col">
        <div
          role="tablist"
          aria-label="Inspector"
          data-swipe-surface
          class="flex h-[50px] shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-zinc-800/80 bg-zinc-900/80 px-2 [scrollbar-width:none]"
          @wheel=${this.scrollStrip}
        >
          ${this.tabs.map((tab) => this.renderTab(tab))}
        </div>
        <div class="relative min-h-0 flex-1 overflow-hidden">
          <div class="flex h-full md:block md:!transform-none" style=${`transform: translate3d(${trackX}, 0, 0);`}>
            ${repeat(this.tabs, (tab) => tab.key, (tab) => html`
              <div
                role="tabpanel"
                aria-label=${this.label(tab.view).description}
                class="flex h-full min-h-0 w-full shrink-0 flex-col md:absolute md:inset-0 ${tab.key === this.activeKey ? "" : "md:hidden"}"
                ?inert=${tab.key !== this.activeKey}
              >
                ${this.renderContent(tab.view)}
              </div>
            `)}
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "workspace-inspector": WorkspaceInspector;
  }
}
