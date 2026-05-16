/** Lowercase-alphanumeric character set used for agent-id and CLI client-id suffixes. */
const SUFFIX_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a `len`-character lowercase-alphanumeric suffix. */
export function randomSuffix(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += SUFFIX_CHARS[Math.floor(Math.random() * SUFFIX_CHARS.length)];
  }
  return s;
}
