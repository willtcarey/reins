/**
 * Strip leading `<skill …>…</skill>` blocks (and the whitespace between them)
 * from a persisted user message body. Symmetric inverse of `expandPrompt` —
 * used for list/preview surfaces that should show the user's visible text only.
 */
export function stripLeadingSkillBlocks(text: string | null): string | null {
  if (text === null) return null;
  let rest = text;
  const blockRe = /^<skill\b[^>]*>[\s\S]*?<\/skill>\s*/;
  while (true) {
    const match = rest.match(blockRe);
    if (!match) break;
    rest = rest.slice(match[0].length);
  }
  return rest;
}
