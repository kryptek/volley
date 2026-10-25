import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Env, isSimulated, passThrough, simHome } from "./env";
import {
  type Issue,
  type Pr,
  type Repo,
  SIM_LOGIN,
  WEB,
  type World,
  appendUnknown,
  bare,
  branchTip,
  changedFiles,
  ciOf,
  deleteBranch,
  git,
  isAncestor,
  mergeOnOrigin,
  nextNumber,
  originsDir,
  refreshPr,
  repoOfCwd,
  slugOfFlag,
  updateBranch,
  withWorld,
} from "./world";

/**
 * The fake GitHub CLI. Every argv shape volleyd's fence allows (`packages/volleyd/src/fence.ts`,
 * its header) and the ones `volley setup` and the install steps use is answered from the world
 * file (world.ts) with the stdout and exit code volleyd's soak world gives (soak-world.ts); git
 * itself is real, so heads come from the bare origin and a merge writes to it. Any other shape —
 * an unknown verb, flag, `--json` field or `--jq` program — exits 1 with `unknown argv` on stderr
 * and is appended to `$VOLLEY_SIM_HOME/unknown.jsonl`.
 */

export interface Ctx {
  cwd: string;
  env: Env;
}

export interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

/** What GitHub says when `--match-head-commit` no longer matches (soak-world.ts's). */
export const HEAD_MOVED_STDERR =
  "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)";

const NOT_LOGGED_IN = "You are not logged into any GitHub hosts. To log in, run: gh auth login\n";

const ok = (stdout = "", stderr = ""): Out => ({ code: 0, stdout, stderr });
const fail = (stderr: string): Out => ({
  code: 1,
  stdout: "",
  stderr: stderr.endsWith("\n") ? stderr : `${stderr}\n`,
});

/** Thrown for a shape no rule answers: becomes `unknown argv`. */
class Unknown extends Error {}

/** An issue number argument: a positive integer, else not a shape the fake answers. */
function issueNumber(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Unknown();
  return n;
}

// --- argv parsing -------------------------------------------------------------------------------

interface Args {
  pos: string[];
  /** Value flags (a repeated flag keeps every value). */
  values: Record<string, string[]>;
  bools: Set<string>;
}

interface Spec {
  values?: string[];
  bools?: string[];
  /** Positional count: [min, max]. */
  pos?: [number, number];
  run: (a: Args, c: Call) => Out;
}

const SHORT: Record<string, string> = {
  "-R": "--repo",
  "-t": "--title",
  "-b": "--body",
  "-B": "--base",
  "-H": "--head",
  "-L": "--limit",
  "-q": "--jq",
  "-y": "--yes",
  "-X": "--method",
};

function parse(rest: string[], spec: Spec): Args {
  const values = new Set(spec.values ?? []);
  const bools = new Set(spec.bools ?? []);
  const a: Args = { pos: [], values: {}, bools: new Set() };
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i] as string;
    if (!raw.startsWith("-") || raw === "-") {
      a.pos.push(raw);
      continue;
    }
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const name = SHORT[eq < 0 ? raw : raw.slice(0, eq)] ?? (eq < 0 ? raw : raw.slice(0, eq));
    if (bools.has(name) && eq < 0) a.bools.add(name);
    else if (values.has(name)) {
      const v = eq >= 0 ? raw.slice(eq + 1) : rest[++i];
      if (v === undefined) throw new Unknown();
      a.values[name] = [...(a.values[name] ?? []), v];
    } else throw new Unknown();
  }
  const [min, max] = spec.pos ?? [0, 0];
  if (a.pos.length < min || a.pos.length > max) throw new Unknown();
  return a;
}

const one = (a: Args, f: string) => a.values[f]?.at(-1);
const many = (a: Args, f: string) => a.values[f] ?? [];

// --- output: --json fields and --jq -----------------------------------------------------------

type Json = Record<string, unknown>;

/** `--json a,b`: just those fields (an unknown one is an unknown shape, as gh refuses it). */
function pick(o: Json, fields: string[]): Json {
  return Object.fromEntries(
    fields.map((f) => {
      if (!(f in o)) throw new Unknown();
      return [f, o[f]];
    }),
  );
}

/**
 * The `--jq` programs Volley runs: a path (`.login`, `.body`) — a string printed raw, as gh does —
 * and `[.<list>[] | {a, b}]`. Anything else is an unknown shape.
 */
function jq(value: unknown, program: string): string {
  if (/^\.[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(program)) {
    let v: unknown = value;
    for (const k of program.slice(1).split(".")) v = (v as Json | null)?.[k] ?? null;
    return typeof v === "string" ? `${v}\n` : `${JSON.stringify(v)}\n`;
  }
  const m = /^\[\.(\w+)\[\] \| \{([\w, ]+)\}\]$/.exec(program);
  if (m !== null) {
    const list = (value as Json)[m[1] as string];
    if (!Array.isArray(list)) throw new Unknown();
    const fields = (m[2] as string).split(",").map((f) => f.trim());
    return `${JSON.stringify(list.map((x) => Object.fromEntries(fields.map((f) => [f, (x as Json)[f] ?? null]))))}\n`;
  }
  throw new Unknown();
}

/**
 * The answer to a `--json` / `--jq` read of `value` (an object or a list of them): the fields
 * asked for, then the jq program. `full` builds the value with every field, `text` the human form.
 */
function render(a: Args, full: () => Json | Json[], text: () => string): Out {
  const fields = one(a, "--json");
  const program = one(a, "--jq");
  if (fields === undefined) {
    if (program !== undefined) throw new Unknown();
    return ok(text());
  }
  const names = fields.split(",").map((f) => f.trim());
  const v = full();
  const shaped = Array.isArray(v) ? v.map((x) => pick(x, names)) : pick(v, names);
  return ok(program !== undefined ? jq(shaped, program) : `${JSON.stringify(shaped)}\n`);
}

// --- the world's GitHub objects as gh prints them ---------------------------------------------

const repoUrl = (slug: string) => `${WEB}/${slug}`;

interface Call {
  w: World;
  ctx: Ctx;
  home: string;
  /** The repository the call acts on (`--repo`, else the checkout's origin). */
  repo: (a: Args) => Repo;
}

function repoJson(r: Repo): Json {
  const [owner, name] = r.slug.split("/") as [string, string];
  return {
    name,
    nameWithOwner: r.slug,
    owner: { login: owner },
    url: repoUrl(r.slug),
    visibility: r.visibility,
    isPrivate: r.visibility !== "PUBLIC",
    defaultBranchRef: { name: r.defaultBranch },
    sshUrl: `git@github.com:${r.slug}.git`,
  };
}

function prJson(c: Call, pr: Pr): Json {
  refreshPr(c.w, pr);
  const origin = c.w.repos[pr.repo]?.origin ?? null;
  const base = origin !== null ? branchTip(origin, pr.baseRefName) : null;
  const clean = () =>
    origin === null ||
    base === null ||
    bare(origin, ["merge-tree", "--write-tree", base, pr.headRefOid]).code === 0;
  const out: Json = {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    author: { login: SIM_LOGIN },
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    mergeCommit: pr.mergeCommit !== null ? { oid: pr.mergeCommit } : null,
  };
  // Computed only when read: each costs a git call.
  Object.defineProperties(out, {
    files: {
      enumerable: true,
      get: () =>
        (origin !== null && base !== null ? changedFiles(origin, base, pr.headRefOid) : []).map(
          (path) => ({ path, additions: 1, deletions: 1 }),
        ),
    },
    mergeable: {
      enumerable: true,
      get: () => (pr.state !== "OPEN" ? "UNKNOWN" : clean() ? "MERGEABLE" : "CONFLICTING"),
    },
    mergeStateStatus: {
      enumerable: true,
      get: () => (pr.state !== "OPEN" ? "UNKNOWN" : clean() ? "CLEAN" : "DIRTY"),
    },
  });
  return out;
}

const issueUrl = (i: Issue) => `${repoUrl(i.repo)}/issues/${i.number}`;
const issueJson = (i: Issue): Json => ({
  number: i.number,
  title: i.title,
  body: i.body,
  url: issueUrl(i),
  state: i.state,
  labels: i.labels.map((name) => ({ name })),
  comments: i.comments.map((body) => ({ body })),
});

/** The world's issue `n`, or (as the soak world answers) one it has no record of. */
function issueOf(c: Call, repo: string, n: number, keep: boolean): Issue {
  const found = c.w.issues.find((i) => i.repo === repo && i.number === n);
  if (found !== undefined) return found;
  const i: Issue = {
    number: n,
    repo,
    title: `Soak task #${n}`,
    body: `## Goal\n\nTask ${n}.`,
    state: "OPEN",
    labels: [],
    comments: [],
  };
  if (keep) c.w.issues.push(i);
  return i;
}

const runUrl = (repo: string, id: number) => `${repoUrl(repo)}/actions/runs/${id}`;

type RunRec = World["runs"][number];
const runJson = (r: RunRec): Json => ({
  databaseId: r.id,
  name: "CI",
  workflowName: "CI",
  workflowDatabaseId: 1,
  status: "completed",
  conclusion: r.conclusion,
  url: runUrl(r.repo, r.id),
  headSha: r.head,
  headBranch: r.branch,
  event: r.event,
  createdAt: r.createdAt,
});
const apiRunJson = (r: RunRec): Json => ({
  id: r.id,
  name: "CI",
  status: "completed",
  conclusion: r.conclusion,
  html_url: runUrl(r.repo, r.id),
  head_sha: r.head,
  head_branch: r.branch,
  event: r.event,
  run_attempt: 1,
  workflow_id: 1,
  created_at: r.createdAt,
});

const currentBranch = (cwd: string) => {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return r.code === 0 ? r.stdout.trim() : "";
};

/** A PR by number, URL or branch (none: the checkout's branch), open ones first. */
function prOf(c: Call, a: Args, ref: string | undefined): Pr | Out {
  const repo = c.repo(a).slug;
  const r = ref ?? currentBranch(c.ctx.cwd);
  const n = /^\d+$/.test(r) ? Number(r) : Number(/\/pull\/(\d+)$/.exec(r)?.[1] ?? Number.NaN);
  const prs = c.w.prs.filter((p) => p.repo === repo);
  const pr = Number.isNaN(n)
    ? prs
        .filter((p) => p.headRefName === r)
        .sort((x, y) => (x.state === "OPEN" ? -1 : y.state === "OPEN" ? 1 : y.number - x.number))[0]
    : prs.find((p) => p.number === n);
  if (pr !== undefined) return pr;
  return Number.isNaN(n)
    ? fail(`no pull requests found for branch "${r}"`)
    : fail(
        `GraphQL: Could not resolve to a PullRequest with the number of ${n}. (repository.pullRequest)`,
      );
}

const isOut = (x: unknown): x is Out => typeof x === "object" && x !== null && "code" in x;

// --- the commands -------------------------------------------------------------------------------

const JSONQ = ["--json", "--jq"];
const REPO = ["--repo"];

const COMMANDS: Record<string, Spec> = {
  "auth status": {
    values: ["--hostname"],
    run: (_a, c) =>
      c.w.gh.signedIn
        ? ok(
            `github.com\n  ✓ Logged in to github.com account ${SIM_LOGIN} (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n`,
          )
        : { code: 1, stdout: "", stderr: NOT_LOGGED_IN },
  },
  "auth login": {
    values: ["--git-protocol", "--hostname"],
    bools: ["--web"],
    run: (_a, c) => {
      c.w.gh.signedIn = true;
      return ok(
        "",
        `! First copy your one-time code: SIM0-0000\n✓ Authentication complete.\n- gh config set -h github.com git_protocol https\n✓ Configured git protocol\n✓ Logged in as ${SIM_LOGIN}\n`,
      );
    },
  },
  "auth setup-git": {
    values: ["--hostname"],
    run: (_a, c) => {
      if (!c.w.gh.signedIn) return { code: 1, stdout: "", stderr: NOT_LOGGED_IN };
      c.w.gh.setupGit = true;
      return ok();
    },
  },

  api: {
    values: ["--jq", "--method"],
    bools: ["--paginate", "--slurp"],
    pos: [1, 1],
    run: (a, c) => {
      const method = one(a, "--method");
      if (method !== undefined && method.toUpperCase() !== "GET") throw new Unknown();
      let endpoint = (a.pos[0] as string).replace(/^\//, "");
      if (endpoint.includes("{owner}") || endpoint.includes("{repo}")) {
        const [owner, name] = c.repo(a).slug.split("/") as [string, string];
        endpoint = endpoint.replaceAll("{owner}", owner).replaceAll("{repo}", name);
      }
      const reply = (v: unknown) => {
        const program = one(a, "--jq");
        return ok(program !== undefined ? jq(v, program) : `${JSON.stringify(v)}\n`);
      };
      if (endpoint === "user")
        return reply({ login: SIM_LOGIN, id: 1, name: "Volley Sim", type: "User" });
      const runs = /^repos\/([^/]+\/[^/]+)\/actions\/runs\?(.*)$/.exec(endpoint);
      const head = runs !== null ? new URLSearchParams(runs[2]).get("head_sha") : null;
      if (runs !== null && head !== null) {
        const list = ciOf(c.w, runs[1] as string, head, "pull_request", "").map(apiRunJson);
        return reply({ total_count: list.length, workflow_runs: list });
      }
      // The CI queue (pressure/ci-queue.ts): a simulated run is done when it is first read.
      if (runs !== null && new URLSearchParams(runs[2]).get("status") === "queued")
        return reply({ total_count: 0, workflow_runs: [] });
      // The CI mode volleyd reads at admission (#602): one active workflow, no branch protection
      // and no rulesets, so a simulated wave stays on `workflows`.
      if (/^repos\/[^/]+\/[^/]+\/actions\/workflows(\?.*)?$/.test(endpoint))
        return reply({
          total_count: 1,
          workflows: [{ id: 1, name: "ci", path: ".github/workflows/ci.yml", state: "active" }],
        });
      const branch = /^repos\/[^/]+\/[^/]+\/branches\/(.+)$/.exec(endpoint);
      if (branch !== null) return reply({ name: branch[1], protected: false });
      if (/^repos\/[^/]+\/[^/]+\/rules\/branches\/.+$/.test(endpoint)) return reply([]);
      const slurp = a.bools.has("--slurp");
      if (slurp && !a.bools.has("--paginate")) throw new Unknown();
      // The release train's tag check: refs from the bare origin; --slurp is an array of pages.
      const refs = /^repos\/([^/]+\/[^/]+)\/git\/matching-refs\/tags\/(.*)$/.exec(endpoint);
      if (refs !== null) {
        const origin = c.w.repos[refs[1] as string]?.origin ?? null;
        const out =
          origin === null
            ? ""
            : bare(origin, [
                "for-each-ref",
                "--format=%(refname) %(objectname) %(objecttype)",
                `refs/tags/${refs[2]}`,
                `refs/tags/${refs[2]}*`,
              ]).stdout;
        const list = [...new Set(out.split("\n").filter((l) => l !== ""))].map((l) => {
          const [ref, sha, type] = l.split(" ");
          return { ref, object: { sha, type } };
        });
        return reply(slurp ? [list] : list);
      }
      const tag = /^repos\/([^/]+\/[^/]+)\/git\/tags\/([0-9a-f]{40})$/.exec(endpoint);
      if (tag !== null && !slurp) {
        const origin = c.w.repos[tag[1] as string]?.origin ?? null;
        const raw = origin !== null ? bare(origin, ["cat-file", "tag", tag[2] as string]) : null;
        if (raw === null || raw.code !== 0) return fail("gh: Not Found (HTTP 404)");
        const field = (k: string) => new RegExp(`^${k} (.*)$`, "m").exec(raw.stdout)?.[1];
        return reply({
          sha: tag[2],
          tag: field("tag"),
          object: { sha: field("object"), type: field("type") },
        });
      }
      throw new Unknown();
    },
  },

  "repo view": {
    values: JSONQ,
    pos: [0, 1],
    run: (a, c) => {
      let r: Repo | undefined;
      if (a.pos[0] !== undefined) {
        const slug = slugOfFlag(a.pos[0]);
        r = slug !== null ? c.w.repos[slug] : undefined;
        if (r === undefined)
          return fail(
            `GraphQL: Could not resolve to a Repository with the name '${a.pos[0]}'. (repository)`,
          );
      } else r = c.repo(a);
      const repo = r;
      return render(
        a,
        () => repoJson(repo),
        () => `name:\t${repo.slug}\n`,
      );
    },
  },
  "repo create": {
    values: ["--description"],
    bools: ["--private", "--public", "--internal", "--clone"],
    pos: [1, 1],
    run: (a, c) => {
      const raw = a.pos[0] as string;
      const slug = raw.includes("/") ? slugOfFlag(raw) : `${SIM_LOGIN}/${raw}`;
      if (slug === null) throw new Unknown();
      const vis = ["--private", "--public", "--internal"].filter((f) => a.bools.has(f));
      if (vis.length !== 1) throw new Unknown();
      if (c.w.repos[slug] !== undefined)
        return fail("GraphQL: Name already exists on this account (createRepository)");
      const origin = join(originsDir(c.home), `${slug}.git`);
      mkdirSync(origin, { recursive: true });
      const init = git(["init", "--bare", "-q", "-b", "main", origin]);
      if (init.code !== 0) return fail(init.stderr);
      c.w.repos[slug] = {
        slug,
        visibility:
          vis[0] === "--public" ? "PUBLIC" : vis[0] === "--internal" ? "INTERNAL" : "PRIVATE",
        origin,
        defaultBranch: "main",
      };
      if (a.bools.has("--clone")) {
        const name = slug.split("/")[1] as string;
        const cl = git(["clone", "-q", origin, join(c.ctx.cwd, name)], c.ctx.cwd);
        if (cl.code !== 0) return fail(cl.stderr);
      }
      return ok(`${repoUrl(slug)}\n`);
    },
  },
  "repo delete": {
    bools: ["--yes"],
    pos: [1, 1],
    run: (a, c) => {
      if (!a.bools.has("--yes")) return fail("--yes required when not running interactively");
      const slug = slugOfFlag(a.pos[0] as string) ?? "";
      const r = c.w.repos[slug];
      if (r === undefined)
        return fail(`GraphQL: Could not resolve to a Repository with the name '${a.pos[0]}'.`);
      // Only an origin the simulator made is removed; an adopted one is the user's.
      if (r.origin?.startsWith(`${originsDir(c.home)}/`))
        rmSync(r.origin, { recursive: true, force: true });
      delete c.w.repos[slug];
      delete c.w.labels[slug];
      delete c.w.next[slug];
      c.w.prs = c.w.prs.filter((p) => p.repo !== slug);
      c.w.issues = c.w.issues.filter((i) => i.repo !== slug);
      c.w.runs = c.w.runs.filter((x) => x.repo !== slug);
      return ok("", `✓ Deleted repository ${slug}\n`);
    },
  },

  "issue create": {
    values: ["--title", "--body", "--label", ...REPO],
    run: (a, c) => {
      const title = one(a, "--title");
      if (title === undefined) throw new Unknown();
      const repo = c.repo(a).slug;
      const i: Issue = {
        number: nextNumber(c.w, repo),
        repo,
        title,
        body: one(a, "--body") ?? "",
        state: "OPEN",
        labels: [...new Set(many(a, "--label"))],
        comments: [],
      };
      c.w.issues.push(i);
      return ok(`${issueUrl(i)}\n`);
    },
  },
  "issue view": {
    values: [...JSONQ, ...REPO],
    pos: [1, 1],
    run: (a, c) => {
      const n = Number(a.pos[0]);
      if (!Number.isInteger(n) || n <= 0) throw new Unknown();
      const i = issueOf(c, c.repo(a).slug, n, false);
      return render(
        a,
        () => issueJson(i),
        () => `title:\t${i.title}\nstate:\t${i.state}\n\n${i.body}\n`,
      );
    },
  },
  "issue list": {
    values: ["--state", "--label", "--limit", ...JSONQ, ...REPO],
    run: (a, c) => {
      const repo = c.repo(a).slug;
      const state = (one(a, "--state") ?? "open").toUpperCase();
      if (!["OPEN", "CLOSED", "ALL"].includes(state)) throw new Unknown();
      const labels = many(a, "--label");
      const limit = Number(one(a, "--limit") ?? 30);
      const list = c.w.issues
        .filter((i) => i.repo === repo && (state === "ALL" || i.state === state))
        .filter((i) => labels.every((l) => i.labels.includes(l)))
        .sort((x, y) => y.number - x.number)
        .slice(0, limit);
      return render(
        a,
        () => list.map(issueJson),
        () => list.map((i) => `${i.number}\t${i.state}\t${i.title}\n`).join(""),
      );
    },
  },
  "issue edit": {
    values: ["--add-label", "--remove-label", ...REPO],
    pos: [1, 1],
    run: (a, c) => {
      const i = issueOf(c, c.repo(a).slug, issueNumber(a.pos[0]), true);
      const add = many(a, "--add-label");
      const remove = many(a, "--remove-label");
      if (add.length + remove.length === 0) throw new Unknown();
      const known = new Set((c.w.labels[i.repo] ?? []).map((l) => l.name));
      const missing = add.find((l) => !known.has(l));
      if (missing !== undefined)
        return fail(`failed to update ${issueUrl(i)}: '${missing}' not found`);
      i.labels = [...new Set([...i.labels, ...add])].filter((l) => !remove.includes(l));
      return ok(`${issueUrl(i)}\n`);
    },
  },
  "issue comment": {
    values: ["--body", ...REPO],
    pos: [1, 1],
    run: (a, c) => {
      const body = one(a, "--body");
      if (body === undefined) throw new Unknown();
      const i = issueOf(c, c.repo(a).slug, issueNumber(a.pos[0]), true);
      i.comments.push(body);
      return ok(`${issueUrl(i)}#issuecomment-${i.comments.length}\n`);
    },
  },
  "issue close": {
    values: ["--comment", ...REPO],
    pos: [1, 1],
    run: (a, c) => {
      const i = issueOf(c, c.repo(a).slug, issueNumber(a.pos[0]), true);
      const comment = one(a, "--comment");
      if (comment !== undefined) i.comments.push(comment);
      i.state = "CLOSED";
      return ok("", `✓ Closed issue ${i.repo}#${i.number} (${i.title})\n`);
    },
  },

  "label list": {
    values: ["--search", "--limit", ...JSONQ, ...REPO],
    run: (a, c) => {
      const search = one(a, "--search")?.toLowerCase() ?? "";
      const list = (c.w.labels[c.repo(a).slug] ?? []).filter((l) =>
        l.name.toLowerCase().includes(search),
      );
      return render(
        a,
        () => list.map((l) => ({ ...l }) as Json),
        () => list.map((l) => `${l.name}\t${l.description}\t#${l.color}\n`).join(""),
      );
    },
  },
  "label create": {
    values: ["--description", "--color", ...REPO],
    bools: ["--force"],
    pos: [1, 1],
    run: (a, c) => {
      const repo = c.repo(a).slug;
      const name = a.pos[0] as string;
      const labels = c.w.labels[repo] ?? [];
      const at = labels.findIndex((l) => l.name.toLowerCase() === name.toLowerCase());
      if (at >= 0 && !a.bools.has("--force"))
        return fail(
          `label with name "${name}" already exists; use \`--force\` to update its color and description`,
        );
      const label = {
        name,
        description: one(a, "--description") ?? "",
        color: one(a, "--color") ?? "ededed",
      };
      if (at >= 0) labels[at] = label;
      else labels.push(label);
      c.w.labels[repo] = labels;
      return ok("", `✓ Label "${name}" created in ${repo}\n`);
    },
  },

  "pr create": {
    values: ["--title", "--body", "--base", "--head", ...REPO],
    bools: ["--draft"],
    run: (a, c) => {
      const title = one(a, "--title");
      if (title === undefined) throw new Unknown();
      const repo = c.repo(a);
      const base = one(a, "--base") ?? repo.defaultBranch;
      const head = one(a, "--head") ?? currentBranch(c.ctx.cwd);
      const existing = c.w.prs.find(
        (p) =>
          p.repo === repo.slug &&
          p.headRefName === head &&
          p.baseRefName === base &&
          p.state === "OPEN",
      );
      if (existing !== undefined)
        return fail(
          `a pull request for branch "${head}" into branch "${base}" already exists:\n${existing.url}`,
        );
      let oid = "";
      if (repo.origin !== null) {
        const tip = branchTip(repo.origin, head);
        if (tip === null || branchTip(repo.origin, base) === null)
          return fail(
            "pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, Head ref must be a branch (createPullRequest)",
          );
        oid = tip;
      }
      const number = nextNumber(c.w, repo.slug);
      const pr: Pr = {
        number,
        repo: repo.slug,
        url: `${repoUrl(repo.slug)}/pull/${number}`,
        title,
        body: one(a, "--body") ?? "",
        headRefName: head,
        baseRefName: base,
        headRefOid: oid,
        state: "OPEN",
        isDraft: a.bools.has("--draft"),
        mergeCommit: null,
        mergedAt: null,
        createdAt: new Date().toISOString(),
      };
      c.w.prs.push(pr);
      return ok(`${pr.url}\n`);
    },
  },
  "pr view": {
    values: [...JSONQ, ...REPO],
    pos: [0, 1],
    run: (a, c) => {
      const pr = prOf(c, a, a.pos[0]);
      if (isOut(pr)) return pr;
      return render(
        a,
        () => prJson(c, pr),
        () => `title:\t${pr.title}\nstate:\t${pr.state}\nurl:\t${pr.url}\n`,
      );
    },
  },
  "pr list": {
    values: ["--head", "--base", "--state", "--limit", ...JSONQ, ...REPO],
    run: (a, c) => {
      const repo = c.repo(a).slug;
      const state = (one(a, "--state") ?? "open").toUpperCase();
      if (!["OPEN", "CLOSED", "MERGED", "ALL"].includes(state)) throw new Unknown();
      const head = one(a, "--head");
      const base = one(a, "--base");
      const list = c.w.prs
        .filter((p) => p.repo === repo && (state === "ALL" || p.state === state))
        .filter(
          (p) =>
            (head === undefined || p.headRefName === head) &&
            (base === undefined || p.baseRefName === base),
        )
        .sort((x, y) => y.number - x.number)
        .slice(0, Number(one(a, "--limit") ?? 30));
      return render(
        a,
        () => list.map((p) => prJson(c, p)),
        () => list.map((p) => `${p.number}\t${p.title}\t${p.headRefName}\t${p.state}\n`).join(""),
      );
    },
  },
  "pr ready": {
    values: REPO,
    pos: [1, 1],
    run: (a, c) => {
      const pr = prOf(c, a, a.pos[0]);
      if (isOut(pr)) return pr;
      pr.isDraft = false;
      return ok("", `✓ Pull request ${pr.repo}#${pr.number} is marked as "ready for review"\n`);
    },
  },
  "pr merge": {
    values: ["--match-head-commit", "--subject", "--body", ...REPO],
    bools: ["--squash", "--merge", "--delete-branch"],
    pos: [1, 1],
    run: (a, c) => {
      const squash = a.bools.has("--squash");
      if (squash === a.bools.has("--merge")) throw new Unknown();
      const found = prOf(c, a, a.pos[0]);
      if (isOut(found)) return found;
      const pr = refreshPr(c.w, found);
      if (pr.state !== "OPEN") return fail("GraphQL: Pull request is not open (mergePullRequest)");
      const match = one(a, "--match-head-commit");
      if (match !== undefined && match !== pr.headRefOid) return fail(HEAD_MOVED_STDERR);
      const origin = c.w.repos[pr.repo]?.origin ?? null;
      if (origin === null) return fail(`volley-sim: ${pr.repo} has no local origin to merge into`);
      const base = branchTip(origin, pr.baseRefName);
      if (base === null) return fail(`GraphQL: Base branch ${pr.baseRefName} does not exist`);
      const subject =
        one(a, "--subject") ??
        (squash
          ? `${pr.title} (#${pr.number})`
          : `Merge pull request #${pr.number} from ${pr.headRefName}`);
      const body = one(a, "--body");
      const message = body !== undefined && body !== "" ? `${subject}\n\n${body}` : subject;
      const sha = mergeOnOrigin(
        origin,
        base,
        pr.headRefOid,
        squash ? [base] : [base, pr.headRefOid],
        message,
      );
      if (sha === null) return fail("GraphQL: Pull Request is not mergeable (mergePullRequest)");
      if (!updateBranch(origin, pr.baseRefName, sha, base))
        return fail(
          "GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)",
        );
      const now = new Date().toISOString();
      const merged = (p: Pr) => {
        p.state = "MERGED";
        p.mergeCommit = sha;
        p.mergedAt = now;
      };
      merged(pr);
      c.w.merges.push({ repo: pr.repo, pr: pr.number, head: pr.headRefOid, sha });
      // A merge commit contains its members: GitHub reads every PR whose head it holds as merged.
      if (!squash)
        for (const other of c.w.prs)
          if (
            other.repo === pr.repo &&
            other.state === "OPEN" &&
            isAncestor(origin, refreshPr(c.w, other).headRefOid, sha)
          )
            merged(other);
      if (a.bools.has("--delete-branch")) deleteBranch(origin, pr.headRefName);
      return ok(
        "",
        `✓ ${squash ? "Squashed and merged" : "Merged"} pull request ${pr.repo}#${pr.number} (${pr.title})\n`,
      );
    },
  },
  "pr checks": {
    values: [...JSONQ, ...REPO],
    pos: [1, 1],
    run: (a, c) => {
      const found = prOf(c, a, a.pos[0]);
      if (isOut(found)) return found;
      const pr = refreshPr(c.w, found);
      const runs = ciOf(c.w, pr.repo, pr.headRefOid, "pull_request", pr.headRefName);
      const checks = runs.map((r) => ({
        name: "test",
        state: r.conclusion === "success" ? "SUCCESS" : "FAILURE",
        bucket: r.conclusion === "success" ? "pass" : "fail",
        workflow: "CI",
        event: r.event,
        link: runUrl(r.repo, r.id),
        description: "",
        startedAt: r.createdAt,
        completedAt: r.createdAt,
      }));
      return render(
        a,
        () => checks,
        () => checks.map((x) => `${x.name}\t${x.bucket}\t0s\t${x.link}\n`).join(""),
      );
    },
  },

  "run list": {
    values: ["--commit", "--branch", "--limit", "--workflow", "--event", ...JSONQ, ...REPO],
    run: (a, c) => {
      const repo = c.repo(a);
      const commit = one(a, "--commit");
      const branch = one(a, "--branch");
      let runs: RunRec[];
      if (commit !== undefined) {
        const pr = c.w.prs.find((p) => p.repo === repo.slug && p.headRefOid === commit);
        runs = ciOf(c.w, repo.slug, commit, "pull_request", pr?.headRefName ?? "");
      } else if (branch !== undefined) {
        const tip = repo.origin !== null ? branchTip(repo.origin, branch) : null;
        runs = tip !== null ? ciOf(c.w, repo.slug, tip, "push", branch) : [];
      } else throw new Unknown();
      const event = one(a, "--event");
      if (event !== undefined) runs = runs.filter((r) => r.event === event);
      return render(
        a,
        () => runs.map(runJson),
        () =>
          runs
            .map((r) => `completed\t${r.conclusion}\tCI\t${r.branch}\t${r.event}\t${r.id}\n`)
            .join(""),
      );
    },
  },
  "run watch": {
    values: ["--interval", ...REPO],
    bools: ["--exit-status", "--compact"],
    pos: [1, 1],
    run: (a, c) => {
      const run = c.w.runs.find((r) => r.id === Number(a.pos[0]));
      if (run === undefined) return fail(`could not find any workflow run with ID ${a.pos[0]}`);
      const line = `✓ Run CI (${run.id}) completed with '${run.conclusion}'\n`;
      return a.bools.has("--exit-status") && run.conclusion !== "success"
        ? { code: 1, stdout: line, stderr: "" }
        : ok(line);
    },
  },
  "run view": {
    values: [...JSONQ, ...REPO],
    bools: ["--log-failed"],
    pos: [1, 1],
    run: (a, c) => {
      const run = c.w.runs.find((r) => r.id === Number(a.pos[0]));
      if (run === undefined) return fail(`could not find any workflow run with ID ${a.pos[0]}`);
      if (a.bools.has("--log-failed")) {
        if (one(a, "--json") !== undefined) throw new Unknown();
        return ok("");
      }
      const conclusion = run.conclusion;
      return render(
        a,
        () => ({
          ...runJson(run),
          jobs: [
            {
              name: "test",
              status: "completed",
              conclusion,
              steps: [{ name: "Run tests", status: "completed", conclusion }],
            },
          ],
        }),
        () => `✓ CI · ${run.id}\nTriggered via ${run.event}\n\nJOBS\n✓ test\n`,
      );
    },
  },
};

// --- entry --------------------------------------------------------------------------------------

/** Answer one `gh` argv from the world in `$VOLLEY_SIM_HOME` (the argv without `gh`). */
export function runGh(argv: string[], ctx: Ctx): Out {
  const home = simHome(ctx.env);
  const unknown = (): Out => {
    appendUnknown(home, ["gh", ...argv], ctx.cwd);
    return fail(`unknown argv: gh ${argv.join(" ")}`);
  };
  const two = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
  const key = COMMANDS[two] !== undefined ? two : argv[0] === "api" ? "api" : null;
  if (key === null) return unknown();
  const spec = COMMANDS[key] as Spec;
  try {
    const args = parse(argv.slice(key === "api" ? 1 : 2), spec);
    return withWorld(home, (w) => {
      const call: Call = {
        w,
        ctx,
        home,
        repo: (a) => {
          const flag = one(a, "--repo");
          if (flag !== undefined) {
            const slug = slugOfFlag(flag);
            const r = slug !== null ? w.repos[slug] : undefined;
            if (r === undefined)
              throw new NoRepo(
                `GraphQL: Could not resolve to a Repository with the name '${flag}'. (repository)`,
              );
            return r;
          }
          const r = repoOfCwd(w, ctx.cwd);
          if (r === null) throw new NoRepo("failed to determine base repo: no git remotes found");
          return r;
        },
      };
      try {
        return spec.run(args, call);
      } catch (e) {
        if (e instanceof NoRepo) return fail(e.message);
        throw e;
      }
    });
  } catch (e) {
    if (e instanceof Unknown) return unknown();
    throw e;
  }
}

class NoRepo extends Error {}

/** `bin/gh`: answer from the world under `VOLLEY_SIMULATED=1`, else run the real gh. */
export function main(argv: string[] = process.argv.slice(2)): number {
  if (!isSimulated()) return passThrough("gh", argv);
  const r = runGh(argv, { cwd: process.cwd(), env: process.env });
  if (r.stdout !== "") process.stdout.write(r.stdout);
  if (r.stderr !== "") process.stderr.write(r.stderr);
  return r.code;
}
