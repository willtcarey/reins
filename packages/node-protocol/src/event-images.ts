/** Image blocks live in `content` arrays (messages, tool results, partial tool results). These helpers
 * visit exactly those blocks anywhere in a value, so the node can turn tool-result images into attachment
 * references and replace any image that is not one before it sends a session event. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isImage = (value: unknown): value is Record<string, unknown> & { type: "image" } => isRecord(value) && value.type === "image";

/** Every image block found in a `content` array anywhere inside `value`. */
export function contentImages(value: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown, inContent: boolean) => {
    if (Array.isArray(node)) { for (const item of node) { if (inContent && isImage(item)) found.push(item); else visit(item, false); } return; }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) visit(child, key === "content" && Array.isArray(child));
  };
  visit(value, false);
  return found;
}

/** Copy of `value` with every image block in a `content` array replaced by `replace(block)`; other
 * values are shared, not cloned. */
export function mapContentImages(value: unknown, replace: (block: Record<string, unknown>) => unknown): unknown {
  const visit = (node: unknown, inContent: boolean): unknown => {
    if (Array.isArray(node)) return node.map(item => inContent && isImage(item) ? replace(item) : visit(item, false));
    if (!isRecord(node)) return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child, key === "content" && Array.isArray(child))]));
  };
  return visit(value, false);
}
