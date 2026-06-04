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

export interface AttachmentInfo {
  id: string;
  kind: "image";
  mimeType: string;
  filename?: string;
  byteSize: number;
  sha256: string;
  url: string;
  width?: number;
  height?: number;
}

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
    return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(block.attachmentId)}`;
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
