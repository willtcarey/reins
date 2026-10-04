/**
 * MIME type detection using the `file` command (libmagic).
 *
 * Examines actual content (magic bytes / heuristics), not extensions, so
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
 * Detect the MIME type of a file's leading bytes. Files live on nodes, so the
 * server sniffs bytes it was sent: a working-tree file's through `fs.read`, a
 * file at a git ref's through `git cat-file`.
 */
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
