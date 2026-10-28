/**
 * Images sized for the provider. Anthropic rejects an image over 5 MB of base64, and an image stays in the
 * session's history, so one oversized image would fail every later request of the session.
 */
import type { ReadImageProcessor } from "@earendil-works/pi-agent-core";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";

/** Anthropic's recommended long side: larger images are scaled down by the provider anyway. */
export const MAX_IMAGE_EDGE = 1568;
/** Pi's own limit, below Anthropic's 5 MB of base64 with headroom. */
export const MAX_PROVIDER_IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024;

export const fitsProvider = (byteLength: number) => Math.ceil(byteLength / 3) * 4 < MAX_PROVIDER_IMAGE_BASE64_BYTES;
export const formatMiB = (byteLength: number) => `${(byteLength / (1024 * 1024)).toFixed(1)} MiB`;

export interface FittedImage { data: string; mimeType: string; width?: number; height?: number; hints: string[] }

/**
 * `bytes` scaled to at most `MAX_IMAGE_EDGE` on its long side and re-encoded until it fits the provider
 * (Pi's photon resizer, which picks PNG or JPEG, whichever is smaller), with Pi's note on the original size
 * when it was resized. When the resizer cannot decode it or is unavailable, an image that already fits is
 * kept as it is; null for one that does not.
 */
export async function fitImage(bytes: Uint8Array, mimeType: string): Promise<FittedImage | null> {
  const resized = await resizeImage(bytes, mimeType, { maxWidth: MAX_IMAGE_EDGE, maxHeight: MAX_IMAGE_EDGE, maxBytes: MAX_PROVIDER_IMAGE_BASE64_BYTES });
  if (resized) {
    const note = formatDimensionNote(resized);
    return { data: resized.data, mimeType: resized.mimeType, width: resized.width, height: resized.height, hints: note ? [note] : [] };
  }
  return fitsProvider(bytes.byteLength) ? { data: Buffer.from(bytes).toString("base64"), mimeType, hints: [] } : null;
}

/** The read tool's image processor. It runs on the server, on the bytes `fs.read` brought from the node. */
export const readImageProcessor: ReadImageProcessor = async (bytes, mimeType) => {
  const fitted = await fitImage(bytes, mimeType);
  if (!fitted) return { ok: false, message: `[Image omitted: ${formatMiB(bytes.byteLength)} is over the provider's image size limit, and it could not be resized.]` };
  return { ok: true, data: fitted.data, mimeType: fitted.mimeType, hints: fitted.hints };
};
