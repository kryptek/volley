import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BRIEF_TITLE_MAX, briefTitle } from "../scripts/brief-title";

const SCRIPT = fileURLToPath(new URL("../scripts/brief-title.ts", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "brief-title-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Run the helper the way SKILL.md does: the raw title on stdin, never on the command line. */
function run(args: string[], stdin: string): { code: number | null; out: string; err: string } {
  const r = spawnSync("bun", [SCRIPT, ...args], { input: stdin, encoding: "utf-8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const FORBIDDEN = /['"`$\\\n\r\t]/;

describe("briefTitle", () => {
  it("prefixes the issue number and appends the role", () => {
    expect(briefTitle("12", "O0: Cache prefetch", "implementer")).toBe(
      "#12 O0: Cache prefetch — implementer",
    );
    expect(briefTitle("12", "Cache prefetch")).toBe("#12 Cache prefetch");
  });

  it.each([
    ["single quotes", "can't parse 'hooks_auth_failed'", "#7 cant parse hooks_auth_failed"],
    ["double quotes", 'the "quoted" word', "#7 the quoted word"],
    ["backticks", "run `claude auth login` first", "#7 run claude auth login first"],
    ["command substitution", "oops $(touch /x/marker)", "#7 oops (touch /x/marker)"],
    ["parameter expansion", "path ${HOME} and $PATH", "#7 path {HOME} and PATH"],
    ["backslashes", "a\\b\\\\c", "#7 abc"],
    ["newlines and tabs", "line one\nline\ttwo\r\n", "#7 line one line two"],
    ["control characters", "bell\u0007here\u001b[31m", "#7 bell here [31m"],
    ["runs of whitespace", "   lots    of   space  ", "#7 lots of space"],
  ])("removes %s", (_name, raw, expected) => {
    const out = briefTitle("7", raw);
    expect(out).toBe(expected);
    expect(out).not.toMatch(FORBIDDEN);
  });

  it("cuts a long title to the limit, keeping the role", () => {
    const out = briefTitle("123", "x".repeat(300), "spec reviewer");
    expect(out.length).toBeLessThanOrEqual(BRIEF_TITLE_MAX);
    expect(out.startsWith("#123 xxx")).toBe(true);
    expect(out.endsWith(" — spec reviewer")).toBe(true);
    expect(BRIEF_TITLE_MAX).toBe(120);
  });

  it("does not split a character in two when cutting", () => {
    const out = briefTitle("1", "😀".repeat(200));
    expect(out.length).toBeLessThanOrEqual(BRIEF_TITLE_MAX);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("sanitises the role too", () => {
    expect(briefTitle("3", "t", "imp`id`ler$")).toBe("#3 t — impidler");
  });

  it("falls back to the number alone for an empty title", () => {
    expect(briefTitle("4", " '`$ ")).toBe("#4");
  });

  it.each(["", "12a", "-1", "1 2", "$(id)", "#12", "１２"])("refuses issue number %j", (n) => {
    expect(() => briefTitle(n, "t")).toThrow(/issue number/);
  });
});

describe("brief-title.ts (CLI)", () => {
  it("reads the raw title on stdin and prints one line", () => {
    const r = run(["42", "implementer"], "can't `break` $(this)\n");
    expect(r.code).toBe(0);
    expect(r.out).toBe("#42 cant break (this) — implementer\n");
  });

  it("is ≤ 120 characters for a 300-character title", () => {
    const r = run(["42"], `${"y".repeat(300)}\n`);
    expect(r.code).toBe(0);
    expect(r.out.trimEnd().length).toBeLessThanOrEqual(120);
  });

  it("refuses a non-numeric issue number with a non-zero exit and no output", () => {
    const r = run(["12;rm"], "t");
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("issue number");
  });

  it("refuses a missing issue number", () => {
    const r = run([], "t");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("usage");
  });

  it("survives SKILL.md's nested quoting end to end: nothing runs, the text is literal", () => {
    const marker = "pwned"; // relative: the shell below runs in the temp dir
    const raw = `can't "quote" \`touch ${marker}\` $(touch ${marker}) \${HOME} back\\slash\nnext line`;
    const r = run(["9", "implementer"], raw);
    expect(r.code).toBe(0);
    const title = r.out.trimEnd();
    expect(title).not.toMatch(FORBIDDEN);
    // The same shape as SKILL.md's cmux line: a double-quoted --command whose
    // value holds a single-quoted prompt, plus a double-quoted --name.
    const shell = `printf '%s|' "Issue-9: ${title}"; bash -c "printf '%s' 'prefix title=\\"${title}\\" suffix'"`;
    const sh = spawnSync("bash", ["-c", shell], { cwd: tmp, encoding: "utf-8" });
    expect(sh.status).toBe(0);
    expect(sh.stdout).toBe(`Issue-9: ${title}|prefix title="${title}" suffix`);
    expect(title).toBe(
      `#9 cant quote touch ${marker} (touch ${marker}) {HOME} backslash next line — implementer`,
    );
    expect(existsSync(join(tmp, marker))).toBe(false);
  });

  it("control: the same shell line with the RAW title does run the injected command", () => {
    const marker = "control-marker";
    const raw = `can't $(touch ${marker})`;
    const shell = `bash -c "printf '%s' 'prefix ${raw} suffix'"`;
    spawnSync("bash", ["-c", shell], { cwd: tmp, encoding: "utf-8" });
    expect(existsSync(join(tmp, marker))).toBe(true);
  });
});
