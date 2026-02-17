/**
 * Shiki Highlight Web Worker
 *
 * Runs syntax highlighting off the main thread. Receives diff lines grouped
 * by file path, highlights them via Shiki, and posts back the HTML results.
 *
 * Protocol:
 *   Main → Worker:  { id, type: "highlight", files: Array<{ path, lines: string[] }> }
 *   Worker → Main:  { id, type: "result", files: Array<{ path, htmlLines: string[] }> }
 */

import {
  createHighlighter,
  type Highlighter,
  type BundledLanguage,
} from "shiki/bundle/web";

// Map file extensions to Shiki language identifiers (bundle/web subset)
const EXT_TO_LANG: Record<string, BundledLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  java: "java",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  php: "php",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  mdx: "mdx",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  r: "r",
  svelte: "svelte",
  vue: "vue",
  coffee: "coffee",
  csv: "csv",
  sass: "sass",
  glsl: "glsl",
};

function langFromPath(filePath: string): BundledLanguage | null {
  const basename = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";
  const ext = basename.split(".").pop()?.toLowerCase();
  return ext ? (EXT_TO_LANG[ext] ?? null) : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Worker state ----------------------------------------------------------

let highlighter: Highlighter | null = null;
const loadedLangs = new Set<string>();

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ["github-dark"],
      langs: [], // load languages on demand
    });
  }
  return highlighter;
}

async function ensureLang(hl: Highlighter, lang: BundledLanguage): Promise<void> {
  if (loadedLangs.has(lang)) return;
  try {
    await hl.loadLanguage(lang);
    loadedLangs.add(lang);
  } catch {
    // Language not available in Shiki — fall back to plain text
  }
}

/**
 * Highlight an array of source lines for a given file path.
 * Returns an array of HTML strings (one per input line).
 */
async function highlightLines(
  hl: Highlighter,
  filePath: string,
  lines: string[],
): Promise<string[]> {
  const lang = langFromPath(filePath);

  if (!lang) {
    return lines.map(escapeHtml);
  }

  await ensureLang(hl, lang);
  if (!loadedLangs.has(lang)) {
    return lines.map(escapeHtml);
  }

  // Highlight the lines as a single block so Shiki can track state across lines
  const source = lines.join("\n");
  const html = hl.codeToHtml(source, {
    lang,
    theme: "github-dark",
    structure: "inline",
  });

  // Shiki v3 with structure: "inline" uses <br> for line breaks.
  // Split on <br> (or <br/> / <br />) to get per-line HTML.
  return html.split(/<br\s*\/?>/);
}

// ---- Message handler -------------------------------------------------------

export interface HighlightRequest {
  id: number;
  type: "highlight";
  files: Array<{ path: string; lines: string[] }>;
}

export interface HighlightResponse {
  id: number;
  type: "result";
  files: Array<{ path: string; htmlLines: string[] }>;
}

self.onmessage = async (e: MessageEvent<HighlightRequest>) => {
  const { id, files } = e.data;

  try {
    const hl = await getHighlighter();

    const results = await Promise.all(
      files.map(async ({ path, lines }) => ({
        path,
        htmlLines: await highlightLines(hl, path, lines),
      })),
    );

    const response: HighlightResponse = { id, type: "result", files: results };
    self.postMessage(response);
  } catch (err: any) {
    // On error, return escaped plain text so the UI still works
    const results = files.map(({ path, lines }) => ({
      path,
      htmlLines: lines.map(escapeHtml),
    }));
    const response: HighlightResponse = { id, type: "result", files: results };
    self.postMessage(response);
  }
};
