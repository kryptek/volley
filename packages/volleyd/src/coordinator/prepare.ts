import { chmodSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn, ExecResult } from "../exec";
import type { CoordinatorToken, RemoteStep } from "../fence";
import type { Host } from "../hosts/host";
import { LocalTmuxHost } from "../hosts/local-tmux";
import type { RemoteHost } from "../hosts/ssh-tmux";
import { HOOKS_DIR, MCP_ENTRY } from "../launch";
import { recordRepoTrust } from "../trust";
import { COORDINATOR_FILES, coordinatorRepoLink } from "./role";

/**
 * The coordinator directory's artefacts (SPEC §4.6.25), written on its machine before a start:
 * the sealed `.volley/coordinator.sh`, the coordinator login (`.volley/auth/coordinator.json`,
 * 0600), `.mcp.json` (the `volley` server), `.claude/settings.json` (the project's MCP servers
 * load without a prompt), the folder-trust record and `repos/<owner>/<name>` links to the
 * machine's checkouts. On a paired machine each is a fenced REMOTE step under the script token.
 */
export interface CoordinatorDirPlan {
  dir: string;
  script: string;
  /** The coordinator login file's text, as the supervisor holds it. */
  login: string;
  mcp: string;
  settings: string;
  /** Each repository the machine holds a clone of, and that clone's absolute path there. */
  links: { slug: string; target: string }[];
}

/** One machine the coordinator can run on, as the runner drives it (local or paired). */
export interface CoordinatorTarget {
  /** `local`, or the paired machine's name. */
  readonly machine: string;
  /** Its tmux adapter: launch (with LaunchSpec.coordinator), findWorkspace, readScreen. */
  readonly host: Host;
  /** `$VOLLEY_HOOKS_DIR` there, its volley-mcp entry, and its broker port on the loopback. */
  readonly hooksDir: string;
  readonly mcpEntry: string;
  readonly brokerPort: number;
  /** The machine's home directory (`~` in `coordinator.dir` and `~/.volley/bin`). */
  home(): Promise<string>;
  /** Write the directory's artefacts (the plan), under the script token. */
  prepare(plan: CoordinatorDirPlan, token: CoordinatorToken): Promise<void>;
  /** End the coordinator's session (a kill token); one already gone is no error. */
  kill(session: string, token: CoordinatorToken): Promise<void>;
}

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
const write = (path: string, text: string): RemoteStep => ({
  argv: ["base64", "-d"],
  stdin: b64(text),
  stdout: path,
});

/** tmux's answer for a session (or server) that is not there. */
const GONE = /can't find session|session not found|no server running|error connecting to/i;

/** A paired machine through its ssh adapter: every artefact one fenced `bash -s` run. */
export function remoteTarget(host: RemoteHost): CoordinatorTarget {
  const ran = async (steps: RemoteStep[], what: string, token: CoordinatorToken) => {
    const r: ExecResult = await host.run(steps, { coordinator: token });
    if (r.code !== 0)
      throw new Error(`${what} on ${host.name}: ${r.stderr.trim() || `exit ${r.code}`}`);
  };
  return {
    machine: host.name,
    host,
    hooksDir: host.hooksDir,
    mcpEntry: host.mcpEntry,
    brokerPort: host.spec.tunnel.remote_port,
    async home() {
      const r = await host.run([{ argv: ["printenv", "HOME"] }]);
      const home = r.code === 0 ? r.stdout.trim() : "";
      if (!home.startsWith("/") || home.includes("\n"))
        throw new Error(
          `no home directory on ${host.name}: ${r.stderr.trim() || `exit ${r.code}`}`,
        );
      return home;
    },
    async prepare(plan, token) {
      const { dir } = plan;
      const file = (rel: string) => posix.join(dir, rel);
      const parents = [
        ...new Set([
          posix.dirname(file(COORDINATOR_FILES.login)),
          posix.dirname(file(COORDINATOR_FILES.settings)),
          ...plan.links.map((l) => posix.dirname(coordinatorRepoLink(dir, l.slug))),
        ]),
      ];
      await ran([{ argv: ["mkdir", "-p", ...parents] }], `mkdir ${dir}`, token);
      await ran([write(file(COORDINATOR_FILES.script), plan.script)], "coordinator.sh", token);
      await ran(
        [
          write(file(COORDINATOR_FILES.login), plan.login),
          { argv: ["chmod", "600", file(COORDINATOR_FILES.login)] },
        ],
        "the coordinator login",
        token,
      );
      await ran([write(file(COORDINATOR_FILES.mcp), plan.mcp)], ".mcp.json", token);
      await ran([write(file(COORDINATOR_FILES.settings), plan.settings)], "settings.json", token);
      if (plan.links.length > 0)
        await ran(
          plan.links.map((l) => ({
            argv: ["ln", "-sfn", l.target, coordinatorRepoLink(dir, l.slug)],
          })),
          "the repository links",
          token,
        );
      // Written before the first start: an untrusted folder asks on the server's screen.
      await host.recordTrust(dir);
    },
    async kill(session, token) {
      const r = await host.run([{ argv: ["tmux", "kill-session", "-t", `=${session}`] }], {
        coordinator: token,
      });
      if (r.code !== 0 && !GONE.test(r.stderr))
        throw new Error(
          `tmux kill-session on ${host.name}: ${r.stderr.trim() || `exit ${r.code}`}`,
        );
    },
  };
}

/**
 * This machine: the files written directly (0600 for the login), trust recorded in the profile's
 * `.claude.json` (`claudeJsonPath`), and tmux through the fenced exec (`LocalTmuxHost`): the
 * coordinator uses tmux on every machine, whatever `fleet.local_terminal` is.
 */
export function localTarget(o: {
  exec: ExecFn;
  brokerPort: number;
  claudeJsonPath: string;
  home?: string;
  host?: Host;
  hooksDir?: string;
  mcpEntry?: string;
}): CoordinatorTarget {
  const host = o.host ?? new LocalTmuxHost(o.exec);
  return {
    machine: "local",
    host,
    hooksDir: o.hooksDir ?? HOOKS_DIR,
    mcpEntry: o.mcpEntry ?? MCP_ENTRY,
    brokerPort: o.brokerPort,
    async home() {
      return o.home ?? process.env.HOME ?? homedir();
    },
    async prepare(plan) {
      const { dir } = plan;
      const file = (rel: string) => posix.join(dir, rel);
      for (const rel of Object.values(COORDINATOR_FILES))
        mkdirSync(posix.dirname(file(rel)), { recursive: true, mode: 0o700 });
      writeFileSync(file(COORDINATOR_FILES.script), plan.script);
      rmSync(file(COORDINATOR_FILES.login), { force: true });
      writeFileSync(file(COORDINATOR_FILES.login), plan.login, { mode: 0o600 });
      chmodSync(file(COORDINATOR_FILES.login), 0o600);
      writeFileSync(file(COORDINATOR_FILES.mcp), plan.mcp);
      writeFileSync(file(COORDINATOR_FILES.settings), plan.settings);
      for (const l of plan.links) {
        const link = coordinatorRepoLink(dir, l.slug);
        mkdirSync(posix.dirname(link), { recursive: true });
        if (isLink(link)) rmSync(link);
        symlinkSync(l.target, link);
      }
      recordRepoTrust(o.claudeJsonPath, dir);
    },
    async kill(session, token) {
      const r = await o.exec(["tmux", "kill-session", "-t", `=${session}`], {
        coordinator: token,
        timeoutMs: DAEMON_DEFAULTS.workspace_close_timeout_ms,
      });
      if (r.code !== 0 && !GONE.test(r.stderr))
        throw new Error(`tmux kill-session: ${r.stderr.trim() || `exit ${r.code}`}`);
    },
  };
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
