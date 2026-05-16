/** Extract the first text-content block from an MCP tool-call result. */
export function firstText(res: { content?: unknown; [k: string]: unknown }): string {
  const blocks = res.content as { type: string; text: string }[] | undefined;
  return blocks?.[0]?.text ?? "";
}
