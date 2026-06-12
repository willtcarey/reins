/**
 * MIME type detection using the `file` command (libmagic).
 *
 * Examines actual file content (magic bytes / heuristics), not extensions, so
 * it correctly identifies source code files (.rb, .py, .go, etc.) as text —
 * unlike extension-based databases (Bun, npm `mime`) which lack entries for
 * most programming languages.
 */

export function parseMimeType(output: string): string | null {
  const mimeType = output.trim().toLowerCase();
  if (!mimeType) return null;
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) return null;
  return mimeType;
}

/**
 * Detect the MIME type of in-memory bytes.
 *
 * This keeps git-ref previews content-based too: the file may not exist in the
 * working tree, but `git show` can still provide the exact bytes for libmagic.
 */
export async function detectMimeTypeFromFile(path: string): Promise<string> {
  try {
    const proc = Bun.spawn(["file", "--brief", "--mime-type", "--", path], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const mimeType = parseMimeType(output);
      if (mimeType) return mimeType;
    }
  } catch {
    // Fall through to default.
  }

  return "application/octet-stream";
}

export async function detectMimeTypeFromBytes(bytes: Uint8Array): Promise<string> {
  try {
    const proc = Bun.spawn(["file", "--brief", "--mime-type", "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    if (!proc.stdin) throw new Error("stdin unavailable");
    proc.stdin.write(bytes);
    proc.stdin.end();

    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const mimeType = parseMimeType(output);
      if (mimeType) return mimeType;
    }
  } catch {
    // Fall through to default.
  }

  return "application/octet-stream";
}
