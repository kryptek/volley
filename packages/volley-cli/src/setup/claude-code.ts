import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { readCredentials } from "../auth/context";
import { type Account, readAccounts } from "../commands/auth-accounts";
import {
  type SkillFact,
  VOLLEY_SKILLS,
  realOf,
  skillState,
  volleyEntryIn,
  withoutLogin,
} from "../peer/profile-checks";
import { COORDINATOR_NAME, SETUP_NAMESPACE, readSetupInstall, writeSetupInstall } from "./journal";
import { planHooks } from "./services";
import type { SetupContext, StepPlan } from "./step";

/**
 * The Claude Code step: everything a coordinator session on this machine needs, with no secret
 * in `~/.claude.json`. One coordinator name, chosen once (asked, with this machine's name as the
 * default) and kept in setup.json; the volley MCP server registered at user scope with
 * non-secret env only (its login comes from `coordinator.json` in the auth dir it names); the
 * three Volley skills linked through their installers; the Volley hooks installed. An MCP entry
 * that carries a broker login only is re-registered without it, once the login is in the auth
 * dir; one with settings of the person's own (a custom key, another agent id) is left alone and
 * the command that replaces it is printed. `--broker-url` re-points the registration and the hooks.
 */

/** The MCP env keys setup's registration sets: any other is the person's own. */
export const MCP_ENV_KEYS = [
  "VOLLEY_AGENT_ID",
  "VOLLEY_COORDINATOR",
  "VOLLEY_NAMESPACE",
  "VOLLEY_BROKER_URL",
  "VOLLEY_AUTH_DIR",
] as const;

/**
 * The broker-login keys an entry carries (#614): `VOLLEY_AUTH_USERNAME`, `VOLLEY_AUTH_PASSWORD`,
 * and a `VOLLEY_BROKER_URL` with `user:password@` in it. Names only, never a value.
 */
export function loginKeys(env: Record<string, unknown>): string[] {
  const keys = ["VOLLEY_AUTH_USERNAME", "VOLLEY_AUTH_PASSWORD"].filter((k) => k in env);
  const url = env.VOLLEY_BROKER_URL;
  if (typeof url === "string" && withoutLogin(url).dropped) keys.push("VOLLEY_BROKER_URL");
  return keys.sort();
}

/** The keys of the person's own: outside `MCP_ENV_KEYS` and not a login, or another agent id. */
export function ownKeys(env: Record<string, unknown>): string[] {
  const login = loginKeys(env);
  const theirs = Object.keys(env).filter(
    (k) => !(MCP_ENV_KEYS as readonly string[]).includes(k) && !login.includes(k),
  );
  const ownId = typeof env.VOLLEY_AGENT_ID === "string" && env.VOLLEY_AGENT_ID !== "coordinator";
  return [...theirs, ...(ownId ? ["VOLLEY_AGENT_ID"] : [])].sort();
}

/** The username an entry's login names (its `VOLLEY_AUTH_USERNAME`, else its URL's user). */
function loginUser(env: Record<string, unknown>): string | null {
  if (typeof env.VOLLEY_AUTH_USERNAME === "string") return env.VOLLEY_AUTH_USERNAME;
  const url = env.VOLLEY_BROKER_URL;
  const m = typeof url === "string" ? /^[a-z]+:\/\/([^/:@]*)(?::[^/@]*)?@/i.exec(url) : null;
  return m?.[1] !== undefined && m[1] !== "" ? decodeURIComponent(m[1]) : null;
}

function hasCoordinatorLogin(path: string): boolean {
  try {
    return readCredentials(path) !== null;
  } catch {
    return false;
  }
}

function readAccountsQuietly(dir: string): Account[] {
  try {
    return readAccounts(dir);
  } catch {
    return [];
  }
}

export const MCP_GET = ["claude", "mcp", "get", "volley"] as const;
export const MCP_REMOVE = ["claude", "mcp", "remove", "-s", "user", "volley"] as const;
export const mcpAddArgv = (json: string) => [
  "claude",
  "mcp",
  "add-json",
  "-s",
  "user",
  "volley",
  json,
];

/** `coord-<this machine's name, slugged>`, within the agent-id grammar. */
export function defaultCoordinator(host: string): string {
  const slug = host
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/, "");
  return slug === "" ? "coord-main" : `coord-${slug}`;
}

export const COORDINATOR_QUESTION = (dflt: string) => `Coordinator name [${dflt}]: `;

/** The registration's JSON: `bun run <checkout>/packages/volley-mcp/src/index.ts`, env without a secret. */
export function mcpRegistration(
  ctx: SetupContext,
  repo: string,
  coordinator: string,
): { type: string; command: string; args: string[]; env: Record<string, string> } {
  return {
    type: "stdio",
    command: ctx.deps.bun,
    args: ["run", join(repo, "packages", "volley-mcp", "src", "index.ts")],
    env: {
      VOLLEY_AGENT_ID: "coordinator",
      VOLLEY_COORDINATOR: coordinator,
      VOLLEY_NAMESPACE: SETUP_NAMESPACE,
      VOLLEY_BROKER_URL: withoutLogin(ctx.tcpUrl).url,
      VOLLEY_AUTH_DIR: ctx.auth.dir,
    },
  };
}

const sq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

async function must(
  ctx: SetupContext,
  argv: readonly string[],
  env?: Record<string, string | undefined>,
) {
  const r = await ctx.deps.exec(argv, env !== undefined ? { env } : undefined);
  if (r.code !== 0) {
    // Never the argv itself: an add-json carries the registration (no secret, but long).
    throw new Error(
      `\`${argv.slice(0, 4).join(" ")}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
    );
  }
  return r;
}

/** Ask for the name until it is in the grammar (Enter takes the default; nobody there: the default). */
async function askName(ctx: SetupContext, dflt: string): Promise<string> {
  const ask = ctx.deps.ask;
  if (ask === undefined || ctx.yes || ctx.check === true || !ctx.deps.interactive) return dflt;
  for (let tries = 0; tries < 3; tries++) {
    const a = await ask(COORDINATOR_QUESTION(dflt));
    if (a === null || a === "") return dflt;
    if (COORDINATOR_NAME.test(a)) return a;
    ctx.auth.io.stdout(
      `  A coordinator name is lowercase letters, digits, - and _ (at most 63, starting with a letter or digit): ${JSON.stringify(a)} is not one.\n`,
    );
  }
  return dflt;
}

const skillWhy = (s: SkillFact) =>
  s.state === "absent"
    ? `${s.name}: not installed`
    : s.state === "broken"
      ? `${s.name}: a broken link`
      : s.state === "elsewhere"
        ? `${s.name}: links to another folder`
        : `${s.name}: a folder of its own (backed up, not replaced)`;

export async function planClaudeCode(ctx: SetupContext): Promise<StepPlan> {
  const plan: StepPlan = { step: "claude-code", title: "Claude Code", found: [], changes: [] };
  if (ctx.auth.deps.invokingUser(ctx.auth.env) !== null) {
    plan.skipped =
      "running as root, and Claude Code's settings are your user's: run `volley setup --step claude-code` as that user (without sudo)";
    return plan;
  }
  const repo = ctx.deps.repoRoot;
  if (repo === null) {
    plan.blocked =
      "no Volley checkout found (bun.lock's directory): run `volley setup` from the checkout `install.sh` made";
    return plan;
  }
  const rows: string[] = [];

  // `--peer`: this machine's profile only (its agents' skills and hooks): coordinator sessions,
  // and so the coordinator name and the MCP registration, are the supervisor's machine's.
  if (ctx.peer !== true) {
    // The coordinator name: chosen once, then kept.
    const saved = readSetupInstall(ctx.volleydHome)?.coordinator ?? ctx.coordinator;
    let name: string;
    if (saved !== undefined) {
      name = saved;
      ctx.coordinator = saved;
      plan.found.push(`Coordinator name: ${name} (from setup.json)`);
      rows.push(`✓ coordinator: ${name}`);
    } else {
      const dflt = defaultCoordinator((ctx.deps.hostname ?? osHostname)());
      // Asked while planning, before the step's confirmation, on purpose: the name feeds the MCP
      // registration's diff below. A run that then declines the step was still asked.
      name = await askName(ctx, dflt);
      rows.push("coordinator: not chosen yet");
      plan.changes.push({
        summary: `Save the coordinator name ${name} (setup.json: VOLLEY_COORDINATOR for this machine's sessions and commands)`,
        apply: async () => {
          ctx.coordinator = name;
          writeSetupInstall(ctx);
          return [
            `Coordinator name: ${name}. Waves submitted here are owned by it (\`volleyd run\` without --owner).`,
          ];
        },
      });
    }

    // The volley MCP server: non-secret env only.
    const want = mcpRegistration(ctx, repo, name);
    const add = mcpAddArgv(JSON.stringify(want));
    const claudeJson = join(ctx.home, ".claude.json");
    // undefined: the file is there but not a JSON object; null: no volley entry.
    const entry = existsSync(claudeJson) ? volleyEntryIn(claudeJson) : null;
    const register = (why: string, replace: boolean) =>
      plan.changes.push({
        summary: `${replace ? "Re-register" : "Register"} the volley MCP server with Claude Code (${why}; no password in it)`,
        detail: `Runs ${replace ? `\`${MCP_REMOVE.join(" ")}\`, then ` : ""}\`claude mcp add-json -s user volley …\` with env ${Object.entries(
          want.env,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}. The login comes from ${join(ctx.auth.dir, "coordinator.json")}.`,
        apply: async () => {
          if (replace) await must(ctx, MCP_REMOVE);
          await must(ctx, add);
          return [
            `The volley MCP server runs ${want.args[1]} at ${want.env.VOLLEY_BROKER_URL} (restart Claude Code sessions to pick it up).`,
          ];
        },
      });
    if (entry === undefined) {
      plan.found.push(`${claudeJson} cannot be read: the MCP registration is left as is`);
      rows.push("MCP: ~/.claude.json cannot be read");
    } else if (entry === null) {
      rows.push("MCP: volley is not registered");
      register("new", false);
    } else {
      const env = (typeof entry.env === "object" && entry.env !== null ? entry.env : {}) as Record<
        string,
        unknown
      >;
      const login = loginKeys(env);
      const own = ownKeys(env);
      const loginNames = login.map((k) =>
        k === "VOLLEY_BROKER_URL" ? "VOLLEY_BROKER_URL (user:password@)" : k,
      );
      if (own.length > 0) {
        // The person's own settings: never rewritten here; their names only (a login among them
        // too: setup does not guess what a custom key is for).
        const named = [...own, ...login].sort();
        plan.found.push(
          `The volley MCP server has settings of its own (${named.join(", ")}): left as is. To register it the way setup does (its login from the auth dir, no password in ~/.claude.json): ${[...MCP_REMOVE].map(sq).join(" ")} && ${add.map(sq).join(" ")}`,
        );
        rows.push(`MCP: volley has settings of its own (${named.join(", ")}): left as is`);
      } else if (login.length > 0) {
        // A broker login in ~/.claude.json: moved to the store, as any other change (#614).
        const coordinatorFile = join(ctx.auth.dir, "coordinator.json");
        const carries = `MCP: volley carries a broker login in ~/.claude.json (${loginNames.join(", ")})`;
        if (!hasCoordinatorLogin(coordinatorFile)) {
          plan.found.push(
            `The volley MCP server (${loginNames.join(", ")}) carries a broker login; run volley setup --step accounts first, then this step moves it`,
          );
          rows.push(`${carries}: to move once the accounts step has run`);
        } else {
          rows.push(`${carries}: to move`);
          const was = loginUser(env);
          const other = was !== null && was !== "coordinator" ? was : null;
          const rotate =
            other !== null && readAccountsQuietly(ctx.auth.dir).some((a) => a.name === other);
          plan.changes.push({
            summary: `Move the broker login out of ~/.claude.json (${loginNames.join(", ")}): re-register the volley MCP server with its login from ${coordinatorFile}${other !== null ? `; the session will log in as coordinator (it was ${other})` : ""}`,
            detail: `Runs \`${MCP_REMOVE.join(" ")}\`, then \`claude mcp add-json -s user volley …\` with env ${Object.entries(
              want.env,
            )
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")}.`,
            apply: async () => {
              await must(ctx, MCP_REMOVE);
              await must(ctx, add);
              return [
                `The volley MCP server runs ${want.args[1]} at ${want.env.VOLLEY_BROKER_URL}, its login from ${coordinatorFile} (restart Claude Code sessions to pick it up).`,
                ...(rotate
                  ? [
                      `The old login is still ${other}'s password on the broker: volley auth rotate ${other} retires it.`,
                    ]
                  : []),
              ];
            },
          });
        }
      } else {
        const args = Array.isArray(entry.args) ? entry.args : [];
        const runs =
          typeof entry.command === "string" &&
          /(^|\/)bun$/.test(entry.command) &&
          args.some((a) => typeof a === "string" && realOf(a) === realOf(want.args[1] as string));
        const differs = runs
          ? MCP_ENV_KEYS.filter((k) => env[k] !== want.env[k])
          : ["the checkout it runs"];
        if (differs.length === 0) {
          plan.found.push(`The volley MCP server is registered at ${want.env.VOLLEY_BROKER_URL}`);
          rows.push(`✓ MCP: volley registered (${want.env.VOLLEY_BROKER_URL}, no secret)`);
        } else {
          rows.push(`MCP: volley differs (${differs.join(", ")})`);
          register(`${differs.join(", ")} ${differs.length === 1 ? "differs" : "differ"}`, true);
        }
      }
    }
  }

  // The skills, through their own installers (each backs a folder of its own up).
  const skills = VOLLEY_SKILLS.map(({ name: skill, pkg }): SkillFact => {
    const at = join(ctx.home, ".claude", "skills", skill);
    const dir = join(repo, "packages", pkg);
    return {
      name: skill,
      at,
      pkg: dir,
      installer: join(dir, "scripts", "install.sh"),
      state: skillState(at, dir),
    };
  });
  const bad = skills.filter((s) => s.state !== "linked");
  if (bad.length === 0) {
    plan.found.push(`Skills ${skills.map((s) => s.name).join(", ")} link to this checkout`);
    rows.push(`✓ skills: ${skills.map((s) => s.name).join(", ")}`);
  } else {
    rows.push(`skills: ${bad.map(skillWhy).join("; ")}`);
    plan.changes.push({
      summary: `Link the Volley skills into ~/.claude/skills (${bad.map(skillWhy).join("; ")})`,
      detail: bad.map((s) => `Runs \`bash ${s.installer}\``).join("\n"),
      apply: async () => {
        const lines: string[] = [];
        for (const s of bad) {
          await must(ctx, ["bash", s.installer], { ...ctx.auth.env, HOME: ctx.home });
          lines.push(`${s.at} → ${s.pkg}`);
        }
        return lines;
      },
    });
  }

  // The hooks (the Services step plans the same install: whichever runs first makes it).
  const hooks = await planHooks(ctx, repo);
  if ("blocked" in hooks) {
    plan.blocked = hooks.blocked;
    return plan;
  }
  if ("change" in hooks) {
    rows.push("hooks: not installed");
    plan.changes.push(hooks.change);
  } else {
    plan.found.push(hooks.found);
    rows.push("✓ hooks: installed");
  }

  plan.row = rows.join("\n");
  plan.verify = async () => {
    const again = await planClaudeCode({ ...ctx, check: true });
    return [
      ...(again.blocked !== undefined ? [again.blocked] : []),
      ...again.changes.map((c) => `still not in place: ${c.summary}`),
    ];
  };
  return plan;
}
