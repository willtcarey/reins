import { describe, expect, test, mock } from "bun:test";
import { MAX_ATTACHMENT_BYTES } from "../../session-attachments-store.js";
import { UploadedFile } from "../../models/uploaded-file.js";

function writeUInt16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUInt16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUInt24LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeUInt32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeUInt32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function pngBytes(width = 640, height = 480): Buffer {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  writeUInt32BE(bytes, 16, width);
  writeUInt32BE(bytes, 20, height);
  return Buffer.from(bytes);
}

function gifBytes(width: number, height: number): Buffer {
  const bytes = new Uint8Array(10);
  bytes.set([71, 73, 70, 56, 57, 97]);
  writeUInt16LE(bytes, 6, width);
  writeUInt16LE(bytes, 8, height);
  return Buffer.from(bytes);
}

function jpegBytes(width: number, height: number): Buffer {
  const bytes = new Uint8Array(29);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  writeUInt16BE(bytes, 13, height);
  writeUInt16BE(bytes, 15, width);
  return Buffer.from(bytes);
}

function webpBytes(width: number, height: number): Buffer {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70]); // RIFF
  writeUInt32LE(bytes, 4, 22);
  bytes.set([87, 69, 66, 80, 86, 80, 56, 88], 8); // WEBPVP8X
  writeUInt32LE(bytes, 16, 10);
  writeUInt24LE(bytes, 24, width - 1);
  writeUInt24LE(bytes, 27, height - 1);
  return Buffer.from(bytes);
}

function imageFile(bytes: Buffer, name = "screen.png", type = "image/png"): File {
  const body = new Uint8Array(bytes.length);
  body.set(bytes);
  return new File([body], name, { type });
}

describe("UploadedFile", () => {
  test("returns all data needed to store an uploaded image attachment", async () => {
    const bytes = pngBytes(321, 123);
    const file = imageFile(bytes, "screen.png", "image/png");
    const readBytes = mock(file.arrayBuffer.bind(file));
    Object.defineProperty(file, "arrayBuffer", { value: readBytes });

    const uploaded = new UploadedFile(file);
    uploaded.assertSupportedImageAttachment();
    const input = await uploaded.toImageAttachmentInput();

    expect(readBytes).toHaveBeenCalledTimes(1);
    expect(input).toEqual({
      data: bytes,
      mimeType: "image/png",
      filename: "screen.png",
      width: 321,
      height: 123,
    });
  });

  test("reads dimensions for all supported image upload formats", async () => {
    const cases = [
      { name: "screen.png", type: "image/png", bytes: pngBytes(321, 123), width: 321, height: 123 },
      { name: "screen.gif", type: "image/gif", bytes: gifBytes(320, 200), width: 320, height: 200 },
      { name: "screen.jpg", type: "image/jpeg", bytes: jpegBytes(1024, 768), width: 1024, height: 768 },
      { name: "screen.webp", type: "image/webp", bytes: webpBytes(800, 600), width: 800, height: 600 },
    ];

    for (const item of cases) {
      const input = await new UploadedFile(imageFile(item.bytes, item.name, item.type)).toImageAttachmentInput();
      expect(input).toMatchObject({
        mimeType: item.type,
        filename: item.name,
        width: item.width,
        height: item.height,
      });
    }
  });

  test("validates the declared upload shape before bytes are read", async () => {
    const unsupported = new File(["hello"], "note.txt", { type: "text/plain" });
    const readBytes = mock(unsupported.arrayBuffer.bind(unsupported));
    Object.defineProperty(unsupported, "arrayBuffer", { value: readBytes });

    expect(() => new UploadedFile(unsupported).assertSupportedImageAttachment())
      .toThrow("Unsupported image type: text/plain");
    await expect(new UploadedFile(unsupported).toImageAttachmentInput()).rejects
      .toThrow("Unsupported image type: text/plain");
    expect(readBytes).not.toHaveBeenCalled();

    expect(() => new UploadedFile(new File([], "empty.png", { type: "image/png" })).assertSupportedImageAttachment())
      .toThrow("Attachment is empty");

    expect(() => new UploadedFile(new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "big.png", { type: "image/png" })).assertSupportedImageAttachment())
      .toThrow(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`);
  });

  test("rejects malformed image bytes", async () => {
    const uploaded = new UploadedFile(imageFile(Buffer.from([137, 80, 78, 71])));

    await expect(uploaded.toImageAttachmentInput()).rejects.toThrow("Image dimensions could not be read");
  });
});
