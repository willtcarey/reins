/**
 * Shared Highlighter Singleton
 *
 * Single Shiki web worker instance shared across the entire app —
 * diff highlighting, markdown code blocks, etc.
 */

import { Highlighter } from "./highlighter.js";

let instance: Highlighter | null = null;

export function getSharedHighlighter(): Highlighter {
  if (!instance) {
    instance = new Highlighter();
  }
  return instance;
}
