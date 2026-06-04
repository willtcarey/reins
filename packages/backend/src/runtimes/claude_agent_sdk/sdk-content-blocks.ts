import type { ContentBlockParam, ImageBlockParam } from "@anthropic-ai/sdk/resources";
import type { HydratedPromptBlock, HydratedPromptContent, InlineImageBlock } from "../../messages-store.js";

type SDKImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function assertNever(value: never): never {
  throw new Error(`Unsupported prompt content block: ${JSON.stringify(value)}`);
}

export function toClaudeSdkImageMediaType(mimeType: string): SDKImageMediaType | null {
  switch (mimeType) {
    case "image/jpeg":
    case "image/png":
    case "image/gif":
    case "image/webp":
      return mimeType;
    default:
      return null;
  }
}

export function toClaudeSdkImageBlock(block: Pick<InlineImageBlock, "data" | "mimeType">): ImageBlockParam | null {
  const mediaType = toClaudeSdkImageMediaType(block.mimeType);
  if (!mediaType) return null;

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: block.data,
    },
  };
}

export function toClaudeSdkUserContentBlock(block: HydratedPromptBlock): ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return toClaudeSdkImageBlock(block) ?? { type: "text", text: `[Unsupported image type: ${block.mimeType}]` };
    default:
      return assertNever(block);
  }
}

export function toClaudeSdkUserContent(content: HydratedPromptContent): ContentBlockParam[] {
  return content.map(toClaudeSdkUserContentBlock);
}
