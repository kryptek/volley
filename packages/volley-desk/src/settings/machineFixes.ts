/**
 * What fixes a failing machine check, by its id (SPEC §4.6.15). A machine
 * record carries states only, never a fix's text ("the doctor that reads a
 * record supplies its own"), so the Desk keeps its own table, keyed by the ids
 * `volley peer doctor` writes: `tool.<name>`, `<name>_on_path`,
 * `volley.installed`, `volley.version`, `repo.clone`, `repo.origin`,
 * `repo.fetch`, `gh.auth`, `claude.signin`, `claude.trust`, `machine.memory`,
 * `machine.disk`, and the provisioning rows `skills`, `hooks`, `mcp` and
 * `sharing`. `safe` marks the fixes the doctor applies itself under `--fix`
 * (a Desk's Repair); the rest are for the person at that machine.
 */

export interface MachineFix {
  /** One line on what to do. */
  text: string;
  /** A command to copy and run on the machine, when there is one. */
  command?: string;
  /** Repair (`peer_doctor { fix: true }`) applies it. */
  safe: boolean;
  /** It runs only with Repair's **Also clone the wave repo**. */
  needsClone?: boolean;
}

export interface FixContext {
  machine: string;
  /** The wave repo's clone on the machine (its record's `repo.path`). */
  repo?: string | undefined;
}

type Fixer = (c: FixContext) => MachineFix;

const repoOf = (c: FixContext) => c.repo ?? "<the repo's clone>";

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
    text: `Repair clones the wave repo to ${repoOf(c)} (with Also clone the wave repo)`,
    safe: true,
    needsClone: true,
  }),
  "repo.origin": (c) => ({
    text: `point the clone at the wave repo, after checking ${repoOf(c)} is the one you meant`,
    command: `git -C ${repoOf(c)} remote -v`,
    safe: false,
  }),
  "repo.fetch": (c) => ({
    text: `check that ${c.machine} can fetch the wave repo (its git credentials or network)`,
    command: `git -C ${repoOf(c)} fetch origin`,
    safe: false,
  }),
  "gh.auth": (c) => ({
    text: `sign GitHub in on ${c.machine} with an account that can push to the wave repo`,
    command: "gh auth login",
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

/** The fix for a failing check `id` on a machine; an id this Desk does not know points at the doctor. */
export function fixFor(id: string, c: FixContext): MachineFix {
  const known = FIXES[id];
  if (known) return known(c);
  if (id.startsWith("tool.")) {
    const tool = id.slice("tool.".length);
    return { text: `install ${tool} on ${c.machine}, on the PATH its agents get`, safe: false };
  }
  if (id.endsWith("_on_path")) return onPath(id.slice(0, -"_on_path".length), c);
  return {
    text: `run the doctor on ${c.machine} for this check's fix`,
    command: "volley peer doctor",
    safe: false,
  };
}
