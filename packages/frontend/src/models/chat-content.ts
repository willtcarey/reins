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
export type ClientPromptContent = string | ClientPromptBlock[];
export type ChatImageBlock = InlineImageBlock | ImageAttachmentBlock;

export interface AttachmentInfo {
  id: string;
  kind: "image";
  mimeType: string;
  filename?: string;
  byteSize: number;
  sha256: string;
  url: string;
}

export function isTextContentBlock(value: unknown): value is TextContentBlock {
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

export function textFromClientContent(content: string | (TextContentBlock | ChatImageBlock)[]): string {
  if (typeof content === "string") return content;
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
