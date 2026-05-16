import { describe, expect, test } from "bun:test";
import { detectMimeTypeFromBytes } from "../mime.js";

const encode = (content: string) => new TextEncoder().encode(content);

describe("detectMimeTypeFromBytes", () => {
  test("returns text/* for source code bytes", async () => {
    const files = [
      "class User < ApplicationRecord; end",
      "def hello(): print('hi')",
      "package main\nfunc main() {}",
      'fn main() { println!("hi"); }',
      "defmodule App do; end",
      "let x: Int = 5",
      'fun main() { println("hi") }',
    ];

    for (const content of files) {
      const mime = await detectMimeTypeFromBytes(encode(content));
      expect(mime).toStartWith("text/");
    }
  });

  test("detects JSON, images, PDFs, and binary bytes", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    ]);

    expect(await detectMimeTypeFromBytes(encode('{"key":"value"}'))).toBe("application/json");
    expect(await detectMimeTypeFromBytes(png)).toBe("image/png");
    expect(await detectMimeTypeFromBytes(encode("%PDF-1.4 fake content"))).toBe("application/pdf");
    expect(await detectMimeTypeFromBytes(new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]))).toBe("application/octet-stream");
  });
});
