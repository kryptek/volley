import type { ExecOptions, ExecResult } from "../../src/exec";

/**
 * The wave-scale git/GitHub world of the soak (test/soak/): a real commit graph rather than
 * pipeline-harness.ts's per-argv answer tables, so every read the daemon makes of it — merge-bases,
 * ancestry, diffs, cherry-pick marks, squash checks — is consistent with every other.
 *
 * A commit is a snapshot (file → content id) and its parents. Branches live on origin (`refs`),
 * the release branch's tip moves on every merge, each worktree has a local HEAD. Agents (the
 * fleet, fake-agents.ts) commit and push through the API below; the daemon reads and merges
 * through `exec`, the argv surface of `git` and `gh` it uses. CI is computed per head on first
 * read: green, unless the seeded flake fails it.
 */

export const sha = (n: number) => n.toString(16).padStart(40, "0");

export interface Commit {
  sha: string;
  parents: string[];
  /** The tree: file → content id. */
  files: Record<string, string>;
  subject: string;
}

export interface Pr {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeCommit: string | null;
}

export interface Run {
  id: number;
  head: string;
  /** The failing test (null: green). */
  failing: string | null;
  event: "pull_request" | "push";
}

export interface Flake {
  /** The vitest test id the flake fails (`<file> > <suite> > <name>`). */
  test: string;
  file: string;
  /** Fraction of heads that do not touch `file` it fails on, while unfixed. */
  rate: number;
}

export interface SoakWorldOptions {
  /** The repository checkout (`git -C <repo>`). */
  repo: string;
  release_branch: string;
  seed: number;
  flake?: Flake;
  /** Heads the flake fails no matter the seed (while unfixed and not touched). */
  forceFlaky?: (head: string) => boolean;
}

/** What GitHub says when `--match-head-commit` no longer matches. */
export const HEAD_MOVED_STDERR =
  "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)";

/** A seeded uniform [0, 1) from a string (FNV-1a, then a xorshift). Deterministic. */
export function unit(seed: number, key: string): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  h ^= h << 13;
  h ^= h >>> 17;
  h ^= h << 5;
  return (h >>> 0) / 2 ** 32;
}

const out = (stdout: string, code = 0, stderr = ""): Partial<ExecResult> => ({
  code,
  stdout,
  stderr,
});

export type SoakWorld = ReturnType<typeof soakWorld>;

export function soakWorld(o: SoakWorldOptions) {
  const commits = new Map<string, Commit>();
  let n = 0x50a0000;
  const mk = (parents: string[], files: Record<string, string>, subject: string): string => {
    const s = sha(++n);
    commits.set(s, { sha: s, parents, files, subject });
    return s;
  };
  const root = mk(
    [],
    { "README.md": "r0", ...(o.flake ? { [o.flake.file]: "flaky" } : {}) },
    "root",
  );
  /** Branches on origin (the release branch among them). */
  const refs: Record<string, string> = { [o.release_branch]: root };
  /** HEAD per worktree path. */
  const local: Record<string, string> = {};
  const prs: Pr[] = [];
  const runs: Run[] = [];
  /** Runs per head, cached: CI is computed once per head. */
  const runsOf = new Map<string, Run[]>();
  /** Every argv no rule answered (the soak prints them on failure). */
  const unknown: string[][] = [];
  /** Every merge GitHub performed, in order: PR, head, merge commit. */
  const merges: { pr: number; head: string; sha: string }[] = [];
  /** The commit that removed the flake (null: still flaky). */
  let fixedBy: string | null = null;
  let runId = 7000;
  const issues: Record<number, { title: string; body: string }> = {};

  const get = (s: string): Commit => {
    const c = commits.get(s);
    if (c === undefined) throw new Error(`unknown commit ${s}`);
    return c;
  };
  const reach = (s: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [s];
    while (stack.length > 0) {
      const x = stack.pop() as string;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...get(x).parents);
    }
    return seen;
  };
  const isAncestor = (a: string, b: string) => reach(b).has(a);
  /** The best common ancestor: the one of the common set no other common commit descends from. */
  const mergeBase = (a: string, b: string): string | null => {
    const rb = reach(b);
    const common = [...reach(a)].filter((x) => rb.has(x));
    return (
      common.find((c) => !common.some((d) => d !== c && isAncestor(c, d))) ?? common[0] ?? null
    );
  };
  const tip = () => refs[o.release_branch] as string;

  /** Resolve a rev (`origin/<b>`, `refs/remotes/origin/<b>`, `refs/heads/<b>`, a sha, `x~1`, `x^{commit}`). */
  const resolve = (rev: string): string | null => {
    let r = rev.replace(/\^\{commit\}$/, "");
    let back = 0;
    const tilde = /~(\d*)$/.exec(r);
    if (tilde !== null) {
      back = tilde[1] === "" ? 1 : Number(tilde[1]);
      r = r.slice(0, tilde.index);
    }
    r = r.replace(/^refs\/remotes\/origin\//, "").replace(/^refs\/heads\//, "");
    r = r.replace(/^origin\//, "");
    let s = refs[r] ?? (commits.has(r) ? r : null);
    if (s === null && /^[0-9a-f]{7,39}$/.test(r))
      s = [...commits.keys()].find((k) => k.startsWith(r)) ?? null;
    for (let i = 0; i < back && s !== null; i++) s = get(s).parents[0] ?? null;
    return s;
  };

  const diffNames = (a: string, b: string): string[] => {
    const fa = get(a).files;
    const fb = get(b).files;
    return [...new Set([...Object.keys(fa), ...Object.keys(fb)])]
      .filter((f) => fa[f] !== fb[f])
      .sort();
  };
  const patch = (a: string, b: string): string =>
    diffNames(a, b)
      .map((f) => `diff --git a/${f} b/${f}\n+${get(b).files[f] ?? "(deleted)"}`)
      .join("\n");
  const ownPatch = (s: string) => {
    const p = get(s).parents[0];
    return p === undefined ? "" : patch(p, s);
  };
  /** Commits reachable from `b` but not `a`, newest first. */
  const range = (a: string | null, b: string): Commit[] => {
    const ra = a === null ? new Set<string>() : reach(a);
    const order: Commit[] = [];
    const seen = new Set<string>();
    const walk = (s: string) => {
      if (seen.has(s) || ra.has(s)) return;
      seen.add(s);
      order.push(get(s));
      for (const p of get(s).parents) walk(p);
    };
    walk(b);
    return order;
  };

  // --- the API the fleet and the scenario use -----------------------------------------------

  /** A commit on `parent` changing `files` (file → content id). */
  const commit = (parent: string, files: Record<string, string>, subject: string) =>
    mk([parent], { ...get(parent).files, ...files }, subject);

  /** A merge of `theirs` into `ours` (a `git merge`, no conflicts): theirs' changes since the base. */
  const merge = (ours: string, theirs: string, subject: string) => {
    const base = mergeBase(ours, theirs) as string;
    const files = { ...get(ours).files };
    for (const f of diffNames(base, theirs)) {
      const v = get(theirs).files[f];
      if (v === undefined) delete files[f];
      else files[f] = v;
    }
    return mk([ours, theirs], files, subject);
  };

  /** A rebase of `head` onto `onto`: one commit replaying head's changes since their base. */
  const rebase = (head: string, onto: string, subject: string) => {
    const base = mergeBase(head, onto) as string;
    const files = { ...get(onto).files };
    for (const f of diffNames(base, head)) {
      const v = get(head).files[f];
      if (v === undefined) delete files[f];
      else files[f] = v;
    }
    return mk([onto], files, subject);
  };

  const push = (branch: string, head: string) => {
    refs[branch] = head;
    for (const pr of prs)
      if (pr.headRefName === branch && pr.state === "OPEN") pr.headRefOid = head;
  };

  const openPr = (branch: string, title: string): Pr => {
    const existing = prs.find((p) => p.headRefName === branch && p.state === "OPEN");
    if (existing !== undefined) return existing;
    const number = 100 + prs.length;
    const pr: Pr = {
      number,
      url: `https://github.com/example/soak/pull/${number}`,
      title,
      headRefName: branch,
      baseRefName: o.release_branch,
      headRefOid: refs[branch] as string,
      state: "OPEN",
      mergeCommit: null,
    };
    prs.push(pr);
    return pr;
  };

  const flakeActive = (head: string) =>
    o.flake !== undefined && (fixedBy === null || !isAncestor(fixedBy, head));
  /** Does `head` change the flake's file relative to where it forked from the release branch? */
  const touchesFlake = (head: string) => {
    if (o.flake === undefined) return false;
    const base = mergeBase(head, tip()) ?? root;
    return get(base).files[o.flake.file] !== get(head).files[o.flake.file];
  };
  const flakyOn = (head: string, release: boolean) => {
    if (o.flake === undefined || !flakeActive(head)) return false;
    if (release) return true;
    if (touchesFlake(head)) return false;
    return o.forceFlaky?.(head) === true || unit(o.seed, head) < o.flake.rate;
  };

  const ciOf = (head: string, event: Run["event"]): Run[] => {
    const key = `${event}:${head}`;
    let rs = runsOf.get(key);
    if (rs === undefined) {
      const failing = flakyOn(head, event === "push") ? (o.flake as Flake).test : null;
      rs = [{ id: ++runId, head, failing, event }];
      runs.push(...rs);
      runsOf.set(key, rs);
    }
    return rs;
  };
  const runJson = (r: Run) => ({
    databaseId: r.id,
    name: "CI",
    workflowName: "CI",
    event: r.event,
    status: "completed",
    conclusion: r.failing === null ? "success" : "failure",
    headSha: r.head,
    url: `https://github.com/example/soak/actions/runs/${r.id}`,
  });

  /** A squash merge of PR `pr` at its head onto the release tip (what `gh pr merge --squash` does). */
  const squash = (pr: Pr): string => {
    const head = pr.headRefOid;
    const s = rebase(head, tip(), `${pr.title} (#${pr.number})`);
    refs[o.release_branch] = s;
    pr.state = "MERGED";
    pr.mergeCommit = s;
    merges.push({ pr: pr.number, head, sha: s });
    if (fixedBy === null && o.flake !== undefined && get(s).files[o.flake.file] === "fixed")
      fixedBy = s;
    return s;
  };

  /** A commit pushed straight to the release branch (e.g. a release stage's bump). */
  const pushRelease = (files: Record<string, string>, subject: string) => {
    const s = commit(tip(), files, subject);
    refs[o.release_branch] = s;
    return s;
  };

  // --- the argv surface -----------------------------------------------------------------------

  const git = (cwd: string, args: string[]): Partial<ExecResult> => {
    const [verb, ...rest] = args;
    const last = rest.at(-1) as string;
    switch (verb) {
      case "rev-parse": {
        if (rest[0] === "--show-toplevel") return out(`${cwd}\n`);
        if (rest[0] === "--git-common-dir" || rest[0] === "--git-dir")
          return out(`${o.repo}/.git\n`);
        if (rest[0] === "--is-inside-work-tree") return out("true\n");
        if (rest[0] === "--abbrev-ref") return out("HEAD\n");
        if (last === "HEAD") {
          const h = local[cwd];
          return h !== undefined ? out(`${h}\n`) : out("", 128, "fatal: no HEAD");
        }
        const s = resolve(last);
        return s !== null ? out(`${s}\n`) : out("", 1);
      }
      case "fetch":
        return out("");
      case "merge-base": {
        if (rest[0] === "--is-ancestor") {
          const a = resolve(rest[1] as string);
          const b = resolve(rest[2] as string);
          if (a === null || b === null) return out("", 128, "fatal: not a valid commit");
          return out("", isAncestor(a, b) ? 0 : 1);
        }
        const a = resolve(rest[0] as string);
        const b = resolve(rest[1] as string);
        const m = a !== null && b !== null ? mergeBase(a, b) : null;
        return m !== null ? out(`${m}\n`) : out("", 1);
      }
      case "diff": {
        const flags = rest.filter((x) => x.startsWith("-"));
        const revs = rest.filter((x) => !x.startsWith("-"));
        const a = resolve(revs[0] as string);
        const b = resolve(revs[1] as string);
        if (a === null || b === null) return out("", 128, "fatal: bad revision");
        if (flags.includes("--name-only")) return out(`${diffNames(a, b).join("\n")}\n`);
        if (flags.includes("--stat")) {
          const f = diffNames(a, b);
          return out(`${f.map((x) => ` ${x} | 2 +-`).join("\n")}\n ${f.length} files changed\n`);
        }
        return out(patch(a, b));
      }
      case "show": {
        if (rest[0] === "--format=") {
          const s = resolve(rest[1] as string);
          return s !== null ? out(ownPatch(s)) : out("", 128);
        }
        if (rest[0] === "--quiet") {
          // `git show --quiet <rev>:<file>`: does the file exist there?
          const [rev, file] = (rest[1] as string).split(":");
          const s = resolve(rev as string);
          return s !== null && get(s).files[file as string] !== undefined ? out("") : out("", 128);
        }
        return out("");
      }
      case "log": {
        if (rest.includes("--cherry-pick")) {
          const [l, r] = last.split("...");
          const a = resolve(l as string);
          const b = resolve(r as string);
          if (a === null || b === null) return out("", 128);
          const left = range(b, a);
          const right = range(a, b);
          const lp = new Set(left.map((c) => ownPatch(c.sha)));
          const rp = new Set(right.map((c) => ownPatch(c.sha)));
          return out(
            [
              ...left.filter((c) => !rp.has(ownPatch(c.sha))).map((c) => `<${c.sha}`),
              ...right.filter((c) => !lp.has(ownPatch(c.sha))).map((c) => `>${c.sha}`),
            ].join("\n"),
          );
        }
        if (rest.includes("--format=%P")) {
          const s = resolve(last);
          return s !== null ? out(`${get(s).parents.join(" ")}\n`) : out("", 128);
        }
        const [from, to] = last.includes("..") ? last.split("..") : [null, last];
        const a = from === null ? null : resolve(from as string);
        const b = resolve(to as string);
        if (b === null) return out("", 128);
        const cs = range(a, b);
        if (rest.includes("--format=%H %s"))
          return out(cs.map((c) => `${c.sha} ${c.subject}\n`).join(""));
        return out(cs.map((c) => `${c.sha.slice(0, 7)} ${c.subject}\n`).join(""));
      }
      default:
        return out("");
    }
  };

  const gh = (args: string[]): Partial<ExecResult> | null => {
    const [noun, verb, ...rest] = args;
    const flag = (f: string) => rest[rest.indexOf(f) + 1] as string;
    if (noun === "repo" && verb === "view")
      return out(
        JSON.stringify({
          nameWithOwner: "example/soak",
          url: "https://github.com/example/soak",
          visibility: "PUBLIC",
        }),
      );
    if (noun === "issue" && verb === "view") {
      const num = Number(rest[0]);
      const i = issues[num] ?? { title: `Soak task #${num}`, body: `## Goal\n\nTask ${num}.` };
      return out(
        JSON.stringify({
          number: num,
          title: i.title,
          url: `https://github.com/example/soak/issues/${num}`,
          body: i.body,
        }),
      );
    }
    if (noun === "pr" && verb === "list") {
      const branch = flag("--head");
      return out(
        JSON.stringify(
          prs
            .filter((p) => p.headRefName === branch && p.state === "OPEN")
            .map((p) => ({
              number: p.number,
              url: p.url,
              headRefName: p.headRefName,
              baseRefName: p.baseRefName,
              headRefOid: p.headRefOid,
            })),
        ),
      );
    }
    if (noun === "pr" && verb === "view") {
      const pr = prs.find((p) => p.number === Number(rest[0]));
      if (pr === undefined) return out("", 1, "GraphQL: Could not resolve to a PullRequest");
      if (flag("--json") === "files") {
        const base = mergeBase(pr.headRefOid, tip()) ?? root;
        return out(
          JSON.stringify({
            files: diffNames(base, pr.headRefOid).map((path) => ({
              path,
              additions: 1,
              deletions: 1,
            })),
          }),
        );
      }
      return out(
        JSON.stringify({
          number: pr.number,
          url: pr.url,
          title: pr.title,
          state: pr.state,
          headRefName: pr.headRefName,
          headRefOid: pr.headRefOid,
          baseRefName: pr.baseRefName,
          mergedAt: pr.state === "MERGED" ? "2026-10-20T23:00:00Z" : null,
          mergeCommit: pr.mergeCommit !== null ? { oid: pr.mergeCommit } : null,
        }),
      );
    }
    if (noun === "pr" && verb === "merge") {
      const pr = prs.find((p) => p.number === Number(rest[0]));
      if (pr === undefined || pr.state !== "OPEN")
        return out("", 1, "GraphQL: Pull request is not open (mergePullRequest)");
      if (rest.includes("--match-head-commit") && flag("--match-head-commit") !== pr.headRefOid)
        return out("", 1, HEAD_MOVED_STDERR);
      squash(pr);
      return out("");
    }
    if (noun === "run" && verb === "list") {
      if (rest.includes("--branch")) return out(JSON.stringify(ciOf(tip(), "push").map(runJson)));
      return out(JSON.stringify(ciOf(flag("--commit"), "pull_request").map(runJson)));
    }
    if (noun === "run" && verb === "view") {
      const run = runs.find((r) => r.id === Number(rest[0]));
      if (run === undefined) return out("", 1, "run not found");
      if (rest.includes("--log-failed"))
        return out(
          run.failing === null
            ? ""
            : `test\tRun tests\t2026-10-20T23:00:00.0000000Z  FAIL  ${run.failing}\n`,
        );
      return out(
        JSON.stringify({
          jobs: [
            {
              name: "test",
              conclusion: run.failing === null ? "success" : "failure",
              steps: [
                { name: "Run tests", conclusion: run.failing === null ? "success" : "failure" },
              ],
            },
          ],
        }),
      );
    }
    return null;
  };

  /** Answer one argv (the fake exec's catch-all rule). */
  const exec = (argv: string[], _opts: ExecOptions = {}): Partial<ExecResult> => {
    if (argv[0] === "git" && argv[1] === "-C") return git(argv[2] as string, argv.slice(3));
    if (argv[0] === "gh") {
      const r = gh(argv.slice(1));
      if (r !== null) return r;
    }
    unknown.push([...argv]);
    return out("");
  };

  return {
    root,
    refs,
    local,
    prs,
    runs,
    merges,
    unknown,
    issues,
    exec,
    tip,
    get,
    resolve,
    isAncestor,
    mergeBase,
    diffNames,
    commit,
    merge,
    rebase,
    push,
    openPr,
    pushRelease,
    flakeActive,
    /** The flake's fix landed on the release branch (the commit that did it). */
    fixedBy: () => fixedBy,
    /** CI on `head` as the PR checks would see it (computed once). */
    ci: (head: string) => ciOf(head, "pull_request"),
    /** The release branch's latest run. */
    releaseCi: () => ciOf(tip(), "push"),
    prFor: (branch: string) => prs.find((p) => p.headRefName === branch),
  };
}
