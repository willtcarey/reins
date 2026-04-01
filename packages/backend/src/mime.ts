/**
 * MIME type detection using the `file` command (libmagic).
 *
 * Examines actual file content (magic bytes / heuristics), not just the
 * extension, so it correctly identifies source code files (.rb, .py, .go,
 * etc.) as text — unlike extension-based databases (Bun, npm `mime`) which
 * lack entries for most programming languages.
 */

/**
 * Detect the MIME type of a file.
 *
 * Falls back to `application/octet-stream` if `file` fails or the type
 * can't be determined.
 */
export async function detectMimeType(filePath: string): Promise<string> {
  try {
    const proc = Bun.spawn(["file", "--brief", "--mime-type", filePath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const mimeType = output.trim();
    return mimeType || "application/octet-stream";
  } catch {
    return "application/octet-stream";
  }
}
