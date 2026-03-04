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
  bundledLanguages,
  type Highlighter,
  type BundledLanguage,
} from "shiki/bundle/full";

// Override map for extensions that don't match their Shiki language ID
const EXT_OVERRIDES: Record<string, BundledLanguage> = {
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  cc: "cpp",
  cxx: "cpp",
  h: "c",
  hpp: "cpp",
  sh: "shellscript",
  zsh: "shellscript",
  htm: "html",
  svg: "xml",
  yml: "yaml",
  md: "markdown",
  gql: "graphql",
  rb: "ruby",
};

// Filename-based overrides for files without extensions
const FILENAME_TO_LANG: Record<string, BundledLanguage> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
};

const bundledLangIds = new Set(Object.keys(bundledLanguages));

function langFromPath(filePath: string): BundledLanguage | null {
  const basename = filePath.split("/").pop()?.toLowerCase() ?? "";

  // Check filename matches first
  const filenameLang = FILENAME_TO_LANG[basename];
  if (filenameLang) return filenameLang;

  const ext = basename.split(".").pop()?.toLowerCase();
  if (!ext) return null;

  // Check overrides first, then try the extension directly as a language ID
  const override = EXT_OVERRIDES[ext];
  if (override) return override;
  if (bundledLangIds.has(ext)) return ext as BundledLanguage;
  return null;
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
