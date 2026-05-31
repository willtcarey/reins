export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ImageAttachmentBlock {
  type: "image";
  attachmentId: string;
  mimeType: string;
  filename?: string;
  byteSize: number;
  sha256?: string;
}

export interface InlineImageBlock {
  type: "image";
  data: string;
  mimeType: string;
  filename?: string;
}

export type ClientPromptBlock = TextContentBlock | ImageAttachmentBlock;
export type RuntimePromptBlock = TextContentBlock | InlineImageBlock;

export type ClientPromptContent = string | ClientPromptBlock[];
export type RuntimePromptContent = string | RuntimePromptBlock[];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isTextContentBlock(value: unknown): value is TextContentBlock {
  return isRecord(value)
    && value.type === "text"
    && typeof value.text === "string";
}

export function isImageAttachmentBlock(value: unknown): value is ImageAttachmentBlock {
  return isRecord(value)
    && value.type === "image"
    && typeof value.attachmentId === "string"
    && typeof value.mimeType === "string"
    && typeof value.byteSize === "number"
    && (value.filename === undefined || typeof value.filename === "string")
    && (value.sha256 === undefined || typeof value.sha256 === "string");
}

export function isInlineImageBlock(value: unknown): value is InlineImageBlock {
  return isRecord(value)
    && value.type === "image"
    && typeof value.data === "string"
    && typeof value.mimeType === "string"
    && (value.filename === undefined || typeof value.filename === "string");
}

export function isClientPromptContent(value: unknown): value is ClientPromptContent {
  if (typeof value === "string") return true;
  if (!Array.isArray(value)) return false;
  return value.every((block) => isTextContentBlock(block) || isImageAttachmentBlock(block));
}

export function runtimePromptToTextAndImages(content: RuntimePromptContent): {
  text: string;
  images: InlineImageBlock[];
} {
  if (typeof content === "string") return { text: content, images: [] };

  const textParts: string[] = [];
  const images: InlineImageBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else {
      images.push(block);
    }
  }
  return { text: textParts.join("\n"), images };
}
