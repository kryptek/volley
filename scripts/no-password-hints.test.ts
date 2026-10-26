import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Grep-guard (#613): no runtime message tells anyone to put a broker password in the
 * environment. A hint or refusal that names `VOLLEY_AUTH_PASSWORD` teaches the pattern that leaked
 * credentials (an `export` line, a password pasted inline); messages point at `volley auth
 * status` instead. The literal may appear in `src/` only where the env is read (`authFromEnv`,
 * the login ladder's flag step), in a `--help` text, in a comment, or in the allowlist below.
 */

const ROOT = join(import.meta.dir, "..");
const PACKAGES = join(ROOT, "packages");
const LITERAL = "VOLLEY_AUTH_PASSWORD";

/** Files (repo-relative) where the env is read: every line may name it. */
const READERS = new Set([
  "packages/volley-cli/src/auth/login.ts", // resolveLogin's flag and env steps
  "packages/volley-cli/src/args.ts", // resolveAuth, the ladder's front door
]);

/** One function of a file where the env is read: lines between its start and the next `export`. */
const READER_FUNCTIONS: Record<string, string> = {
  "packages/volley-mcp/src/config.ts": "export function authFromEnv(",
};

/** Lines that name it for another reason than a message: `path: reason`. */
const ALLOWED: Record<string, string> = {
  // Setup hands the admin login it already holds to the one child command it runs.
  "packages/volley-cli/src/setup/first-wave.ts": "an env handed to a child process, not a message",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.name === "node_modules"
      ? []
      : d.isDirectory()
        ? files(join(dir, d.name))
        : /\.tsx?$/.test(d.name)
          ? [join(dir, d.name)]
          : [],
  );
}

const sources = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => {
    try {
      return files(join(PACKAGES, d.name, "src"));
    } catch {
      return [];
    }
  });

/** The offending lines of `text` (a file at repo-relative `rel`): `rel:line: text`. */
function offenders(rel: string, text: string): string[] {
  if (READERS.has(rel) || ALLOWED[rel] !== undefined) return [];
  const out: string[] = [];
  const lines = text.split("\n");
  /** Inside a `const …HELP… = \`` / `…USAGE…` template literal. */
  let inHelp = false;
  let inReader = false;
  for (const [i, line] of lines.entries()) {
    const start = /^(export )?const \w*(HELP|USAGE)\w* = `/.test(line);
    if (start) inHelp = true;
    const fn = READER_FUNCTIONS[rel];
    if (fn !== undefined && line.startsWith("export ")) inReader = line.startsWith(fn);
    const comment = /^\s*(\/\/|\*|\/\*)/.test(line);
    if (line.includes(LITERAL) && !inHelp && !inReader && !comment) {
      out.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
    // A help template ends at the line with its closing (unescaped) backtick.
    let rest = start ? line.slice(line.indexOf("`") + 1) : line;
    // `${…}` interpolations (a nested template among them) are not the template's end.
    for (let prev = ""; prev !== rest; ) {
      prev = rest;
      rest = rest.replace(/\$\{[^{}]*\}/g, "");
    }
    if (inHelp && /(^|[^\\])`/.test(rest)) inHelp = false;
  }
  return out;
}

describe("no runtime message names VOLLEY_AUTH_PASSWORD", () => {
  test("every source line naming it is a reader, a help text, a comment or allowlisted", () => {
    const found = sources.flatMap((f) => offenders(relative(ROOT, f), readFileSync(f, "utf8")));
    expect(found).toEqual([]);
  });

  test("the hints that used to name it now point at `volley auth status`", () => {
    const broker = readFileSync(join(PACKAGES, "volley-mcp/src/broker.ts"), "utf8");
    const hint = broker.slice(broker.indexOf("export const AUTH_HINT"));
    expect(hint.slice(0, hint.indexOf(";"))).toContain("volley auth status");
    const peer = readFileSync(join(PACKAGES, "volley-cli/src/commands/peer.ts"), "utf8");
    const refusal = peer.slice(peer.indexOf("export function adminRefusal("));
    expect(refusal.slice(0, refusal.indexOf("\n}\n"))).not.toContain(LITERAL);
  });

  test("the guard catches a message, and passes help, comments and the readers", () => {
    const rel = "packages/x/src/y.ts";
    expect(offenders(rel, 'io.stderr("set VOLLEY_AUTH_PASSWORD");')).toHaveLength(1);
    expect(offenders(rel, "const HELP = `\n  --password (env: VOLLEY_AUTH_PASSWORD)\n`;")).toEqual(
      [],
    );
    expect(offenders(rel, "// reads VOLLEY_AUTH_PASSWORD")).toEqual([]);
    // An escaped backtick inside the help does not end it; the closing one does.
    const help =
      'const HELP = `\n  run \\`volley auth\\`\n  VOLLEY_AUTH_PASSWORD\n`;\nf("VOLLEY_AUTH_PASSWORD");';
    expect(offenders(rel, help)).toEqual([`${rel}:5: f("VOLLEY_AUTH_PASSWORD");`]);
    expect(
      offenders(
        "packages/volley-mcp/src/config.ts",
        'export function authFromEnv() {\n  throw new Error("VOLLEY_AUTH_PASSWORD is set");\n}\nexport function x() {\n  "VOLLEY_AUTH_PASSWORD";\n}',
      ),
    ).toEqual(['packages/volley-mcp/src/config.ts:5: "VOLLEY_AUTH_PASSWORD";']);
  });
});
