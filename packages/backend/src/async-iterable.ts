export type TextIterableChunk = string | ArrayBuffer | ArrayBufferView;

export async function asyncIterableToText(iterable: AsyncIterable<TextIterableChunk>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";

  for await (const chunk of iterable) {
    if (typeof chunk === "string") {
      text += decoder.decode();
      text += chunk;
      continue;
    }

    text += decoder.decode(chunk, { stream: true });
  }

  return text + decoder.decode();
}
