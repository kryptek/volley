import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Grep-guard: the repository is public, so no tracked file carries a home-directory path
 * (`/home/<user>/…`, `/Users/<user>/…`), not even an invented one. Docs and examples write
 * `/path/to/<thing>` (`/path/to/repo`, `/path/to/volley`, `/path/to/worktrees`); a test that
 * needs a HOME passes a placeholder such as `/path/to/home` (the code under test takes HOME as a
 * value and never inspects its shape).
 */

const ROOT = join(import.meta.dir, "..");

const RULE =
  "The repository is public: no home-directory paths in tracked files. " +
  "Write /path/to/<thing> (e.g. /path/to/repo, /path/to/home) instead.";

// A word character before `/home` means a deeper path (`/smoke/home/x`), not a home directory;
// the optional backslashes catch a path inside a regex literal.
const HOME_PATH = /(?<!\w)\\?\/(?:Users|home)\\?\/[A-Za-z][A-Za-z0-9_-]*/g;

/** Real system paths, not anyone's home. */
const SYSTEM_PATHS = new Set(["/home/linuxbrew"]);

/** This guard spells home paths in its own self-test. */
const SELF = "scripts/no-home-paths.test.ts";

/** Home-shaped paths a file keeps on purpose; anything else in that file still fails. */
const ALLOWED: Record<string, Set<string>> = {
  // tests that paths under HOME are redacted to ~/ (and that a sibling home is not)
  "packages/volley-hooks/test/work-log.test.ts": new Set(["/home/someone", "/home/someone2"]),
};

function tracked(): string[] {
  const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (ls.exitCode !== 0) throw new Error(`git ls-files failed: ${ls.stderr.toString()}`);
  return ls.stdout.toString().split("\0").filter(Boolean);
}

/** Every `file:line: match` of a home-shaped path in `text`. */
function homePaths(file: string, text: string): string[] {
  return text.split("\n").flatMap((line, i) =>
    [...line.matchAll(HOME_PATH)]
      .map((m) => m[0].replaceAll("\\", ""))
      .filter((p) => !SYSTEM_PATHS.has(p) && !ALLOWED[file]?.has(p))
      .map((p) => `${file}:${i + 1}: ${p}`),
  );
}

describe("home-directory paths in tracked files", () => {
  test("the pattern catches home paths and spares the rest", () => {
    const hits = (s: string) => homePaths("f", s).map((h) => h.split(": ")[1]);
    expect(hits("repo: /home/dev/src/x")).toEqual(["/home/dev"]);
    expect(hits('const HOME = "/Users/someone";')).toEqual(["/Users/someone"]);
    expect(hits("/wt/x/.volley/../../../home/dev/.ssh")).toEqual(["/home/dev"]);
    expect(hits(String.raw`/fix: \/home\/dev\/\.local/`)).toEqual(["/home/dev"]);
    expect(hits("/home/linuxbrew/.linuxbrew/bin")).toEqual([]);
    expect(hits("/smoke/home/worktrees /path/to/home /home/<user>")).toEqual([]);
  });

  test("an allowed file keeps only its listed paths", () => {
    const file = "packages/volley-hooks/test/work-log.test.ts";
    expect(homePaths(file, "/home/someone/.ssh /home/someone2/x")).toEqual([]);
    expect(homePaths(file, "/home/dev/x")).toEqual([`${file}:1: /home/dev`]);
  });

  test("no tracked file names a home directory", () => {
    const offenders = tracked()
      .filter((f) => f !== SELF)
      .flatMap((f) => {
        let text: string;
        try {
          text = readFileSync(join(ROOT, f), "utf8");
        } catch {
          return []; // deleted in the working tree
        }
        return homePaths(f, text);
      });
    expect(offenders, RULE).toEqual([]);
  });
});
