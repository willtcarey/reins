/**
 * Strip leading `<skill …>…</skill>` blocks (and the whitespace between them)
 * from a persisted user message body, for list/preview surfaces that should show the user's visible text only.
 * Messages admitted before skills became hidden blocks after the text (`expandSkills`) began with them.
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
