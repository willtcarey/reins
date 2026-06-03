/**
 * HTML Viewer — renders HTML files in a sandboxed iframe.
 *
 * The preview uses `srcdoc` so the project file is never executed in the app
 * document. The iframe is sandboxed with script execution enabled but without
 * same-origin, form, popup, or navigation escape permissions. A synthetic
 * `<base>` tag also prevents relative project assets from accidentally
 * resolving against the Reins app URL. Because scripts are enabled, the
 * preview injects a tiny Escape-key bridge that posts a dismiss request back
 * to the parent file browser when focus is inside the iframe.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

export const HTML_PREVIEW_ESCAPE_MESSAGE = "reins:file-preview:escape";
export const HTML_PREVIEW_ESCAPE_EVENT = "html-preview-escape";

const ESCAPE_BRIDGE_SCRIPT = `<script>
(function () {
  window.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      window.parent.postMessage({ type: "${HTML_PREVIEW_ESCAPE_MESSAGE}" }, "*");
    }
  }, true);
}());
</script>`;

const SANDBOX_HEAD = [
  `<base href="about:blank" target="_blank">`,
  `<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'; object-src 'none'; form-action 'none'; navigate-to 'none'">`,
  `<style>a[href], area[href] { pointer-events: none !important; cursor: not-allowed !important; }</style>`,
  ESCAPE_BRIDGE_SCRIPT,
].join("");
const HEAD_OPEN_RE = /<head(\s[^>]*)?>/i;
const HTML_OPEN_RE = /<html(\s[^>]*)?>/i;

/**
 * Add preview-only safety/limitation metadata to an HTML document.
 *
 * `base href="about:blank"` keeps relative assets from loading against the
 * app's URL space. `target="_blank"` combined with a sandbox that does not
 * allow popups prevents normal link clicks from navigating the preview away.
 * The injected CSP allows inline scripts while blocking external script files,
 * forms, plugins, and navigation.
 */
export function buildSandboxedHtmlPreview(content: string): string {
  if (HEAD_OPEN_RE.test(content)) {
    return content.replace(HEAD_OPEN_RE, (tag) => `${tag}${SANDBOX_HEAD}`);
  }

  if (HTML_OPEN_RE.test(content)) {
    return content.replace(
      HTML_OPEN_RE,
      (tag) => `${tag}<head>${SANDBOX_HEAD}</head>`,
    );
  }

  return `<!doctype html><html><head>${SANDBOX_HEAD}</head><body>${content}</body></html>`;
}

function isHtmlPreviewEscapeMessage(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === HTML_PREVIEW_ESCAPE_MESSAGE
  );
}

@customElement("file-viewer-html")
export class FileViewerHtml extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /** Raw HTML text to render. */
  @property({ attribute: false }) content: string | null = null;

  private _iframeMessageSource: MessageEventSource | null = null;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("message", this._onMessage);
  }

  override disconnectedCallback() {
    window.removeEventListener("message", this._onMessage);
    super.disconnectedCallback();
  }

  private _captureIframe = (event: Event & { currentTarget: HTMLIFrameElement }) => {
    this._iframeMessageSource = event.currentTarget.contentWindow;
  };

  private _onMessage = (event: MessageEvent) => {
    if (!isHtmlPreviewEscapeMessage(event.data)) return;

    const iframeSource =
      this._iframeMessageSource ??
      this.querySelector<HTMLIFrameElement>("iframe")?.contentWindow ??
      null;
    if (!iframeSource || event.source !== iframeSource) return;

    this.dispatchEvent(
      new CustomEvent(HTML_PREVIEW_ESCAPE_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  };

  override render() {
    if (this.content == null) return nothing;

    return html`
      <div class="flex-1 overflow-hidden min-h-0 flex flex-col bg-zinc-900">
        <iframe
          class="flex-1 w-full min-h-0 border-0 bg-white"
          title="HTML preview"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          @load=${this._captureIframe}
          .srcdoc=${buildSandboxedHtmlPreview(this.content)}
        ></iframe>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "file-viewer-html": FileViewerHtml;
  }
}
