import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runAgent } from "./agent";
import { type Env, isSimulated, passThrough, simHome } from "./env";
import type { Ctx, Out } from "./gh";
import { appendUnknown, withWorld } from "./world";

/**
 * The fake Claude Code CLI. `--version`, `auth status | login | logout` (a sign-in per profile,
 * kept in the world file), `mcp add-json | list | get | remove` (kept in the profile's
 * `.claude.json` the way Claude Code keeps them and `volley peer`'s provision.ts reads them), and
 * the agent launch volleyd's `.volley/launch.sh` makes — in a worktree holding
 * `.volley/agent.json` — which runs the simulated agent (agent.ts). Any other argv exits 1 with
 * `unknown argv` and is appended to `$VOLLEY_SIM_HOME/unknown.jsonl`.
 */

/** The version `claude --version` reports. */
export const CLAUDE_VERSION = "2.1.0";

const ok = (stdout = "", stderr = ""): Out => ({ code: 0, stdout, stderr });
const fail = (stderr: string): Out => ({ code: 1, stdout: "", stderr: `${stderr}\n` });

/** The profile's config dir (`CLAUDE_CONFIG_DIR`, else the home) and its sign-in key. */
function profile(env: Env): { dir: string; key: string } {
  const set = env.CLAUDE_CONFIG_DIR;
  if (set !== undefined && set !== "") return { dir: resolve(set), key: resolve(set) };
  return { dir: env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir(), key: "default" };
}

type Json = Record<string, unknown>;

const readJson = (p: string): Json => {
  if (!existsSync(p)) return {};
  const j = JSON.parse(readFileSync(p, "utf8")) as unknown;
  return typeof j === "object" && j !== null && !Array.isArray(j) ? (j as Json) : {};
};
const writeJson = (p: string, j: Json) => writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
const serversOf = (holder: unknown): Json => {
  const s = (holder as { mcpServers?: unknown } | null | undefined)?.mcpServers;
  return typeof s === "object" && s !== null && !Array.isArray(s) ? (s as Json) : {};
};

type Scope = "user" | "local" | "project";
const SCOPES: Scope[] = ["local", "project", "user"];
const SCOPE_LABEL: Record<Scope, string> = {
  local: "Local config (private to you in this project)",
  project: "Project config (shared via .mcp.json)",
  user: "User config (available in all your projects)",
};

/** Read and write one scope's `mcpServers` (user: `.claude.json`; local: its project entry). */
function scopeStore(env: Env, cwd: string, scope: Scope) {
  const claudeJson = join(profile(env).dir, ".claude.json");
  if (scope === "project") {
    const p = join(cwd, ".mcp.json");
    return {
      file: p,
      get: () => serversOf(readJson(p)),
      set: (servers: Json) => writeJson(p, { ...readJson(p), mcpServers: servers }),
    };
  }
  if (scope === "user")
    return {
      file: claudeJson,
      get: () => serversOf(readJson(claudeJson)),
      set: (servers: Json) =>
        writeJson(claudeJson, { ...readJson(claudeJson), mcpServers: servers }),
    };
  const project = (j: Json) => ((j.projects as Json | undefined)?.[cwd] ?? {}) as Json;
  return {
    file: claudeJson,
    get: () => serversOf(project(readJson(claudeJson))),
    set: (servers: Json) => {
      const j = readJson(claudeJson);
      const projects = (j.projects ?? {}) as Json;
      writeJson(claudeJson, {
        ...j,
        projects: { ...projects, [cwd]: { ...project(j), mcpServers: servers } },
      });
    },
  };
}

/** `-s|--scope <s>` and the positionals; null on any other flag. */
function scopeArgs(rest: string[]): { scope: Scope | null; pos: string[] } | null {
  let scope: Scope | null = null;
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "-s" || a === "--scope") {
      const v = rest[++i];
      if (v !== "user" && v !== "local" && v !== "project") return null;
      scope = v;
    } else if (a.startsWith("--scope=")) {
      const v = a.slice("--scope=".length);
      if (v !== "user" && v !== "local" && v !== "project") return null;
      scope = v;
    } else if (a.startsWith("-")) return null;
    else pos.push(a);
  }
  return { scope, pos };
}

const describe = (e: unknown): string => {
  const { command, args, url, type } = (e ?? {}) as Json;
  if (typeof url === "string") return `${url} (${type === "sse" ? "SSE" : "HTTP"})`;
  return [command, ...(Array.isArray(args) ? args : [])]
    .filter((x) => typeof x === "string")
    .join(" ");
};

function mcp(rest: string[], ctx: Ctx): Out | null {
  const [verb, ...more] = rest;
  const parsed = scopeArgs(more);
  if (parsed === null) return null;
  const { scope, pos } = parsed;
  const home = simHome(ctx.env);
  switch (verb) {
    case "add-json": {
      if (pos.length !== 2) return null;
      const [name, raw] = pos as [string, string];
      let entry: unknown;
      try {
        entry = JSON.parse(raw);
      } catch (e) {
        return fail(`Error: Invalid JSON: ${(e as Error).message}`);
      }
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        return fail("Error: Invalid configuration: expected an object");
      const s = scope ?? "local";
      return withWorld(home, () => {
        const store = scopeStore(ctx.env, ctx.cwd, s);
        store.set({ ...store.get(), [name]: entry });
        const kind = (entry as Json).url !== undefined ? "http" : "stdio";
        return ok(
          `Added ${kind} MCP server ${name} to ${s} config\nFile modified: ${store.file}\n`,
        );
      });
    }
    case "list": {
      if (pos.length !== 0 || scope !== null) return null;
      const all = SCOPES.flatMap((s) => Object.entries(scopeStore(ctx.env, ctx.cwd, s).get()));
      if (all.length === 0)
        return ok("No MCP servers configured. Use `claude mcp add` to add a server.\n");
      return ok(
        `Checking MCP server health...\n\n${all.map(([n, e]) => `${n}: ${describe(e)} - ✓ Connected\n`).join("")}`,
      );
    }
    case "get": {
      if (pos.length !== 1 || scope !== null) return null;
      const name = pos[0] as string;
      for (const s of SCOPES) {
        const e = scopeStore(ctx.env, ctx.cwd, s).get()[name] as Json | undefined;
        if (e === undefined) continue;
        const lines = [
          `${name}:`,
          `  Scope: ${SCOPE_LABEL[s]}`,
          "  Status: ✓ Connected",
          `  Type: ${typeof e.url === "string" ? "http" : "stdio"}`,
          ...(typeof e.command === "string" ? [`  Command: ${e.command}`] : []),
          ...(Array.isArray(e.args) ? [`  Args: ${e.args.join(" ")}`] : []),
          ...(typeof e.url === "string" ? [`  URL: ${e.url}`] : []),
        ];
        return ok(`${lines.join("\n")}\n`);
      }
      return fail(`No MCP server found with name: ${name}`);
    }
    case "remove": {
      if (pos.length !== 1) return null;
      const name = pos[0] as string;
      return withWorld(home, () => {
        for (const s of scope !== null ? [scope] : SCOPES) {
          const store = scopeStore(ctx.env, ctx.cwd, s);
          const servers = store.get();
          if (!Object.hasOwn(servers, name)) continue;
          const { [name]: _, ...kept } = servers;
          store.set(kept);
          return ok(`Removed MCP server ${name} from ${s} config\nFile modified: ${store.file}\n`);
        }
        return fail(
          scope !== null
            ? `No ${scope}-scoped MCP server found with name: ${name}`
            : `No MCP server found with name: "${name}"`,
        );
      });
    }
    default:
      return null;
  }
}

/** The sign-in a profile has once `claude auth login` ran (what `auth status` reports). */
const SIGNED_IN = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "sim@volley.invalid",
  orgName: "Volley Sim",
  subscriptionType: "max",
};

function auth(rest: string[], ctx: Ctx): Out | null {
  const [verb, ...more] = rest;
  const home = simHome(ctx.env);
  const p = profile(ctx.env);
  switch (verb) {
    case "status": {
      if (more.some((a) => a !== "--json" && a !== "--text")) return null;
      const signedIn = withWorld(home, (w) => w.claude.logins[p.key] === true);
      if (more.includes("--text"))
        return signedIn
          ? ok(`Logged in as ${SIGNED_IN.email} (${SIGNED_IN.orgName})\n`)
          : { code: 1, stdout: "Not logged in\n", stderr: "" };
      return signedIn
        ? ok(`${JSON.stringify(SIGNED_IN, null, 2)}\n`)
        : {
            code: 1,
            stdout: `${JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }, null, 2)}\n`,
            stderr: "",
          };
    }
    case "login": {
      if (more.length !== 0) return null;
      return withWorld(home, (w) => {
        w.claude.logins[p.key] = true;
        // What a finished sign-in records in the profile's .claude.json.
        const file = join(p.dir, ".claude.json");
        if (existsSync(p.dir))
          writeJson(file, {
            ...readJson(file),
            hasCompletedOnboarding: true,
            lastOnboardingVersion: CLAUDE_VERSION,
            oauthAccount: {
              emailAddress: SIGNED_IN.email,
              organizationName: SIGNED_IN.orgName,
              accountUuid: "00000000-0000-4000-8000-000000000000",
            },
          });
        return ok("Login successful.\n");
      });
    }
    case "logout": {
      if (more.length !== 0) return null;
      return withWorld(home, (w) => {
        delete w.claude.logins[p.key];
        return ok("Successfully logged out from your Anthropic account.\n");
      });
    }
    default:
      return null;
  }
}

/** Answer one `claude` argv (without `claude`); an agent launch runs the simulated agent. */
export async function runClaude(argv: string[], ctx: Ctx): Promise<Out> {
  const unknown = (): Out => {
    appendUnknown(simHome(ctx.env), ["claude", ...argv], ctx.cwd);
    return fail(`unknown argv: claude ${argv.join(" ")}`);
  };
  const [first, ...rest] = argv;
  let r: Out | null = null;
  if (argv.length === 1 && (first === "--version" || first === "-v"))
    r = ok(`${CLAUDE_VERSION} (Claude Code)\n`);
  else if (first === "auth") r = auth(rest, ctx);
  else if (first === "mcp") r = mcp(rest, ctx);
  else if (existsSync(join(ctx.cwd, ".volley", "agent.json"))) {
    const code = await runAgent({
      cwd: ctx.cwd,
      env: ctx.env,
      argv,
      linger: ctx.env.VOLLEY_SIM_AGENT_LINGER !== "0",
    });
    r = { code, stdout: "", stderr: "" };
  }
  return r ?? unknown();
}

/** `bin/claude`: answer from the world under `VOLLEY_SIMULATED=1`, else run the real claude. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (!isSimulated()) return passThrough("claude", argv);
  const r = await runClaude(argv, { cwd: process.cwd(), env: process.env });
  if (r.stdout !== "") process.stdout.write(r.stdout);
  if (r.stderr !== "") process.stderr.write(r.stderr);
  return r.code;
}
