/**
 * What the MCP server lists share (the Settings page's own servers, `mcp-servers-section.ts`; a session's servers from
 * `.mcp.json`, `repo-servers-list.ts`; the user's own in a session's list, `own-servers-list.ts`): a server's card, with
 * its name and badges, its switch, its command or URL, its status and tools, and a sign-in in progress; the sign-in
 * window; and texts cut to 3 lines until Show more.
 */

import type { McpServerStatus, McpTool } from "@backend/extensions/mcp/connections.js";
import type { McpAuthKind, McpTransportKind } from "@backend/extensions/mcp/store.js";
import { html, nothing, type ReactiveController, type ReactiveControllerHost, type TemplateResult } from "lit";
import type { Loadable } from "../../helpers/loadable.js";
import { chevronDownIcon, chevronRightIcon } from "../../ui/icons.js";
import { statusDot, statusLabel } from "./mcp-servers-store.js";

/** A section of a session's list: its heading, and a link-like action beside it. */
export const SECTION_HEADING = "text-[10px] font-medium text-zinc-400 uppercase tracking-wide";
export const LINK_BUTTON = "text-xs text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-zinc-200 hover:decoration-solid cursor-pointer transition-colors";
export const ROW_BUTTON = "px-2.5 py-1 text-xs rounded-md border cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default";
const BADGE = "text-[10px] text-zinc-400 bg-zinc-700/60 px-1.5 py-0.5 rounded shrink-0";
const TESTING_DOT = "bg-blue-400 motion-safe:animate-pulse";

/**
 * Opens the sign-in window, blank, while the click is still running: browsers (Safari, Firefox) block a popup opened
 * after an await. The server's callback page closes it once done. Null when blocked, or when the browser opens no
 * window (an installed app): the card's sign-in notice links to the page then.
 */
export function openSignInWindow(): Window | null {
  return globalThis.open?.("", "_blank", "popup,width=520,height=720") ?? null;
}

/** Sends the window `openSignInWindow` opened to the authorization page. */
export function showSignInPage(popup: Window | null, authorizationUrl: string): void {
  if (!popup) return;
  // The authorization page needs no way back to this tab (it could navigate it through `opener`).
  popup.opener = null;
  popup.location.href = authorizationUrl;
}

/** Whether a text is likely longer than its 3 clamped lines: measuring the DOM would be exact but needs layout. */
function isLong(text: string): boolean {
  return text.length > 200 || text.split("\n").length > 3;
}

/** Texts cut to 3 lines until the user asks for more, each by a key of the host's. */
export class ClampedTexts implements ReactiveController {
  private expanded = new Set<string>();

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostConnected(): void {}

  render(key: string, text: string | undefined, classes: string): TemplateResult | typeof nothing {
    if (!text) return nothing;
    const long = isLong(text);
    const expanded = this.expanded.has(key);
    return html`
      <p class="${classes} whitespace-pre-line break-words ${long && !expanded ? "line-clamp-3" : ""}">${text}</p>
      ${long ? html`<button
        class="mt-0.5 text-xs text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-zinc-200 hover:decoration-solid cursor-pointer transition-colors"
        aria-expanded=${expanded ? "true" : "false"}
        @click=${() => this.toggle(key)}
      >${expanded ? "Show less" : "Show more"}</button>` : nothing}
    `;
  }

  private toggle(key: string): void {
    const expanded = new Set(this.expanded);
    if (!expanded.delete(key)) expanded.add(key);
    this.expanded = expanded;
    this.host.requestUpdate();
  }
}

/** A server as a card draws it, with what its list does for each control. */
export interface McpServerCard {
  id: number;
  name: string;
  transport: McpTransportKind | "stdio";
  /** A remote server's, as its badge. */
  authKind?: McpAuthKind;
  /** Its command line or URL. */
  where: string;
  /** Under its name, cut to 3 lines. */
  instructions?: string;
  status: McpServerStatus;
  /** A test runs: the status says so. */
  testing?: boolean;
  /** Its switch: on, the label to read for it, and what flipping it does. */
  toggle: { on: boolean; label: string; busy: boolean; flip(): void };
  /** Its Sign in button, when it needs one. */
  signIn?: { busy: boolean; label?: string; start(): void } | null;
  /** More controls after the switch (a menu), or before it (Sign out). */
  menu?: unknown;
  before?: unknown;
  /** The sign-in in progress for it: its page, as a link too. */
  signingIn?: { authorizationUrl: string; cancel(): void } | null;
  /** Its tools: whether they can be asked for, those shown (undefined: hidden), and showing or hiding them. */
  tools: { available: boolean; shown: Loadable<McpTool[]> | undefined; toggle(): void };
  /** Under the status: notes and fields of the list's own. */
  details?: unknown;
}

function renderSwitch({ on, label, busy, flip }: McpServerCard["toggle"]) {
  return html`
    <button
      type="button"
      role="switch"
      aria-checked=${on ? "true" : "false"}
      title=${label}
      class="relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${on ? "bg-blue-600" : "bg-zinc-600"}"
      ?disabled=${busy}
      @click=${flip}
    ><span class="sr-only">${label}</span><span class="inline-block h-3 w-3 rounded-full bg-white transition-transform ${on ? "translate-x-3.5" : "translate-x-0.5"}" aria-hidden="true"></span></button>
  `;
}

function renderToolsToggle(tools: McpServerCard["tools"]) {
  const shown = tools.shown !== undefined;
  return html`
    <button
      class="flex items-center gap-0.5 text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors"
      aria-expanded=${shown ? "true" : "false"}
      @click=${tools.toggle}
    >${shown ? chevronDownIcon("", 12) : chevronRightIcon("", 12)}<span>Tools</span></button>
  `;
}

function renderTools(card: McpServerCard, clamped: ClampedTexts) {
  const tools = card.tools.shown;
  if (!tools) return nothing;
  return html`
    <div class="mt-3 border-t border-zinc-700/60 pt-3 space-y-1.5 text-xs">
      ${tools.loading && !tools.data ? html`<p class="text-zinc-500">Listing tools…</p>` : nothing}
      ${tools.error ? html`<p class="text-amber-400/90 break-words">Can't list tools: ${tools.error}</p>` : nothing}
      ${tools.data?.length === 0 ? html`<p class="text-zinc-500">No tools</p>` : nothing}
      ${tools.data?.length ? html`
        <ul class="space-y-2" aria-label="${card.name} tools">
          ${tools.data.map(tool => html`
            <li>
              <p class="font-mono text-zinc-200 break-all">${tool.name}</p>
              ${clamped.render(`${card.id}:${tool.name}`, tool.description, "mt-0.5 text-zinc-500")}
            </li>
          `)}
        </ul>
      ` : nothing}
    </div>
  `;
}

function renderSigningIn(name: string, signingIn: McpServerCard["signingIn"]) {
  if (!signingIn) return nothing;
  return html`
    <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-zinc-200" role="status">
      <span>Finish signing in to ${name} in the window that opened.</span>
      <a href=${signingIn.authorizationUrl} target="_blank" rel="noopener" class="text-blue-400 hover:text-blue-300 underline">Open the sign-in page</a>
      <button class="ml-auto text-zinc-400 hover:text-zinc-200 cursor-pointer" @click=${signingIn.cancel}>Cancel</button>
    </div>
  `;
}

/** A server's card, in a list's `<ul>`. */
export function mcpServerCard(card: McpServerCard, clamped: ClampedTexts): TemplateResult {
  const { status, testing = false } = card;
  const warning = !testing && (status.state === "error" || status.state === "needs_sign_in");
  return html`
    <li class="rounded-lg border border-zinc-700/70 bg-zinc-800/40 p-3 ${card.toggle.on ? "" : "opacity-70"}">
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium text-zinc-100 truncate" translate="no">${card.name}</span>
        ${card.transport === "stdio" || !card.authKind ? nothing : html`<span class=${BADGE}>${card.authKind === "none" ? "no auth" : card.authKind}</span>`}
        ${card.transport === "http" ? nothing : html`<span class=${BADGE}>${card.transport}</span>`}
        <span class="ml-auto flex items-center gap-2 shrink-0">
          ${card.before ?? nothing}
          ${card.signIn
            ? html`<button class="${ROW_BUTTON} border-blue-500/60 bg-blue-600/20 text-blue-200 hover:bg-blue-600/40" ?disabled=${card.signIn.busy} @click=${card.signIn.start}>${card.signIn.label ?? "Sign in"}</button>`
            : nothing}
          ${renderSwitch(card.toggle)}
          ${card.menu ?? nothing}
        </span>
      </div>
      ${clamped.render(String(card.id), card.instructions, "mt-1 text-xs text-zinc-400")}
      <p class="mt-1 text-xs text-zinc-500 font-mono truncate" title=${card.where} translate="no">${card.where}</p>
      <div class="mt-2 flex items-center gap-3 text-xs">
        <span class="flex items-center gap-1.5 ${warning ? "text-amber-400/90" : "text-zinc-400"}">
          <span class="w-2 h-2 rounded-full shrink-0 ${testing ? TESTING_DOT : statusDot(status)}" aria-hidden="true"></span>${testing ? "testing…" : statusLabel(status)}
        </span>
        ${card.tools.available ? renderToolsToggle(card.tools) : nothing}
      </div>
      ${status.state === "error" ? html`<p class="mt-2 rounded-md bg-red-950/40 border border-red-900/50 px-3 py-2 text-xs text-red-200/90 break-words whitespace-pre-wrap">${status.message}</p>` : nothing}
      ${card.details ?? nothing}
      ${renderSigningIn(card.name, card.signingIn)}
      ${card.tools.available ? renderTools(card, clamped) : nothing}
    </li>
  `;
}
