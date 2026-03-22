/**
 * Static File Serving
 *
 * Serves frontend assets with SPA fallback and cache-busting
 * for index.html asset references.
 */

/**
 * Serve a static file from `frontendDir` for the given `pathname`.
 *
 * - `/` maps to `/index.html`
 * - Existing files are served directly (index.html gets cache-busting)
 * - Unknown paths fall back to index.html (SPA routing)
 * - Returns 404 if nothing matches
 */
export async function serveStatic(
  frontendDir: string,
  pathname: string,
): Promise<Response> {
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = `${frontendDir}${filePath}`;

  const file = Bun.file(fullPath);
  if (await file.exists()) {
    if (filePath === "/index.html") {
      return serveIndexHtml(frontendDir, file);
    }
    return new Response(file);
  }

  // SPA fallback
  const indexFile = Bun.file(`${frontendDir}/index.html`);
  if (await indexFile.exists()) {
    return serveIndexHtml(frontendDir, indexFile);
  }

  return new Response("Not Found", { status: 404 });
}

/**
 * Serve index.html with cache-busting query params on asset references.
 *
 * Rewrites href/src attributes pointing at /dist/ assets to include a ?v=<mtime>
 * query param so the browser fetches fresh assets after rebuilds. The HTML itself
 * is served with Cache-Control: no-cache so the browser always revalidates it.
 */
async function serveIndexHtml(
  frontendDir: string,
  file: ReturnType<typeof Bun.file>,
): Promise<Response> {
  let html = await file.text();

  // Match href="..." and src="..." attributes referencing /dist/ assets
  html = await replaceAsync(
    html,
    /(href|src)="(\/dist\/[^"]+)"/g,
    async (match, attr, assetPath) => {
      const assetFile = Bun.file(`${frontendDir}${assetPath}`);
      if (await assetFile.exists()) {
        const mtime = assetFile.lastModified;
        return `${attr}="${assetPath}?v=${mtime}"`;
      }
      return match;
    },
  );

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

/** Helper: async version of String.replace with a regex. */
async function replaceAsync(
  str: string,
  regex: RegExp,
  replacer: (match: string, ...args: string[]) => Promise<string>,
): Promise<string> {
  const matches: { match: string; groups: string[]; index: number }[] = [];
  // The replace callback signature is (match, ...captures, offset, fullString).
  // TypeScript types the rest as string[], but offset is actually a number.
  str.replace(regex, (match: string, ...args: Array<string | number>) => {
    const offset = args.at(-2);
    matches.push({
      match,
      groups: args.slice(0, -2).map(String),
      index: typeof offset === "number" ? offset : Number(offset),
    });
    return match;
  });

  let result = "";
  let lastIndex = 0;
  for (const m of matches) {
    result += str.slice(lastIndex, m.index);
    result += await replacer(m.match, ...m.groups);
    lastIndex = m.index + m.match.length;
  }
  result += str.slice(lastIndex);
  return result;
}
