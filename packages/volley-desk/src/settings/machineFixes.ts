/**
 * What fixes a failing machine check, by its id (SPEC §4.6.15). A machine
 * record carries states only, never a fix's text ("the doctor that reads a
 * record supplies its own"), so the Desk keeps its own table, keyed by the ids
 * `volley peer doctor` writes: `tool.<name>`, `<name>_on_path`,
 * `volley.installed`, `volley.version`, `repo.clone`, `repo.origin`,
 * `repo.fetch`, `repo.push`, `repo.worktrees`, `repo.identity`, `gh.auth`, `git.identity`, `claude.signin`, `claude.trust`, `machine.memory`,
 * `machine.disk`, and the provisioning rows `skills`, `hooks`, `mcp` and
 * `sharing`. `safe` marks the fixes the doctor applies itself under `--fix`
 * (a Desk's Repair); the rest are for the person at that machine.
 *
 * A per-repository check (its `repo`, SPEC §4.6.21) names its repository: the
 * `repo.*` fixes point at that repository's clone, and `tool.<name>` says which
 * repository needs the tool. A check this table does not know is Repair's: the
 * person is never told to run the doctor by hand.
 */

export interface MachineFix {
  /** One line on what to do. */
  text: string;
  /** A command to copy and run on the machine, when there is one. */
  command?: string;
  /** Repair (`peer_doctor { fix: true }`) applies it. */
  safe: boolean;
  /** It runs only with Repair's clone switch on (the repository's, or **Also clone the wave repo**). */
  needsClone?: boolean;
}

export interface FixContext {
  machine: string;
  /** The wave repo's clone on the machine (its record's `repo.path`): an older peer's one repo. */
  repo?: string | undefined;
  /** Each repository's clone on the machine, for its per-repository checks. */
  repos?: readonly { slug: string; path?: string | undefined }[] | undefined;
}

/** The context one check's fix is worded in: `slug` is the check's repository, when it has one. */
interface Ctx extends FixContext {
  slug?: string | undefined;
}

type Fixer = (c: Ctx) => MachineFix;

/**
 * The clone the check is about: its repository's (never the wave repo's, which is another
 * repository), else the wave repo's.
 */
const repoOf = (c: Ctx) =>
  (c.slug !== undefined
    ? c.repos?.find((r) => r.slug.toLowerCase() === c.slug?.toLowerCase())?.path
    : c.repo) ?? "<the repo's clone>";

/** The repository a check is about, in words. */
const nameOf = (c: Ctx) => c.slug ?? "the wave repo";

const FIXES: Record<string, Fixer> = {
  "volley.installed": () => ({
    text: "Repair reinstalls volley's dependencies in its checkout",
    safe: true,
  }),
  "volley.version": () => ({
    text: "Repair checks out the supervisor's volley version and installs it",
    safe: true,
  }),
  "repo.clone": (c) => ({
    text:
      c.slug !== undefined
        ? `Repair clones ${c.slug} to ${repoOf(c)}`
        : `Repair clones the wave repo to ${repoOf(c)} (with Also clone the wave repo)`,
    safe: true,
    needsClone: true,
  }),
  "repo.origin": (c) => ({
    text: `point the clone at ${nameOf(c)}, after checking ${repoOf(c)} is the one you meant`,
    command: `git -C ${repoOf(c)} remote -v`,
    safe: false,
  }),
  "repo.fetch": (c) => ({
    text: `check that ${c.machine} can fetch ${nameOf(c)} (its git credentials or network)`,
    command: `git -C ${repoOf(c)} fetch origin`,
    safe: false,
  }),
  "repo.push": (c) => ({
    text: `give ${c.machine}'s GitHub account write access to ${nameOf(c)}, or sign gh in there as one that has it`,
    command: "gh auth login",
    safe: false,
  }),
  "repo.worktrees": (c) => ({
    text: `Repair creates the folder ${c.machine} cuts ${nameOf(c)}'s worktrees under`,
    safe: true,
  }),
  "repo.identity": (c) => ({
    text: `give ${repoOf(c)} on ${c.machine} a commit identity: git -C ${repoOf(c)} config user.name … && … user.email …, or a global one with setup's Sign-ins step`,
    command: `git -C ${repoOf(c)} config user.name "<name>" && git -C ${repoOf(c)} config user.email <email>`,
    safe: false,
  }),
  "gh.auth": (c) => ({
    text: `sign GitHub in on ${c.machine} with an account that can push to the wave repo`,
    command: "gh auth login",
    safe: false,
  }),
  "git.identity": (c) => ({
    text: `give git a commit identity on ${c.machine} from its GitHub account (setup's Sign-ins step)`,
    command: "volley setup --peer --step signin",
    safe: false,
  }),
  "claude.signin": (c) => ({
    text: `sign Claude Code in on ${c.machine}: run claude there and /login`,
    command: "claude",
    safe: false,
  }),
  "claude.trust": (c) => ({
    text: `run claude in the repo once on ${c.machine} and accept the trust dialog`,
    command: `cd ${repoOf(c)} && claude`,
    safe: false,
  }),
  "machine.memory": (c) => ({
    text: `close what you do not need on ${c.machine}; placement avoids it meanwhile`,
    safe: false,
  }),
  "machine.disk": (c) => ({
    text: `free space on the disk that holds ${c.machine}'s worktrees`,
    safe: false,
  }),
  skills: () => ({ text: "Repair links the Volley skills into its Claude profile", safe: true }),
  hooks: () => ({ text: "Repair installs the Volley hooks in its Claude profile", safe: true }),
  mcp: () => ({ text: "Repair registers the volley MCP server in its Claude profile", safe: true }),
  sharing: () => ({
    text: "Repair applies the supervisor's sharing modes to its Claude profile",
    safe: true,
  }),
};

/** `bun_on_path`, `claude_on_path`: the doctor's estimate of the non-interactive ssh PATH. */
const onPath = (tool: string, c: FixContext): MachineFix => ({
  text: `make ${tool} reachable on ${c.machine}'s non-interactive ssh PATH (a link in /usr/local/bin)`,
  command: `sudo ln -s "$(command -v ${tool})" /usr/local/bin/${tool}`,
  safe: false,
});

/**
 * The fix for a failing check `id` on a machine; `slug` is the repository a per-repository check
 * is about (its `repo`). An id this Desk does not know is left to Repair's plan.
 */
export function fixFor(id: string, ctx: FixContext, slug?: string): MachineFix {
  const c: Ctx = { ...ctx, slug };
  const known = FIXES[id];
  if (known) return known(c);
  if (id.startsWith("tool.")) {
    const tool = id.slice("tool.".length);
    const needed = slug !== undefined ? ` (needed by ${slug})` : "";
    return {
      text: `install ${tool} on ${c.machine}${needed}, on the PATH its agents get`,
      safe: false,
    };
  }
  if (id.endsWith("_on_path")) return onPath(id.slice(0, -"_on_path".length), c);
  return {
    text: `Repair… runs the doctor on ${c.machine} again; its plan has this check's fix`,
    safe: false,
  };
}
