import { deflateSync } from "node:zlib";

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An RGB PNG of `width`×`height` pseudo-random pixels (the same for the same size): noise barely
 * compresses, so the file is about 3 bytes a pixel, which makes images over a size limit cheap to build. */
export function noisePng(width: number, height: number): Uint8Array {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let state = 0x9e3779b9;
  for (let i = 0; i < rows.byteLength; i++) {
    if (i % (width * 3 + 1) === 0) continue; // the row's filter byte: none
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    rows[i] = state & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 1 })), chunk("IEND", new Uint8Array())]));
}
