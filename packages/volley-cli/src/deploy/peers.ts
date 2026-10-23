import { pairedHosts } from "volleyd/paired-hosts";
import { PEER_DEFAULTS } from "../commands/peer";
import type { ExecResult } from "../setup/step";
import { currentRef, lastLine, q } from "./apply";
import { type PairedPeer, peerFence } from "./fence";
import {
  type Command,
  RECORD_LOCK_ARGV,
  RESTART_PEER_ARGV,
  type Ref,
  git,
  parseDirty,
  peerDoctorArgv,
  refLabel,
} from "./plan";

export type { PairedPeer } from "./fence";
export { RECORD_LOCK_ARGV, RESTART_PEER_ARGV } from "./plan";

/**
 * `volley deploy` on the paired machines, after the supervisor's own deploy passed its health
 * check: on each machine over its ssh target, in its volley checkout, fetch tags, check the tag
 * out, `bun install --frozen-lockfile` and record the lock it installed from, restart `volley peer
 * run`, and run the machine's doctor. A machine that fails a step after its checkout goes back to
 * the ref it was at (checkout, install, restart); the others, and the supervisor, stay on the tag.
 */

/** Runs one command on the machine (the real one: `sshCommand` through the deploy's exec). */
export type PeerRemote = (c: Command) => Promise<ExecResult>;

export type PeerStepId = "status" | "fetch" | "checkout" | "install" | "restart" | "doctor";

export interface PeerStep {
  id: PeerStepId;
  title: string;
  commands: Command[];
}

/** The paired machines from volleyd's records (`$VOLLEYD_HOME`), and the ones it cannot reach. */
export function pairedPeers(home: string): {
  peers: PairedPeer[];
  problems: { name: string; why: string }[];
} {
  const { hosts, problems } = pairedHosts(home);
  return {
    peers: hosts.map((h) => ({ name: h.name, target: h.target, volleyDir: h.volley_dir })),
    problems,
  };
}

/** One command on `target`: `ssh -T <target> bash -s` with the command, quoted, on stdin. */
export function sshCommand(target: string, c: Command): { argv: string[]; input: string } {
  return {
    argv: [
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${PEER_DEFAULTS.ssh_connect_timeout_s}`,
      "-o",
      `ServerAliveInterval=${PEER_DEFAULTS.ssh_alive_interval_s}`,
      "-o",
      `ServerAliveCountMax=${PEER_DEFAULTS.ssh_alive_count_max}`,
      target,
      "bash",
      "-s",
    ],
    input: `${c.cwd !== undefined ? `cd ${q(c.cwd)} && ` : ""}${c.argv.map(q).join(" ")}\n`,
  };
}

/** A machine's steps to `target`: forward (fetch, doctor) or a rollback (neither). */
export function peerPlan(
  peer: PairedPeer,
  target: Ref,
  opts: { fetch: boolean; doctor: boolean },
): PeerStep[] {
  const dir = peer.volleyDir;
  const steps: PeerStep[] = [];
  if (opts.fetch) {
    steps.push({
      id: "fetch",
      title: "fetch tags",
      commands: [{ argv: git(dir, "fetch", "--tags", "origin") }],
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
              ? git(dir, "checkout", target.name, "--")
              : git(dir, "checkout", "--detach", target.name),
        },
      ],
    },
    {
      id: "install",
      title: "bun install --frozen-lockfile",
      commands: [
        { argv: ["bun", "install", "--frozen-lockfile"], cwd: dir },
        { argv: [...RECORD_LOCK_ARGV], cwd: dir },
      ],
    },
    {
      id: "restart",
      title: "restart volley peer run",
      commands: [{ argv: [...RESTART_PEER_ARGV] }],
    },
  );
  if (opts.doctor) {
    steps.push({
      id: "doctor",
      title: "volley peer doctor",
      commands: [{ argv: peerDoctorArgv(dir), cwd: dir }],
    });
  }
  return steps;
}

export interface PeerResult {
  name: string;
  /** On the tag (eligible or not). */
  ok: boolean;
  /** On the tag and its doctor's block checks pass. */
  eligible: boolean;
  /** The machine's health line, as the summary prints it. */
  line: string;
  /** What it was at before. */
  from?: string;
  failed?: { step: PeerStepId; why: string };
  rolledBack: boolean;
}

interface DoctorCheck {
  id: string;
  ok: boolean;
  severity: string;
  detail: string;
  /** The repository the check is about (a per-repository check, SPEC §4.6.21). */
  repo?: string;
}

/**
 * A repository's own check (an older doctor's untagged `repo.*` too): it blocks that repository
 * there, never the machine, as readiness judges it (SPEC §4.6.15).
 */
const repoCheck = (c: DoctorCheck): boolean => c.repo !== undefined || c.id.startsWith("repo.");

/** The doctor's `--json` report, as far as the deploy reads it; null when it printed none. */
function parseReport(stdout: string): { volley: unknown; checks: DoctorCheck[] } | null {
  try {
    const r = JSON.parse(stdout) as { versions?: { volley?: unknown }; checks?: unknown };
    return Array.isArray(r.checks)
      ? { volley: r.versions?.volley, checks: r.checks as DoctorCheck[] }
      : null;
  } catch {
    return null;
  }
}

/** Deploy `tag` on one paired machine; never throws. */
export async function deployPeer(
  peer: PairedPeer,
  tag: string,
  deps: { remote: PeerRemote; report: (line: string) => void },
): Promise<PeerResult> {
  const dir = peer.volleyDir;
  const version = tag.replace(/^v/, "");
  let fence = peerFence(peer, { tag, from: null });
  const exec = async (c: Command): Promise<ExecResult> => {
    try {
      fence(c);
      return await deps.remote(c);
    } catch (e) {
      return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
  };
  const fail = (
    step: PeerStepId,
    why: string,
    tail: string,
    from?: Ref,
    rolledBack = false,
  ): PeerResult => ({
    name: peer.name,
    ok: false,
    eligible: false,
    line: `${peer.name}: failed at ${step} (${why}); ${tail}`,
    ...(from !== undefined ? { from: refLabel(from) } : {}),
    failed: { step, why },
    rolledBack,
  });

  // Read-only: local changes, and where the checkout is now.
  const status = await exec({ argv: git(dir, "status", "--porcelain") });
  if (status.code !== 0)
    return fail("status", lastLine(status, ["git", "status"]), "nothing changed");
  const dirty = parseDirty(status.stdout);
  if (dirty.length > 0) {
    return fail("status", `local changes in ${dir}: ${dirty.join(", ")}`, "nothing changed");
  }
  const from = await currentRef((argv) => exec({ argv: [...argv] }), dir);
  if (from === null)
    return fail("status", `cannot tell what ${dir} has checked out`, "nothing changed");
  fence = peerFence(peer, { tag, from });

  let checks: DoctorCheck[] = [];
  const runSteps = async (steps: PeerStep[], prefix: string) => {
    for (const step of steps) {
      let why: string | null = null;
      for (const c of step.commands) {
        const r = await exec(c);
        if (step.id === "doctor") {
          // A failing block check exits 1 with the report on stdout.
          const report = parseReport(r.stdout);
          if (report === null) why = `printed no report: ${lastLine(r, c.argv)}`;
          else if (report.volley !== version) {
            why = `volley peer doctor reports volley ${String(report.volley)}, not ${version}`;
          } else checks = report.checks;
        } else if (r.code !== 0) why = lastLine(r, c.argv);
        if (why !== null) break;
      }
      deps.report(
        why === null
          ? `ok      ${prefix}${peer.name}: ${step.title}`
          : `FAILED  ${prefix}${peer.name}: ${step.title}: ${why}`,
      );
      if (why !== null) return { id: step.id, why };
    }
    return null;
  };

  const failed = await runSteps(
    peerPlan(peer, { kind: "tag", name: tag }, { fetch: true, doctor: true }),
    "",
  );
  if (failed === null) {
    const failing = checks.filter((c) => c.severity === "block" && !c.ok);
    const bad = failing.find((c) => !repoCheck(c));
    // Each repository's failing checks follow the machine's line.
    const repos = failing
      .filter(repoCheck)
      .map((c) => `${c.repo ?? "clone"} blocked: ${c.id} (${c.detail})`)
      .map((l) => ` · ${l}`)
      .join("");
    return {
      name: peer.name,
      ok: true,
      eligible: bad === undefined,
      line:
        bad === undefined
          ? `${peer.name}: ${tag} ✓ eligible${repos}`
          : `${peer.name}: ${tag} ✗ not eligible: ${bad.id} (${bad.detail})${repos}`,
      from: refLabel(from),
      rolledBack: false,
    };
  }
  // Before the checkout, or the checkout itself: HEAD never moved.
  if (failed.id === "fetch" || failed.id === "checkout") {
    return fail(failed.id, failed.why, "nothing changed", from);
  }
  deps.report(`rolling back ${peer.name} to ${refLabel(from)}`);
  const back = await runSteps(peerPlan(peer, from, { fetch: false, doctor: false }), "rollback: ");
  if (back === null) {
    return fail(failed.id, failed.why, `rolled back to ${refLabel(from)}`, from, true);
  }
  return fail(
    failed.id,
    failed.why,
    `the rollback to ${refLabel(from)} failed too at ${back.id} (${back.why})`,
    from,
  );
}
