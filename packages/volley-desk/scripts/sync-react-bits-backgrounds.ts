/**
 * Keeps the background picker complete: diffs the "Backgrounds" section of
 * React Bits' https://reactbits.dev/llms.txt (each entry ends `CLI: \`<Name>\``)
 * against the Desk's registry (`src/look/backgrounds.ts`). Exits 1 when React
 * Bits lists a background the Desk lacks, so CI can warn (the job is
 * optional); a registry entry React Bits no longer lists is reported but
 * doesn't fail. To add one: install it into `src/rb/` (README "React Bits"),
 * add it to the allow-list and to `BACKGROUNDS`.
 *
 * Usage: bun run scripts/sync-react-bits-backgrounds.ts [llms.txt path or URL]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REACT_BITS_BACKGROUNDS } from "../src/look/backgrounds";

export const LLMS_URL = "https://reactbits.dev/llms.txt";

/** The CLI names in the `## Backgrounds` section, in order. */
export function parseBackgrounds(llms: string): string[] {
  const section = llms.split(/^## /m).find((s) => s.startsWith("Backgrounds\n"));
  if (!section) throw new Error('llms.txt has no "## Backgrounds" section');
  return [...section.matchAll(/CLI: `([A-Za-z0-9]+)`/g)].map((m) => m[1] as string);
}

export interface BackgroundDiff {
  /** Listed by React Bits, missing from the Desk. */
  missing: string[];
  /** In the Desk, no longer listed by React Bits. */
  extra: string[];
}

export function diffBackgrounds(
  upstream: readonly string[],
  ours: readonly string[],
): BackgroundDiff {
  const up = new Set(upstream);
  const have = new Set(ours);
  return {
    missing: upstream.filter((n) => !have.has(n)),
    extra: ours.filter((n) => !up.has(n)),
  };
}

async function readLlms(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`GET ${source}: HTTP ${res.status}`);
    return res.text();
  }
  return readFileSync(source, "utf8");
}

export async function main(
  argv: string[],
  log: (line: string) => void = console.error,
): Promise<number> {
  const source = argv[0] ?? LLMS_URL;
  const upstream = parseBackgrounds(await readLlms(source));
  const { missing, extra } = diffBackgrounds(
    upstream,
    REACT_BITS_BACKGROUNDS.map((b) => b.key),
  );
  for (const name of extra) {
    log(`sync-react-bits-backgrounds: "${name}" is no longer listed by React Bits`);
  }
  if (missing.length === 0) {
    log(`sync-react-bits-backgrounds: ok (${upstream.length} backgrounds, ${source})`);
    return 0;
  }
  for (const name of missing) {
    log(`sync-react-bits-backgrounds: warning: React Bits added "${name}"; the picker lacks it`);
  }
  return 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`sync-react-bits-backgrounds: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    },
  );
}
