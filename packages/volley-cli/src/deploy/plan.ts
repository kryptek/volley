import { dirname, join } from "node:path";
import { DESK_LABEL } from "../setup/services";

/**
 * `volley deploy`'s plan, pure: which tag, what the services checkout is, and the ordered steps
 * (each with the exact argv it runs). `apply.ts` runs them through `deployFence`; a dry run
 * prints them.
 */

/** The deploy's tunables, in one place. */
export const DEPLOY = {
  /** How long the health check waits for volleyd and the Desk to answer after the restart. */
  health_timeout_ms: 30_000,
  /** How often the health check asks again while it waits. */
  poll_ms: 1_000,
  /** `--force-clean` stashes local changes under this prefix plus the time. */
  stash_prefix: "volley-deploy-",
} as const;

/** volleyd's launchd label (volleyd's `SERVICE_LABEL`). */
export const VOLLEYD_LABEL = "systems.volley.volleyd";

/** A release tag, with or without its `v`. */
export const TAG_RE = /^v?\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/;

/** `requested` as a `v`-prefixed tag; throws when it is not a release tag. */
export function normaliseTag(requested: string): string {
  if (!TAG_RE.test(requested)) throw new Error(`not a release tag: ${JSON.stringify(requested)}`);
  return requested.startsWith("v") ? requested : `v${requested}`;
}

/** Version order of two release tags (`v` optional); a prerelease sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const split = (t: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-.](.+))?$/.exec(t);
    return m === null
      ? { core: [0, 0, 0], pre: null }
      : { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] as number) - (y.core[i] as number);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  // Prerelease identifiers: numeric ones by value, others as text (semver's rule, near enough).
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const d =
      /^\d+$/.test(p) && /^\d+$/.test(q) ? Number(p) - Number(q) : p < q ? -1 : p > q ? 1 : 0;
    if (d !== 0) return d;
  }
  return 0;
}

/** The tag to deploy: `requested` (normalised) when the repo has it, or the newest for "latest". */
export function resolveTag(tags: readonly string[], requested: string): string {
  const releases = tags.filter((t) => t.startsWith("v") && TAG_RE.test(t));
  const newest = [...releases].sort((a, b) => compareVersions(b, a));
  if (requested === "latest") {
    if (newest[0] === undefined) throw new Error("no v* release tag in the checkout");
    return newest[0];
  }
  const tag = normaliseTag(requested);
  if (releases.includes(tag)) return tag;
  throw new Error(
    newest.length === 0
      ? `no tag ${tag} (no v* release tag in the checkout)`
      : `no tag ${tag} (the newest are ${newest.slice(0, 3).join(", ")})`,
  );
}

const DIRTY: Record<string, string> = {
  "?": "untracked",
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  T: "type changed",
};

/** `git status --porcelain` as one `<path> (<what>)` line per entry. */
export function parseDirty(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const code = l.slice(0, 2);
      const what = DIRTY[code[0] !== " " ? (code[0] as string) : (code[1] as string)] ?? "changed";
      return `${l.slice(3)} (${what})`;
    });
}

/** The checkout and bun the installed volleyd service runs. */
export interface ServicesInstall {
  repo: string;
  bun: string;
}

const VOLLEYD_CLI = join("packages", "volleyd", "src", "cli.ts");

const unxml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** systemd's word splitting for `ExecStart=` (double-quoted words with backslash escapes). */
function sdWords(line: string): string[] {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    words.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] as string));
  }
  return words;
}

/**
 * The checkout volleyd's installed unit runs from: the launchd plist's `ProgramArguments` or the
 * systemd unit's `ExecStart` (`<bun> <repo>/packages/volleyd/src/cli.ts daemon`). Null when the
 * unit runs volleyd from no checkout.
 */
export function servicesCheckout(unitText: string): ServicesInstall | null {
  let args: string[];
  const plist = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(unitText);
  if (plist !== null) {
    args = [...(plist[1] as string).matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
      unxml(m[1] as string),
    );
  } else {
    const exec = /^ExecStart=(.*)$/m.exec(unitText);
    if (exec === null) return null;
    args = sdWords(exec[1] as string);
  }
  const [bun, cli] = args;
  if (bun === undefined || cli === undefined || !cli.endsWith(`/${VOLLEYD_CLI}`)) return null;
  return { repo: dirname(dirname(dirname(dirname(cli)))), bun };
}

/** A service the deploy restarts: its name as the service manager knows it, and the restart. */
export interface ServiceUnit {
  name: string;
  restart: string[];
}

/** volleyd's and the Desk's services on this platform, or null when no service manager is known. */
export function platformServices(platform: NodeJS.Platform, uid: number): ServiceUnit[] | null {
  if (platform === "darwin") {
    return [VOLLEYD_LABEL, DESK_LABEL].map((l) => ({
      name: l,
      restart: ["launchctl", "kickstart", "-k", `gui/${uid}/${l}`],
    }));
  }
  if (platform === "linux") {
    return ["volleyd.service", "volley-desk.service"].map((u) => ({
      name: u,
      restart: ["systemctl", "--user", "restart", u],
    }));
  }
  return null;
}

/** What the checkout is at: a tag, a branch, or a bare commit. */
export interface Ref {
  kind: "tag" | "branch" | "commit";
  name: string;
}

export const refLabel = (r: Ref) => (r.kind === "commit" ? r.name.slice(0, 7) : r.name);

export interface Command {
  argv: string[];
  cwd?: string;
}

export type StepId =
  | "stash"
  | "fetch"
  | "checkout"
  | "install"
  | "build"
  | "self-check"
  | "restart"
  | "health";

export interface PlanStep {
  id: StepId;
  /** One line, as the summary prints it. */
  title: string;
  /** The external commands it runs, in order (none for the health check). */
  commands: Command[];
  /** What it does besides the commands. */
  detail?: string;
}

export interface PlanContext {
  repo: string;
  bun: string;
  services: ServiceUnit[];
  deskPort: number;
  /** What to check out. */
  target: Ref;
  /** Fetch tags first (the deploy does; a rollback does not). */
  fetch: boolean;
  /** Stash local changes under this name first (`--force-clean`). */
  stash?: string;
}

export const git = (repo: string, ...args: string[]) => ["git", "-C", repo, ...args];

export const deskDir = (repo: string) => join(repo, "packages", "volley-desk");

/** The read-only commands a deploy (and a dry run) runs before the plan. */
export function readOnlyCommands(repo: string): Command[] {
  return [
    { argv: git(repo, "status", "--porcelain") },
    { argv: git(repo, "describe", "--tags", "--exact-match", "HEAD") },
    { argv: git(repo, "rev-parse", "--abbrev-ref", "HEAD") },
    { argv: git(repo, "rev-parse", "HEAD") },
    { argv: git(repo, "tag", "--list", "v*") },
  ];
}

/** The deploy's steps, in order, with their argv. */
export function deployPlan(ctx: PlanContext): PlanStep[] {
  const { repo, bun, target } = ctx;
  const steps: PlanStep[] = [];
  if (ctx.stash !== undefined) {
    steps.push({
      id: "stash",
      title: `stash local changes as ${ctx.stash}`,
      commands: [{ argv: git(repo, "stash", "push", "-u", "-m", ctx.stash) }],
    });
  }
  if (ctx.fetch) {
    steps.push({
      id: "fetch",
      title: "fetch tags",
      commands: [{ argv: git(repo, "fetch", "--tags", "origin") }],
    });
  }
  steps.push(
    {
      id: "checkout",
      title:
        target.kind === "branch"
          ? `checkout ${target.name}`
          : `checkout ${refLabel(target)} (detached)`,
      commands: [
        {
          argv:
            target.kind === "branch"
              ? git(repo, "checkout", target.name)
              : git(repo, "checkout", "--detach", target.name),
        },
      ],
    },
    {
      id: "install",
      title: "bun install --frozen-lockfile",
      commands: [{ argv: [bun, "install", "--frozen-lockfile"], cwd: repo }],
    },
    {
      id: "build",
      title: "build the Desk",
      commands: [{ argv: [bun, "run", "build"], cwd: deskDir(repo) }],
      detail: "then record the checkout's Desk stamp in dist/.volley-build",
    },
    {
      id: "self-check",
      title: "self-check",
      commands: [
        { argv: [bun, join(repo, "packages", "volley-cli", "src", "cli.ts"), "--version"] },
        {
          argv: [
            bun,
            join(repo, VOLLEYD_CLI),
            "validate",
            join(repo, "packages", "volleyd", "test", "fixtures", "example.yaml"),
          ],
        },
      ],
      detail: "volley --version is the release's; dist/index.html and dist/version.json carry it",
    },
    ...ctx.services.map(
      (s): PlanStep => ({
        id: "restart",
        title: `restart ${s.name}`,
        commands: [{ argv: s.restart }],
      }),
    ),
    {
      id: "health",
      title: "health-check",
      commands: [],
      detail: `volleyd's retained status is fresh; http://127.0.0.1:${ctx.deskPort}/ and /version.json answer`,
    },
  );
  return steps;
}

/** `--force-clean`'s stash name for a deploy started at `now`. */
export const stashName = (now: Date) =>
  `${DEPLOY.stash_prefix}${now
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-")}`;
