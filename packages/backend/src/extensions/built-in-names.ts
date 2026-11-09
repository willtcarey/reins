/**
 * Every built-in extension's name, whatever parts it has: the server registers those with a backend part
 * (`built-in.ts`), the app activates those with a frontend part (`frontend/src/extensions/built-in.ts`), and
 * both lists are typed with `BuiltInExtensionName`, so a name missing here does not compile. The server
 * records each one in `extensions`, so the user can turn off one with only a frontend part too.
 */
export const BUILT_IN_EXTENSION_NAMES = [
  "mcp",
  "automations",
  "recent-sessions",
  "openai-images",
  "secrets",
  "sidebar-projects",
  "file-viewer",
  "file-references",
  "compact-command",
  "new-session-command",
] as const;

export type BuiltInExtensionName = (typeof BUILT_IN_EXTENSION_NAMES)[number];
