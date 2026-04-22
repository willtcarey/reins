import { existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { createRequire } from "module";

const PLATFORM = process.platform;
const ARCH = process.arch;

// Both musl and glibc optional packages may be installed. Prefer whichever
// matches the host's libc by checking for the presence of its dynamic linker.
// Distros may or may not ship the "wrong" linker, but the musl binary is built
// with interpreter `/lib/ld-musl-*.so.1`, and absence of that on glibc systems
// is what caused the spawn to fail with ENOENT.
function isGlibcHost(): boolean {
  if (PLATFORM !== "linux") return false;
  return (
    existsSync("/lib64/ld-linux-x86-64.so.2") ||
    existsSync("/lib/ld-linux-x86-64.so.2") ||
    existsSync("/lib/ld-linux-aarch64.so.1")
  );
}

/**
 * Resolve the native Claude binary shipped as an optional dependency of
 * @anthropic-ai/claude-agent-sdk.
 *
 * The SDK's built-in resolution uses `createRequire(import.meta.url)` to find
 * the platform package (e.g. `@anthropic-ai/claude-agent-sdk-linux-x64`).
 * This works with npm/pnpm but fails with bun, which hoists optional deps
 * into `node_modules/.bun/` and doesn't expose them through `require.resolve`.
 *
 * Strategy: resolve the SDK package (always present as a direct dep), then
 * look for the sibling platform package next to it.
 */
export function resolveClaudeBinary(): string {
  const suffix = PLATFORM === "win32" ? ".exe" : "";
  const packageNames =
    PLATFORM === "linux"
      ? isGlibcHost()
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${ARCH}`,
            `@anthropic-ai/claude-agent-sdk-linux-${ARCH}-musl`,
          ]
        : [
            `@anthropic-ai/claude-agent-sdk-linux-${ARCH}-musl`,
            `@anthropic-ai/claude-agent-sdk-linux-${ARCH}`,
          ]
      : [`@anthropic-ai/claude-agent-sdk-${PLATFORM}-${ARCH}`];

  const require_ = createRequire(import.meta.url);

  // 1. Standard require.resolve (works for npm/pnpm layouts)
  for (const pkg of packageNames) {
    try {
      const pkgJson = require_.resolve(`${pkg}/package.json`);
      const binary = join(dirname(pkgJson), `claude${suffix}`);
      if (existsSync(binary)) return binary;
    } catch {
      // not resolvable — try next
    }
  }

  // 2. Resolve the SDK itself and look for its sibling platform package.
  //    Bun layout: node_modules/.bun/<sdk>@<ver>+<hash>/node_modules/@anthropic-ai/claude-agent-sdk
  //    Sibling:   node_modules/.bun/<sdk>-<platform>-<arch>@<ver>/node_modules/@anthropic-ai/<pkg>
  try {
    const sdkPkgJson = require_.resolve(
      "@anthropic-ai/claude-agent-sdk/package.json",
    );
    // sdkPkgJson = .../.bun/<sdkDir>/node_modules/@anthropic-ai/claude-agent-sdk/package.json
    // Walk up four levels to reach .bun/
    const bunDir = join(sdkPkgJson, "..", "..", "..", "..", "..");

    if (existsSync(bunDir)) {
      const entries = readdirSync(bunDir);
      for (const pkg of packageNames) {
        const scopedPrefix = `${pkg.replace("/", "+")}@`;
        const match = entries.find((e) => e.startsWith(scopedPrefix));
        if (!match) continue;
        const binary = join(
          bunDir,
          match,
          "node_modules",
          pkg,
          `claude${suffix}`,
        );
        if (existsSync(binary)) return binary;
      }
    }
  } catch {
    // SDK not resolvable via package.json — very unusual, fall through
  }

  // 3. Globally installed claude as last resort
  const home = process.env.HOME ?? "";
  if (home) {
    const global = join(home, ".local/bin/claude");
    if (existsSync(global)) return global;
  }

  throw new Error(
    `Could not find Claude native binary for ${PLATFORM}-${ARCH}. ` +
      `Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, ` +
      `or set pathToClaudeCodeExecutable in query options.`,
  );
}
