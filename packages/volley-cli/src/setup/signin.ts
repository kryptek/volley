import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SIM_GH_USER } from "volley-sim/world";
import { loginIdentity, parseClaudeStatus } from "../peer/checks/claude";
import { ghUser } from "../peer/checks/github";
import { simulated } from "./first-wave";
import type { Change, SetupContext, SetupExec, StepPlan } from "./step";
import { unifiedDiff } from "./step";

/**
 * The Sign-ins step: Claude Code and GitHub signed in on this machine, inside the guided flow,
 * read with the doctor's own parsers (`claude auth status`: a state and a plan label; `gh auth
 * status`: its exit code); and Claude Code allowed to read the Volley checkout
 * (`permissions.additionalDirectories` in ~/.claude/settings.json), which an unattended
 * coordinator start needs. A sign-in opens the person's browser and is not a question; nothing
 * secret is read or printed (the Claude e-mail only with `--show-email`, the GitHub login
 * masked). The first-run screens of Claude Code are only reported: volleyd seeds them in the
 * account profiles it runs agents in.
 */

export const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
export const CLAUDE_STATUS = ["claude", "auth", "status"] as const;
export const CLAUDE_LOGIN = ["claude", "auth", "login"] as const;
export const GH_STATUS = ["gh", "auth", "status"] as const;
export const GH_LOGIN = ["gh", "auth", "login", "--web", "--git-protocol", "https"] as const;
export const GH_SETUP_GIT = ["gh", "auth", "setup-git"] as const;
export const GH_USER = ["gh", "api", "user", "--jq", ".login"] as const;
/** The signed-in account (its name, id and login: git's identity is derived from them). */
export const GH_API_USER = ["gh", "api", "user"] as const;
/** git's own verdict on whether it can commit here: non-zero exactly when a commit would die. */
export const GIT_IDENT_PROBE = ["git", "var", "GIT_COMMITTER_IDENT"] as const;

const same = (argv: readonly string[], want: readonly string[]) =>
  argv.length === want.length && want.every((w, i) => argv[i] === w);

/** Every command this step runs (the fence's entries). */
export const SIGNIN_COMMANDS: readonly (readonly string[])[] = [
  CLAUDE_STATUS,
  CLAUDE_LOGIN,
  GH_STATUS,
  GH_LOGIN,
  GH_SETUP_GIT,
  GH_USER,
  GH_API_USER,
];

export const isSigninCommand = (argv: readonly string[]) =>
  SIGNIN_COMMANDS.some((c) => same(argv, c));

/** The identity setup gives git: the account's name (else its login) and its noreply address. */
export interface GitIdentity {
  name: string;
  email: string;
}

const NOREPLY = /^\d{1,20}\+[A-Za-z0-9-]{1,39}@users\.noreply\.github\.com$/;
const GIT_NAME = (v: string) =>
  v.length >= 1 && v.length <= 100 && !/[\n\0]/.test(v) && !v.startsWith("-");

/** The two writes, to git's global config (never `--replace-all`, never local or system). */
export const gitConfigGlobalArgv = (id: GitIdentity): string[][] => [
  ["git", "config", "--global", "user.name", id.name],
  ["git", "config", "--global", "user.email", id.email],
];

/**
 * git's commands this step runs (the fence's entries): the probe, and the two global writes with
 * a plain name and GitHub's noreply address only (an arbitrary address is refused).
 */
export function isGitIdentityCommand(argv: readonly string[]): boolean {
  if (same(argv, GIT_IDENT_PROBE)) return true;
  if (argv.length !== 5 || !same(argv.slice(0, 3), ["git", "config", "--global"])) return false;
  const v = argv[4] ?? "";
  return (argv[3] === "user.name" && GIT_NAME(v)) || (argv[3] === "user.email" && NOREPLY.test(v));
}

/** `Name <email>` out of `git var GIT_COMMITTER_IDENT` (its timestamp and zone stripped). */
export function identityOf(stdout: string): string | null {
  const line = (stdout.split("\n")[0] ?? "").trim();
  if (line === "") return null;
  return line.replace(/\s+\d+\s+[+-]\d{4}$/, "");
}

/** git's identity from `gh api user`'s JSON; null when the account's id or login is not usable. */
export function identityFromGhUser(json: string): GitIdentity | null {
  let u: unknown;
  try {
    u = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof u !== "object" || u === null) return null;
  const { login, id, name } = u as { login?: unknown; id?: unknown; name?: unknown };
  if (typeof login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(login)) return null;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return null;
  const trimmed = typeof name === "string" ? name.trim() : "";
  const identity = {
    name: trimmed !== "" && GIT_NAME(trimmed) ? trimmed : login,
    email: `${id}+${login}@users.noreply.github.com`,
  };
  return NOREPLY.test(identity.email) ? identity : null;
}

/**
 * `exec` with the sign-ins answered by fakes (`VOLLEY_SIMULATED=1`: the soak, CI): signed in
 * everywhere as volley-sim's account, a login that opens nothing. Every other command runs for
 * real: git's identity is written to the machine's global config, as it is signed in for real.
 */
export function simulatedExec(exec: SetupExec): SetupExec {
  return async (argv, opts) => {
    if (same(argv, CLAUDE_STATUS)) {
      return { code: 0, stdout: '{"loggedIn":true,"subscriptionType":"max"}\n', stderr: "" };
    }
    if (same(argv, GH_USER)) return { code: 0, stdout: `${SIM_GH_USER.login}\n`, stderr: "" };
    if (same(argv, GH_API_USER)) {
      return { code: 0, stdout: `${JSON.stringify(SIM_GH_USER)}\n`, stderr: "" };
    }
    if (isSigninCommand(argv)) return { code: 0, stdout: "", stderr: "" };
    return exec(argv, opts);
  };
}

/** A GitHub login as setup shows it: its first character, then bullets (like an e-mail's). */
export const maskLogin = (login: string) => `${login.slice(0, 1)}•••`;

/** Whether git asks gh for GitHub credentials (`gh auth setup-git` was run). */
function gitUsesGh(ctx: SetupContext): boolean {
  const files = [
    join(ctx.home, ".gitconfig"),
    join(ctx.auth.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config"), "git", "config"),
  ];
  return files.some((f) => {
    try {
      return /helper\s*=\s*!\S*gh(\.exe)?\s+auth\s+git-credential/.test(readFileSync(f, "utf-8"));
    } catch {
      return false;
    }
  });
}

const readJson = (file: string): Record<string, unknown> | null | undefined => {
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return typeof j === "object" && j !== null && !Array.isArray(j)
      ? (j as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** settings.json with `dir` added to `permissions.additionalDirectories`, every other key kept. */
export function withAdditionalDirectory(settings: Record<string, unknown>, dir: string): string {
  const permissions =
    typeof settings.permissions === "object" && settings.permissions !== null
      ? (settings.permissions as Record<string, unknown>)
      : {};
  const dirs = Array.isArray(permissions.additionalDirectories)
    ? permissions.additionalDirectories
    : [];
  return `${JSON.stringify(
    { ...settings, permissions: { ...permissions, additionalDirectories: [...dirs, dir] } },
    null,
    2,
  )}\n`;
}

export async function planSignin(ctx: SetupContext): Promise<StepPlan> {
  const plan: StepPlan = { step: "signin", title: "Sign-ins", found: [], changes: [] };
  if (ctx.auth.deps.invokingUser(ctx.auth.env) !== null) {
    plan.skipped =
      "running as root, and the sign-ins are your user's: run `volley setup --step signin` as that user (without sudo)";
    return plan;
  }
  const rows: string[] = [];
  const signins: Change[] = [];
  const run = async (argv: readonly string[], what: string) => {
    const r = await ctx.deps.exec(argv, { tty: true });
    if (r.code !== 0) throw new Error(`\`${argv.join(" ")}\` failed (exit ${r.code}): ${what}`);
  };

  // Claude Code.
  const st = await ctx.deps.exec(CLAUDE_STATUS);
  if (st.code === 127) {
    plan.blocked = `Claude Code is not installed: install it (${CLAUDE_INSTALL}), then rerun \`volley setup\``;
    plan.row = "Claude Code: not installed";
    return plan;
  }
  const claude = parseClaudeStatus(st.code, st.stdout);
  if (claude.state === "signed_in") {
    const email =
      ctx.showEmail === true
        ? loginIdentity(readJson(join(ctx.home, ".claude.json")) ?? null).email
        : undefined;
    const label = [claude.plan, email].filter((x) => x !== null && x !== undefined).join(", ");
    const line = `Claude Code: signed in${label !== "" ? ` (${label})` : ""}`;
    plan.found.push(line);
    rows.push(`✓ ${line}`);
  } else {
    plan.found.push(
      claude.state === "not_signed_in"
        ? "Claude Code: not signed in"
        : "Claude Code: could not tell whether it is signed in (`claude auth status`)",
    );
    rows.push("Claude Code: not signed in");
    signins.push({
      summary: "Sign in to Claude Code (opens your browser)",
      detail: "Runs `claude auth login`; finish the sign-in in the browser, then come back here.",
      apply: async () => {
        ctx.metrics?.signIn();
        await run(CLAUDE_LOGIN, "the Claude Code sign-in did not finish");
        return ["Claude Code: signed in."];
      },
    });
  }

  // GitHub.
  const gh = await ctx.deps.exec(GH_STATUS);
  if (gh.code === 127) {
    plan.found.push(
      "GitHub: gh is not installed (https://cli.github.com): agents here cannot open pull requests until it is",
    );
    rows.push("GitHub: gh is not installed");
  } else if (gh.code !== 0) {
    plan.found.push("GitHub: gh is not signed in");
    rows.push("GitHub: not signed in");
    signins.push({
      summary: "Sign in to GitHub (opens your browser), then let git push with that login",
      detail: `Runs \`${GH_LOGIN.join(" ")}\`, then \`${GH_SETUP_GIT.join(" ")}\`.`,
      apply: async () => {
        ctx.metrics?.signIn();
        await run(GH_LOGIN, "the GitHub sign-in did not finish");
        await run(GH_SETUP_GIT, "git was not set up to use the GitHub login");
        return ["GitHub: signed in; git pushes with that login."];
      },
    });
  } else {
    const user = ghUser((await ctx.deps.exec(GH_USER)).stdout);
    const line = `GitHub: signed in${user !== null ? ` as ${maskLogin(user)}` : ""}`;
    plan.found.push(line);
    // Simulated, git never pushes to GitHub (the fake `gh auth setup-git` writes no git config).
    if (simulated(ctx) || gitUsesGh(ctx)) rows.push(`✓ ${line}`);
    else {
      rows.push(`${line}; git does not use that login yet`);
      plan.changes.push({
        summary: "Let git push with your GitHub login (gh auth setup-git)",
        detail: `Runs \`${GH_SETUP_GIT.join(" ")}\` (adds gh as git's credential helper for GitHub).`,
        apply: async () => {
          await run(GH_SETUP_GIT, "git was not set up to use the GitHub login");
          return ["git pushes to GitHub with your gh login."];
        },
      });
    }
  }

  // git's commit identity, from the GitHub account (a commit dies "Author identity unknown"
  // without one). Only when git cannot commit here: an identity it already has is never changed.
  const gitOpts = {
    cwd: ctx.home,
    env: { ...ctx.auth.env, HOME: ctx.home, GIT_TERMINAL_PROMPT: "0" },
  };
  const probe = await ctx.deps.exec(GIT_IDENT_PROBE, gitOpts);
  const ident = probe.code === 0 ? identityOf(probe.stdout) : null;
  if (ident !== null) rows.push(`✓ git commits as ${ident}`);
  else {
    const none = "git has no commit identity (user.name/user.email)";
    plan.found.push(none);
    if (gh.code === 127) {
      rows.push(
        `${none}: set one (git config --global user.name …; … user.email …) or install gh and rerun`,
      );
    } else {
      rows.push(none);
      const write = async (id: GitIdentity) => {
        for (const argv of gitConfigGlobalArgv(id)) {
          const r = await ctx.deps.exec(argv, gitOpts);
          if (r.code !== 0) {
            throw new Error(`\`${argv.join(" ")}\` failed (exit ${r.code}): ${r.stderr.trim()}`);
          }
        }
        return [`git commits as ${id.name} <${id.email}>.`];
      };
      const account = async () => {
        const r = await ctx.deps.exec(GH_API_USER);
        return r.code === 0 ? identityFromGhUser(r.stdout) : null;
      };
      const shown = (id: GitIdentity) =>
        gitConfigGlobalArgv(id)
          .map((a) =>
            [...a.slice(0, 4), a[3] === "user.name" ? JSON.stringify(a[4]) : a[4]].join(" "),
          )
          .join("\n");
      if (gh.code === 0) {
        const id = await account();
        if (id === null) {
          plan.found.push("GitHub: could not read the account (`gh api user`) to derive one from");
        } else {
          plan.changes.push({
            summary: `Give git a commit identity from your GitHub account: user.name ${JSON.stringify(id.name)}, user.email ${id.email} (git config --global)`,
            detail: shown(id),
            apply: () => write(id),
          });
        }
      } else {
        // Placed after the GitHub sign-in (the sign-ins go first): the account is read then.
        plan.changes.push({
          summary:
            "Give git a commit identity from your GitHub account once signed in (user.name from its name, user.email its noreply address; git config --global)",
          detail: shown({
            name: "<the account's name>",
            email: "<id>+<login>@users.noreply.github.com",
          }),
          apply: async () => {
            const id = (await ctx.deps.exec(GH_STATUS)).code === 0 ? await account() : null;
            if (id === null) {
              throw new Error(
                "git has no commit identity and gh is not signed in: sign in (gh auth login --web), then rerun volley setup --step signin",
              );
            }
            return write(id);
          },
        });
      }
    }
  }

  // Claude Code may read the Volley checkout (an unattended coordinator start needs it).
  const repo = ctx.deps.repoRoot;
  const settings = ctx.auth.env.CLAUDE_SETTINGS ?? join(ctx.home, ".claude", "settings.json");
  const parsed = readJson(settings);
  if (repo === null) plan.found.push("no Volley checkout found: nothing to let Claude Code read");
  else if (parsed === undefined) {
    plan.found.push(`${settings} is not a JSON object: left as is (fix it, then rerun)`);
    rows.push(`${settings} is not valid JSON`);
  } else {
    const current = parsed ?? {};
    const perms = current.permissions as { additionalDirectories?: unknown } | undefined;
    const dirs = Array.isArray(perms?.additionalDirectories) ? perms.additionalDirectories : [];
    if (dirs.includes(repo)) rows.push(`✓ Claude Code may read the Volley checkout (${repo})`);
    else {
      rows.push("Claude Code may not read the Volley checkout yet");
      const before = existsSync(settings) ? readFileSync(settings, "utf-8") : "";
      const after = withAdditionalDirectory(current, repo);
      plan.changes.push({
        summary: `Let Claude Code sessions read the Volley checkout (permissions.additionalDirectories in ${settings})`,
        detail: unifiedDiff(settings, before, after),
        apply: async () => {
          // Re-read: Claude Code (or the hooks installer) may have written it since the plan.
          const now = readJson(settings);
          if (now === undefined) throw new Error(`${settings} is not a JSON object`);
          const text = withAdditionalDirectory(now ?? {}, repo);
          mkdirSync(dirname(settings), { recursive: true });
          const lines: string[] = [];
          if (existsSync(settings)) {
            // Backed up the way the hooks installer backs it up.
            const backup = `${settings}.bak-${ctx.auth.io.now().toISOString().replace(/[:.]/g, "-")}`;
            copyFileSync(settings, backup);
            lines.push(`Backed the previous one up to ${backup}.`);
          }
          writeFileSync(settings, text);
          return [`Wrote ${settings}.`, ...lines];
        },
      });
    }
  }

  // The first-run screens: reported, never written here.
  const answered = readJson(join(ctx.home, ".claude.json"))?.hasCompletedOnboarding === true;
  const firstRun = answered
    ? "first-run screens answered"
    : "first-run screens not answered yet: Claude Code shows them once, on its first start (agents' account profiles are seeded by volleyd)";
  plan.found.push(firstRun);
  rows.push(answered ? `✓ ${firstRun}` : "first-run screens not answered yet");

  plan.row = rows.join("\n");
  if (signins.length > 0 && !ctx.deps.interactive && ctx.check !== true) {
    plan.skipped = `a browser sign-in is needed (${signins.map((c) => (c.summary.includes("GitHub") ? "GitHub" : "Claude Code")).join(", ")}) and nobody is at this terminal: sign in (\`claude auth login\`, \`gh auth login --web\`), then rerun \`volley setup\``;
    return plan;
  }
  plan.changes.unshift(...signins);
  plan.verify = async () => {
    const again = await planSignin({ ...ctx, check: true });
    return [
      ...(again.blocked !== undefined ? [again.blocked] : []),
      ...again.changes.map((c) => `still not in place: ${c.summary}`),
    ];
  };
  return plan;
}
