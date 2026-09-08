/** Shared file-type and source rendering helpers. */

/** Check whether a file path has a markdown extension (.md, .mdx, .markdown). */
export function isMarkdown(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

const IMAGE_EXTS = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i;

/** Check whether a file path is an image supported by the file browser. */
export function isImage(path: string): boolean {
  return IMAGE_EXTS.test(path);
}

/** Check whether a file path is a PDF. */
export function isPdf(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/** Check whether a file path has an HTML extension (.html, .htm, .xhtml). */
export function isHtml(path: string): boolean {
  return /\.(html?|xhtml)$/i.test(path);
}

/** Whether source lines should wrap instead of scrolling horizontally. */
export function shouldWrapLines(path: string): boolean {
  return isMarkdown(path);
}

/** Escape HTML special characters so text can be safely inserted into markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
