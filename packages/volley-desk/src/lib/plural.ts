/** The noun for a count: `agent` for 1, `agents` for anything else. */
export function noun(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** `1 agent`, `2 agents`, `0 gates`: a count with its noun in the right number. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${noun(n, one, many)}`;
}
