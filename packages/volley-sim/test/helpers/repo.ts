import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_IDENTITY } from "../../src/world";

/** Run git (the real one) and return its trimmed stdout; throws on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_IDENTITY },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}): ${r.stderr}`);
  return r.stdout.trim();
}

export interface SimRepo {
  /** The bare origin (`<dir>/origin.git`). */
  origin: string;
  /** A clone of it with `main` checked out (`<dir>/work`). */
  work: string;
}

/** A bare origin holding one commit on `main`, and a clone of it. */
export function makeRepo(dir: string): SimRepo {
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(dir, "init", "--bare", "-b", "main", origin);
  git(seed, "init", "-b", "main");
  writeFileSync(join(seed, "README.md"), "# sim\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "root");
  git(seed, "push", origin, "main");
  const work = join(dir, "work");
  git(dir, "clone", origin, work);
  return { origin, work };
}

/** A new branch `branch` in `work` with one commit adding `file`, pushed to origin. */
export function pushBranch(work: string, branch: string, file: string): string {
  git(work, "checkout", "-B", branch, "origin/main");
  writeFileSync(join(work, file), `${branch}\n`);
  git(work, "add", file);
  git(work, "commit", "-m", `feat: ${branch}`);
  git(work, "push", "-u", "origin", `HEAD:${branch}`);
  return git(work, "rev-parse", "HEAD");
}
