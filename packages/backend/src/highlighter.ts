/**
 * Syntax Highlighting
 *
 * Highlights full file contents using highlight.js and returns
 * an array of highlighted HTML strings, one per line.
 */

import hljs from "highlight.js";
import { escapeHtml } from "./html-utils.js";

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  swift: "swift",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "shell",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
  lua: "lua",
  r: "r",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  vim: "vim",
  tf: "hcl",
  proto: "protobuf",
  zig: "zig",
};

function langFromPath(filePath: string): string | undefined {
  // Handle special filenames like Dockerfile, Makefile
  const basename = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";

  const ext = basename.split(".").pop()?.toLowerCase();
  return ext ? EXT_TO_LANG[ext] : undefined;
}

/**
 * Highlight a complete file source string.
 * Returns an array of HTML strings, one per line.
 * Falls back to HTML-escaped plain text if the language is unknown.
 */
export function highlightLines(filePath: string, source: string): string[] {
  const lang = langFromPath(filePath);
  let highlighted: string;

  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
  } else {
    // Auto-detect as fallback, or just escape
    try {
      const result = hljs.highlightAuto(source);
      highlighted = result.value;
    } catch {
      highlighted = escapeHtml(source);
    }
  }

  // hljs returns a single HTML string; split on newlines.
  // Tricky: spans can cross line boundaries. We need to close/reopen them at each line break.
  return splitHighlightedLines(highlighted);
}

/**
 * Split highlighted HTML on newlines while keeping span tags balanced per line.
 */
function splitHighlightedLines(html: string): string[] {
  const rawLines = html.split("\n");
  const result: string[] = [];
  const openSpans: string[] = []; // stack of full opening tags

  for (const raw of rawLines) {
    // Prepend any spans that were open from the previous line
    let line = openSpans.join("") + raw;

    // Track open/close spans to maintain the stack
    // Match all <span ...> and </span> tags in this raw line
    const tagRegex = /<\/?span[^>]*>/g;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(raw)) !== null) {
      const tag = match[0];
      if (tag.startsWith("</")) {
        openSpans.pop();
      } else {
        openSpans.push(tag);
      }
    }

    // Close any open spans at end of this line
    line += "</span>".repeat(openSpans.length);

    result.push(line);
  }

  return result;
}


