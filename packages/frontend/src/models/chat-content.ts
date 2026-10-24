import { api } from "./api.js";

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ImageSizeHint {
  width: number;
  height: number;
}

export interface ImageAttachmentBlock {
  type: "image";
  attachmentId: string;
  mimeType: string;
  filename?: string;
  byteSize: number;
  sha256?: string;
  width?: number;
  height?: number;
}

export interface InlineImageBlock {
  type: "image";
  data: string;
  mimeType: string;
  filename?: string;
  width?: number;
  height?: number;
}

type ClientPromptBlock = TextContentBlock | ImageAttachmentBlock;
export type ClientPromptContent = ClientPromptBlock[];
export type ChatImageBlock = InlineImageBlock | ImageAttachmentBlock;

function isTextContentBlock(value: unknown): value is TextContentBlock {
  return typeof value === "object" && value !== null
    && "type" in value && value.type === "text"
    && "text" in value && typeof value.text === "string";
}

export function isImageAttachmentBlock(value: unknown): value is ImageAttachmentBlock {
  return typeof value === "object" && value !== null
    && "type" in value && value.type === "image"
    && "attachmentId" in value && typeof value.attachmentId === "string";
}

export function isInlineImageBlock(value: unknown): value is InlineImageBlock {
  return typeof value === "object" && value !== null
    && "type" in value && value.type === "image"
    && "data" in value && typeof value.data === "string";
}

export function textFromClientContent(content: (TextContentBlock | ChatImageBlock)[]): string {
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join("\n");
}

export function imagesFromContent(content: unknown): ChatImageBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ChatImageBlock => isImageAttachmentBlock(block) || isInlineImageBlock(block));
}

export function imageBlockSrc(sessionId: string, block: ChatImageBlock): string {
  if (isImageAttachmentBlock(block)) {
    return api.sessions.attachmentUrl(sessionId, block.attachmentId);
  }
  return `data:${block.mimeType};base64,${block.data}`;
}

export function normalizeImageSizeHint(width: unknown, height: unknown): ImageSizeHint | null {
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

export function imageSizeHint(block: ChatImageBlock): ImageSizeHint | null {
  return normalizeImageSizeHint(block.width, block.height);
}

export function imageAspectRatioStyle(block: ChatImageBlock): string {
  const hint = imageSizeHint(block);
  return hint ? `aspect-ratio: ${hint.width} / ${hint.height};` : "";
}

let nextFallbackClientId = 0;

/** A new submission's client ID: the server admits a prompt or steer once under it. */
export function createClientId(): string {
  const nativeId = globalThis.crypto?.randomUUID?.();
  if (nativeId) return nativeId;

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
    bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  nextFallbackClientId += 1;
  return `${Date.now().toString(36)}-${nextFallbackClientId.toString(36)}-${Math.random().toString(36).slice(2)}`;
}
