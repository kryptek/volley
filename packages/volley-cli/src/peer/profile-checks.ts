import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * What a Claude Code profile needs for Volley, read the same way by `volley peer doctor`'s
 * profile checks (provision.ts) and `volley setup`'s Claude Code step: the skills linked to this
 * checkout, the hooks' broker URL, the volley MCP entry in a Claude config file. Reads only:
 * nothing here writes, and no value from an MCP entry's env is ever returned whole.
 */

/** The skills this checkout installs: `~/.claude/skills/<name>` → `packages/<pkg>`. */
export const VOLLEY_SKILLS = [
  { name: "volley", pkg: "volley-skill" },
  { name: "volley-issues", pkg: "volley-issues" },
  { name: "volley-wait", pkg: "volley-wait" },
] as const;

export interface SkillFact {
  name: string;
  /** `~/.claude/skills/<name>`. */
  at: string;
  pkg: string;
  installer: string;
  /**
   * linked: resolves to `pkg`; elsewhere: a link to another folder; broken: a link to nothing;
   * stray: a folder of its own.
   */
  state: "linked" | "elsewhere" | "broken" | "stray" | "absent";
}

export const realOf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export function skillState(at: string, pkg: string): SkillFact["state"] {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(at);
  } catch {
    return "absent";
  }
  if (!st.isSymbolicLink()) return "stray";
  if (!existsSync(at)) return "broken";
  return realOf(at) === realOf(pkg) ? "linked" : "elsewhere";
}

/** `url` without a login (`user:pw@`), and whether it had one. */
export function withoutLogin(url: string): { url: string; dropped: boolean } {
  const m = /^([a-z]+:\/\/)[^/@]*@(.*)$/i.exec(url);
  return m === null ? { url, dropped: false } : { url: `${m[1]}${m[2]}`, dropped: true };
}

/** The broker URL the Volley hooks in `settings` carry (`VOLLEY_BROKER_URL=<url>` in their prefix). */
export const installedBrokerUrl = (settings: string) =>
  installedPrefix(settings, "VOLLEY_BROKER_URL");

/** A variable the Volley hooks in `settings` carry in their prefix (`<name>=<value>`). */
export function installedPrefix(settings: string, name: string): string | null {
  let j: { hooks?: unknown; statusLine?: { command?: unknown } };
  try {
    j = JSON.parse(settings);
  } catch {
    return null;
  }
  const commands: unknown[] = [j?.statusLine?.command];
  if (typeof j?.hooks === "object" && j.hooks !== null) {
    for (const groups of Object.values(j.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        const hs = (g as { hooks?: unknown } | null)?.hooks;
        for (const h of Array.isArray(hs) ? hs : []) {
          commands.push((h as { command?: unknown } | null)?.command);
        }
      }
    }
  }
  for (const c of commands) {
    if (typeof c !== "string" || !c.includes("/volley-hooks/src/")) continue;
    const m = new RegExp(`^(?:[A-Z_]+=\\S* )*?${name}=(\\S+) `).exec(c);
    if (m !== null) return m[1] as string;
  }
  return null;
}

/** The tail of a volley-mcp entry path after the checkout. */
export const MCP_TAIL = "/packages/volley-mcp/src/index.ts";

/** The arg naming a volley-mcp entry (any checkout's), and that checkout. */
export function volleyMcpArg(args: unknown): { arg: string; ran: string } | null {
  if (!Array.isArray(args)) return null;
  const arg = args.find((a): a is string => typeof a === "string" && a.endsWith(MCP_TAIL));
  return arg !== undefined ? { arg, ran: arg.slice(0, -MCP_TAIL.length) } : null;
}

/** `mcpServers.volley` in a Claude config file: undefined when the file cannot be read. */
export function volleyEntryIn(file: string): Record<string, unknown> | null | undefined {
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return undefined;
  const servers = (j as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== "object" || servers === null) return null;
  const v = Object.hasOwn(servers, "volley") ? (servers as { volley: unknown }).volley : null;
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}
