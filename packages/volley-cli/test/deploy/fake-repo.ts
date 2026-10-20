import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "../../src/setup/step";
import { tempDir } from "../helpers/tmp";

/** One command the fake ran, as the deploy asked for it. */
export interface Ran {
  argv: string[];
  cwd?: string;
}

/**
 * A services checkout on disk plus an exec that plays git, bun and the service manager on it:
 * `checkout` moves HEAD (and so the version the next build and `--version` report), the Desk build
 * writes dist/index.html and dist/version.json. `fail` makes one command (matched by its argv
 * joined with spaces, optionally only at one version) exit 1.
 */
export function fakeRepo(opts: {
  head: { tag?: string; branch?: string; sha?: string };
  tags?: string[];
  dirty?: string;
  bun?: string;
  /** Builds write no version.json at these versions (a release before it existed). */
  noVersionJson?: string[];
}) {
  const repo = tempDir("volley-deploy-repo-");
  const bun = opts.bun ?? "/opt/bun";
  const dist = join(repo, "packages", "volley-desk", "dist");
  mkdirSync(join(repo, "packages", "volley-desk", "src"), { recursive: true });
  writeFileSync(join(repo, "packages", "volley-desk", "src", "main.ts"), "export {};");
  writeFileSync(join(repo, "bun.lock"), "{}");
  const state = {
    head: { ...opts.head },
    dirty: opts.dirty ?? "",
    stashes: [] as string[],
  };
  const versionAt = () =>
    (state.head.tag ?? (state.head.branch !== undefined ? "v0.4.1" : "v0.3.0")).replace(/^v/, "");
  const writePkg = () =>
    writeFileSync(join(repo, "package.json"), JSON.stringify({ version: versionAt() }));
  writePkg();
  const ran: Ran[] = [];
  const failures: { line: string; atVersion?: string; stderr?: string }[] = [];
  const res = (code: number, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr });
  const exec = async (
    argv: readonly string[],
    o?: { cwd?: string; env?: Record<string, string | undefined> },
  ): Promise<ExecResult> => {
    ran.push({ argv: [...argv], ...(o?.cwd !== undefined ? { cwd: o.cwd } : {}) });
    const line = argv.join(" ");
    const f = failures.find(
      (x) => line === x.line && (x.atVersion === undefined || x.atVersion === versionAt()),
    );
    if (f !== undefined) return res(1, "", f.stderr ?? `${argv[0]} failed`);
    if (argv[0] === "git") {
      const g = argv.slice(3);
      const sub = g.join(" ");
      if (sub === "status --porcelain") return res(0, state.dirty);
      if (sub === "describe --tags --exact-match HEAD") {
        return state.head.tag !== undefined
          ? res(0, `${state.head.tag}\n`)
          : res(128, "", "fatal: no tag exactly matches");
      }
      if (sub === "rev-parse --abbrev-ref HEAD") return res(0, `${state.head.branch ?? "HEAD"}\n`);
      if (sub === "rev-parse HEAD") return res(0, `${state.head.sha ?? "f".repeat(40)}\n`);
      if (sub === "tag --list v*") return res(0, `${(opts.tags ?? []).join("\n")}\n`);
      if (sub === "fetch --tags origin") return res(0);
      if (g[0] === "stash") {
        state.stashes.push(g[4] as string);
        state.dirty = "";
        return res(0, `Saved working directory and index state On x: ${g[4]}\n`);
      }
      if (g[0] === "checkout") {
        const ref = g[g.length - 1] as string;
        state.head =
          g[1] === "--detach"
            ? /^[0-9a-f]{40}$/.test(ref)
              ? { sha: ref }
              : { tag: ref }
            : { branch: ref };
        writePkg();
        return res(0);
      }
    }
    if (argv[0] === bun && argv[1] === "run" && argv[2] === "build") {
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "index.html"), "<!doctype html>");
      if (!(opts.noVersionJson ?? []).includes(versionAt())) {
        writeFileSync(join(dist, "version.json"), JSON.stringify({ version: versionAt() }));
      }
      return res(0);
    }
    if (argv[0] === bun && argv[2] === "--version") return res(0, `${versionAt()}\n`);
    return res(0);
  };
  return {
    repo,
    bun,
    dist,
    state,
    ran,
    exec,
    versionAt,
    fail: (line: string, atVersion?: string, stderr?: string) =>
      failures.push({
        line,
        ...(atVersion !== undefined ? { atVersion } : {}),
        ...(stderr !== undefined ? { stderr } : {}),
      }),
    lines: () => ran.map((r) => r.argv.join(" ")),
  };
}
