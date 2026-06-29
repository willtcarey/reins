export function dedent(strings: TemplateStringsArray, ...values: unknown[]): string {
  let text = "";
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) text += String(values[i]);
  }

  const lines = text.replace(/^\n/, "").split("\n");
  if (lines.at(-1)?.trim() === "") lines.pop();

  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;

  return `${lines.map((line) => line.slice(indent)).join("\n")}\n`;
}
