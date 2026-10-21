import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { LaunchSpec } from "../../src/hosts/host";
import type { JournalEvent } from "../../src/types";
import type { FakeHost } from "./fake-host";
import type { SoakWorld } from "./soak-world";

/**
 * The soak's fake agent fleet: every launch on the fake host becomes a simulated agent that
 * registers the way the session hooks and its MCP server do (spawning → registry → working → a
 * SessionStart heartbeat), and then — on the soak's next `step()`, once the daemon has journaled
 * its registration (`observe` is fed the journal) — narrates, performs its role in the soak world and publishes its terminal
 * status over the real broker, the way supervised-env.ts simulates one implementer.
 *
 *   - implementer: commits on its base, pushes its branch and opens the PR (a flake fixer's commit
 *     fixes the flaky test's file);
 *   - spec_reviewer / quality_reviewer: publish the scripted review result;
 *   - fixup: commits on the reviewed head and pushes it to the PR branch;
 *   - rebase: rebases the PR head onto the release tip and pushes it (or reports a conflict);
 *   - release: publishes its stage result.
 *
 * What each launch does instead of its role (stall, fail, a conflict, an unparseable result) is
 * the scenario's `behaviour`.
 */

export type Behaviour =
  /** Do the role's work (after `delaySteps` steps: a long review) and report done. */
  | {
      kind: "work";
      findings?: { severity: "P1" | "P2" | "P3"; file: string; text: string }[];
      delaySteps?: number;
    }
  /** Stop without a terminal status (the Stop hook's `idle`), and ignore every nudge. */
  | { kind: "stall" }
  /** Report `failed`. */
  | { kind: "fail"; reason: string }
  /** A reviewer: publish a result no parser accepts, then done (and again when steered). */
  | { kind: "unparseable" }
  /** A rebase: report `blocked` on a conflict it cannot resolve. */
  | { kind: "conflict"; file: string };

export interface FleetAgent {
  agent_id: string;
  task: string;
  role: string;
  attempt: number;
  /** The release stage (role `release`). */
  stage?: string;
  cwd: string;
  workspace: string;
  /** Its own branch (the worktree's). */
  branch: string;
  /** This (task, role)'s n-th launch, 1-based. */
  nth: number;
  /** Registered with the daemon (its `agent_registered` journaled). */
  registered: boolean;
  /** Its role's work is done (or it never will: stalled, failed, blocked). */
  acted: boolean;
  /** Retired by the daemon: it never publishes again. */
  retired: boolean;
  /** Steers the daemon sent it that the agent has not answered yet. */
  steers: number;
  /** Steps since it registered. */
  waited: number;
  behaviour: Behaviour;
}

export interface FleetOptions {
  /** The fleet's broker connection (every agent publishes through it). */
  broker: VolleyBroker;
  namespace: string;
  host: FakeHost;
  world: SoakWorld;
  release_branch: string;
  behaviour?: (a: Omit<FleetAgent, "behaviour">) => Behaviour;
  /** The flaky test's file: a fixer's commit marks it fixed. */
  flakeFile?: string;
  /** The wave clock (envelope wall_time). */
  now?: () => number;
}

export type Fleet = ReturnType<typeof fakeFleet>;

const ROLE_FILE = (task: string) => `src/${task.toLowerCase()}.ts`;

export function fakeFleet(o: FleetOptions) {
  const agents = new Map<string, FleetAgent>();
  const launches: FleetAgent[] = [];
  const counts: Record<string, number> = {};
  /** The PR branch per task (its first implementer push). */
  const prBranch: Record<string, string> = {};
  const inflight = new Set<Promise<unknown>>();
  /** What each agent published, in order (type per channel), for assertions. */
  const published: { agent_id: string; channel: string; type: string }[] = [];
  const now = o.now ?? (() => Date.now());

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };

  const pub = (id: string, channel: string, type: string, payload: unknown, retain = true) => {
    published.push({ agent_id: id, channel, type });
    return o.broker.publish(
      channel === "_system/registry" ? registryTopic(id) : buildTopic(o.namespace, id, channel),
      JSON.stringify({
        ...buildEnvelope({
          now: () => new Date(now()),
          agentId: id,
          parentId: "volleyd",
          channel,
          type,
          payload,
        }),
        ...(channel === "_system/registry" ? { namespace: o.namespace } : {}),
      }),
      { qos: 1, retain },
    );
  };
  let seq = 0;
  const narrate = (a: FleetAgent, progress: number, msg: string) =>
    pub(a.agent_id, "progress", "narration", { progress, msg }, false);
  const heartbeat = (a: FleetAgent, hook_event: string) =>
    pub(
      a.agent_id,
      "progress",
      "heartbeat",
      { source: "harness-hook", seq: ++seq, hook_event },
      false,
    );

  /** The session start: what the MCP server and the SessionStart hook publish. */
  const register = async (a: FleetAgent) => {
    await pub(a.agent_id, "status", "spawning", {});
    await pub(a.agent_id, "_system/registry", "registered", {
      capabilities: [],
      cwd: a.cwd,
      started_at: new Date(now()).toISOString(),
      model: "claude-opus-5-5",
      model_source: "harness-hook",
    });
    await pub(a.agent_id, "status", "working", { source: "harness-hook" });
    await heartbeat(a, "SessionStart");
  };

  const onLaunch = (spec: LaunchSpec, workspace: string) => {
    const id = JSON.parse(readFileSync(join(spec.cwd, ".volley", "agent.json"), "utf-8")) as {
      agent_id: string;
      task: string;
      role: string;
    };
    const wt = [...o.host.worktrees].reverse().find((w) => w.path === spec.cwd);
    const key = `${id.task}/${id.role}`;
    counts[key] = (counts[key] ?? 0) + 1;
    const stage = /-release-(.+)-\d+$/.exec(id.agent_id)?.[1];
    const base = {
      agent_id: id.agent_id,
      task: id.task,
      role: id.role,
      attempt: Number(/-(\d+)$/.exec(id.agent_id)?.[1] ?? 1),
      ...(stage !== undefined && id.role === "release" ? { stage } : {}),
      cwd: spec.cwd,
      workspace,
      branch: wt?.branch ?? "",
      nth: counts[key] as number,
      registered: false,
      acted: false,
      retired: false,
      steers: 0,
      waited: 0,
    };
    const a: FleetAgent = { ...base, behaviour: o.behaviour?.(base) ?? { kind: "work" } };
    agents.set(a.agent_id, a);
    launches.push(a);
    // Started at once: the daemon subscribed to the agent before launching it.
    void track(register(a));
  };
  o.host.onLaunch = onLaunch;

  /** Feed it the daemon's journal (Daemon.onJournal): registrations, retires, steers. */
  const observe = (e: JournalEvent) => {
    const id = e.data?.agent_id as string | undefined;
    const a = id !== undefined ? agents.get(id) : undefined;
    if (a === undefined) return;
    if (e.type === "agent_registered") a.registered = true;
    if (e.type === "agent_retired") a.retired = true;
    if (e.type === "steering_sent") a.steers++;
  };

  const isFixer = (a: FleetAgent) => {
    const brief = join(a.cwd, ".volley", "brief.md");
    return existsSync(brief) && readFileSync(brief, "utf-8").includes("Fix flaky test");
  };

  /** The PR branch of `task` (the implementer's), as the fixup and rebase briefs name it. */
  const prOf = (task: string) => {
    const b = prBranch[task];
    if (b === undefined) throw new Error(`fleet: no PR branch for ${task}`);
    return b;
  };

  const done = (a: FleetAgent, summary: string) =>
    pub(a.agent_id, "status", "done", {
      summary,
      ...(prBranch[a.task] !== undefined
        ? { pr_url: o.world.prFor(prBranch[a.task] as string)?.url }
        : {}),
      worktree: a.cwd,
      msg: summary,
    });

  const head = (a: FleetAgent) => {
    const h = o.world.local[a.cwd];
    if (h === undefined) throw new Error(`fleet: ${a.agent_id} has no HEAD at ${a.cwd}`);
    return h;
  };

  /** The role's work in the world, then its result and `done`. */
  const work = async (a: FleetAgent, b: Extract<Behaviour, { kind: "work" }>) => {
    const w = o.world;
    switch (a.role) {
      case "implementer": {
        const fixer = isFixer(a);
        const files: Record<string, string> =
          fixer && o.flakeFile !== undefined
            ? { [o.flakeFile]: "fixed" }
            : { [ROLE_FILE(a.task)]: `${a.task}-${a.attempt}` };
        const h = w.commit(head(a), files, fixer ? "fix: the flaky test" : `feat: ${a.task}`);
        w.local[a.cwd] = h;
        w.push(a.branch, h);
        w.openPr(a.branch, fixer ? `fix: the flaky test (${a.task})` : `feat: ${a.task}`);
        prBranch[a.task] = a.branch;
        await done(a, `implemented ${a.task}`);
        return;
      }
      case "spec_reviewer":
      case "quality_reviewer": {
        const findings = (b.findings ?? []).map((f) => ({ ...f, line: 1 }));
        await pub(a.agent_id, "result", "review", {
          findings,
          verdict: findings.some((f) => f.severity === "P1") ? "changes_requested" : "approve",
          hygiene: { checked: true, findings: [] },
          summary: `${a.role} of ${a.task}`,
        });
        await done(a, `reviewed ${a.task}`);
        return;
      }
      case "fixup": {
        const h = w.commit(
          head(a),
          { [ROLE_FILE(a.task)]: `${a.task}-fixup-${a.attempt}` },
          "fix: review findings",
        );
        w.local[a.cwd] = h;
        w.push(prOf(a.task), h);
        const findings = existsSync(join(a.cwd, ".volley", "findings.json"))
          ? (JSON.parse(readFileSync(join(a.cwd, ".volley", "findings.json"), "utf-8")) as {
              findings?: { id: string }[];
            })
          : {};
        const ids = (findings.findings ?? []).map((f) => f.id);
        await pub(a.agent_id, "result", "fixup", {
          resolved: (ids.length > 0 ? ids : ["CI"]).map((finding) => ({
            finding,
            how: "changed it",
          })),
        });
        await done(a, `fixed up ${a.task}`);
        return;
      }
      case "rebase": {
        const h = w.rebase(head(a), w.tip(), `feat: ${a.task}`);
        w.local[a.cwd] = h;
        w.push(prOf(a.task), h);
        await pub(a.agent_id, "result", "rebase", { summary: "no conflicts" });
        await done(a, `rebased ${a.task}`);
        return;
      }
      case "release": {
        w.local[a.cwd] = w.tip();
        await pub(a.agent_id, "result", "stage", { stage: a.stage, commands: [] });
        await done(a, `stage ${a.stage}`);
        return;
      }
      default:
        throw new Error(`fleet: no work for role ${a.role}`);
    }
  };

  const act = async (a: FleetAgent) => {
    await narrate(a, 10, `starting ${a.role} for ${a.task}`);
    const b = a.behaviour;
    switch (b.kind) {
      case "work":
        await narrate(a, 60, `working on ${a.task}`);
        await work(a, b);
        return;
      case "stall":
        await pub(
          a.agent_id,
          "progress",
          "idle",
          {
            text: "Done reading the diff.",
            source: "harness-hook",
            seq: ++seq,
            hook_event: "Stop",
          },
          false,
        );
        return;
      case "fail":
        await pub(a.agent_id, "status", "failed", {
          reason: b.reason,
          worktree: a.cwd,
          msg: b.reason,
        });
        return;
      case "unparseable":
        await pub(a.agent_id, "result", "review", { verdict: "looks good to me" });
        await done(a, "reviewed");
        return;
      case "conflict":
        await pub(a.agent_id, "status", "blocked", {
          reason: `merge conflict in ${b.file} I cannot resolve`,
          worktree: a.cwd,
          msg: "merge conflict",
        });
        return;
    }
  };

  /** A steer an agent answers: the unparseable reviewer repeats itself; a worker does it again. */
  const answer = async (a: FleetAgent) => {
    a.steers--;
    if (a.behaviour.kind === "stall") return;
    await narrate(a, 80, "acknowledged: redoing it");
    if (a.behaviour.kind === "unparseable") {
      await pub(a.agent_id, "result", "review", { verdict: "still fine" });
      await done(a, "reviewed again");
    } else if (a.behaviour.kind === "work" && a.acted) await done(a, `${a.role} done (again)`);
  };

  return {
    agents,
    launches,
    published,
    prBranch,
    /**
     * Every registered agent that has not acted does its work; every steered one answers. Call
     * between daemon steps; resolves once all of it is published.
     */
    async step(): Promise<void> {
      for (const a of agents.values()) {
        if (a.retired || !a.registered) continue;
        if (!a.acted) {
          const b = a.behaviour;
          if (b.kind === "work" && a.waited++ < (b.delaySteps ?? 0)) continue;
          a.acted = true;
          await track(act(a));
        } else if (a.steers > 0) await track(answer(a));
      }
      await this.idle();
    },
    /** Every publish started so far has been handed to the broker. */
    async idle(): Promise<void> {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
    /** Heartbeats from every live agent that works (a stalled one has stopped: silent). */
    async heartbeats(): Promise<void> {
      for (const a of agents.values())
        if (!a.retired && a.registered && !(a.behaviour.kind === "stall" && a.acted))
          await track(heartbeat(a, "PostToolUse"));
    },
    observe,
  };
}
