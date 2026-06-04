import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  type StoreSessionAttachmentInput,
} from "../session-attachments-store.js";

interface ImageDimensions {
  width: number;
  height: number;
}

export class UploadedFile {
  private static readonly PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
  private static readonly WEBP_RIFF = [82, 73, 70, 70] as const; // RIFF
  private static readonly WEBP_TYPE = [87, 69, 66, 80] as const; // WEBP

  constructor(private readonly file: File) {}

  get declaredByteSize(): number {
    return this.file.size;
  }

  get mimeType(): string {
    return this.file.type;
  }

  get filename(): string | undefined {
    const name = this.file.name?.trim();
    return name ? name : undefined;
  }

  assertSupportedImageAttachment(): void {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(this.mimeType)) {
      throw new Error(`Unsupported image type: ${this.mimeType || "unknown"}`);
    }
    if (!Number.isFinite(this.declaredByteSize) || this.declaredByteSize <= 0) {
      throw new Error("Attachment is empty");
    }
    if (this.declaredByteSize > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`);
    }
  }

  async bytes(): Promise<Buffer> {
    return Buffer.from(await this.file.arrayBuffer());
  }

  async toImageAttachmentInput(): Promise<StoreSessionAttachmentInput> {
    this.assertSupportedImageAttachment();
    const bytes = await this.bytes();
    const dimensions = UploadedFile.readImageDimensions(bytes, this.mimeType);
    if (!dimensions) throw new Error("Image dimensions could not be read");

    return {
      data: bytes,
      mimeType: this.mimeType,
      filename: this.filename,
      width: dimensions.width,
      height: dimensions.height,
    };
  }

  private static readImageDimensions(
    data: Uint8Array | Buffer,
    mimeType: string,
  ): ImageDimensions | null {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    switch (mimeType) {
      case "image/png":
        return UploadedFile.readPngDimensions(bytes, view);
      case "image/jpeg":
        return UploadedFile.readJpegDimensions(bytes, view);
      case "image/gif":
        return UploadedFile.readGifDimensions(bytes, view);
      case "image/webp":
        return UploadedFile.readWebpDimensions(bytes, view);
      default:
        return null;
    }
  }

  private static validDimensions(width: number, height: number): ImageDimensions | null {
    if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }

  private static matches(bytes: Uint8Array, offset: number, values: readonly number[]): boolean {
    if (bytes.length < offset + values.length) return false;
    return values.every((value, index) => bytes[offset + index] === value);
  }

  private static readPngDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
    if (bytes.length < 24) return null;
    if (!UploadedFile.matches(bytes, 0, UploadedFile.PNG_SIGNATURE)) return null;
    if (!UploadedFile.matches(bytes, 12, [73, 72, 68, 82])) return null; // IHDR
    return UploadedFile.validDimensions(view.getUint32(16, false), view.getUint32(20, false));
  }

  private static readGifDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
    if (bytes.length < 10) return null;
    const isGif87a = UploadedFile.matches(bytes, 0, [71, 73, 70, 56, 55, 97]);
    const isGif89a = UploadedFile.matches(bytes, 0, [71, 73, 70, 56, 57, 97]);
    if (!isGif87a && !isGif89a) return null;
    return UploadedFile.validDimensions(view.getUint16(6, true), view.getUint16(8, true));
  }

  private static readJpegDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

    let offset = 2;
    while (offset + 3 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) return null;

      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;

      const segmentLength = view.getUint16(offset, false);
      if (segmentLength < 2) return null;
      const segmentStart = offset + 2;
      const segmentEnd = offset + segmentLength;
      if (segmentEnd > bytes.length) return null;

      if (UploadedFile.isJpegStartOfFrame(marker)) {
        if (segmentStart + 5 > segmentEnd) return null;
        return UploadedFile.validDimensions(
          view.getUint16(segmentStart + 3, false),
          view.getUint16(segmentStart + 1, false),
        );
      }

      offset = segmentEnd;
    }

    return null;
  }

  private static isJpegStartOfFrame(marker: number): boolean {
    return (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
  }

  private static readWebpDimensions(bytes: Uint8Array, view: DataView): ImageDimensions | null {
    if (bytes.length < 20) return null;
    if (!UploadedFile.matches(bytes, 0, UploadedFile.WEBP_RIFF) || !UploadedFile.matches(bytes, 8, UploadedFile.WEBP_TYPE)) return null;

    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkType = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      const chunkSize = view.getUint32(offset + 4, true);
      const payloadStart = offset + 8;
      const payloadEnd = payloadStart + chunkSize;
      if (payloadEnd > bytes.length) return null;

      if (chunkType === "VP8X") return UploadedFile.readWebpVp8xDimensions(bytes, payloadStart, chunkSize);
      if (chunkType === "VP8L") return UploadedFile.readWebpVp8lDimensions(bytes, view, payloadStart, chunkSize);
      if (chunkType === "VP8 ") return UploadedFile.readWebpVp8Dimensions(bytes, view, payloadStart, chunkSize);

      offset = payloadEnd + (chunkSize % 2);
    }

    return null;
  }

  private static readWebpVp8xDimensions(
    bytes: Uint8Array,
    payloadStart: number,
    chunkSize: number,
  ): ImageDimensions | null {
    if (chunkSize < 10) return null;
    const width = 1 + UploadedFile.readUInt24LE(bytes, payloadStart + 4);
    const height = 1 + UploadedFile.readUInt24LE(bytes, payloadStart + 7);
    return UploadedFile.validDimensions(width, height);
  }

  private static readWebpVp8lDimensions(
    bytes: Uint8Array,
    view: DataView,
    payloadStart: number,
    chunkSize: number,
  ): ImageDimensions | null {
    if (chunkSize < 5 || bytes[payloadStart] !== 0x2f) return null;
    const bits = view.getUint32(payloadStart + 1, true);
    return UploadedFile.validDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }

  private static readWebpVp8Dimensions(
    bytes: Uint8Array,
    view: DataView,
    payloadStart: number,
    chunkSize: number,
  ): ImageDimensions | null {
    if (chunkSize < 10) return null;
    if (!UploadedFile.matches(bytes, payloadStart + 3, [0x9d, 0x01, 0x2a])) return null;
    return UploadedFile.validDimensions(
      view.getUint16(payloadStart + 6, true) & 0x3fff,
      view.getUint16(payloadStart + 8, true) & 0x3fff,
    );
  }

  private static readUInt24LE(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  }
}
