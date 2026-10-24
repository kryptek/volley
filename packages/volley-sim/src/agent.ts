import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import { loadConfig } from "volley-mcp/config";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { type Env, simHome } from "./env";
import { runGh } from "./gh";
import { git, readWorld, repoOfCwd } from "./world";

/**
 * One simulated agent run: what a `claude` volleyd launched in a worktree would do, without a
 * model. It reads the worktree's `.volley/` identity and brief, registers and heartbeats over
 * the broker with the identity's own login (through volley-mcp's client, the way the MCP server
 * and the session hooks do: spawning → registry → working → a SessionStart heartbeat), performs
 * its role with real git against the origin and the fake `gh`, and publishes its result and
 * `done` — the in-process soak fleet's behaviour (volleyd's test/helpers/fake-agents.ts), from a
 * process:
 *
 *   - implementer: commits its task's file, pushes its branch, opens the PR against the release
 *     branch the brief names, `done` with the PR URL;
 *   - spec_reviewer / quality_reviewer: a `result` (approve, no findings), `done`;
 *   - fixup: a commit on the reviewed head pushed to the PR branch `.volley/findings.md` names;
 *   - rebase: rebases (or, under `branch_update: merge`, merges) onto the release branch and
 *     pushes to the PR branch `.volley/rebase.md` names;
 *   - integrator: cuts the train branch `.volley/integrate.md` names, merges its members, pushes
 *     it and opens the train's PR;
 *   - release: its stage `result`.
 *
 * Lingering (the default), it then stays connected like an idle session, acknowledging any
 * mailbox message, until SIGTERM / SIGINT / SIGHUP; it disconnects cleanly, so no will fires.
 */

export interface AgentOptions {
  cwd: string;
  env: Env;
  /** The claude argv (for `--model`). */
  argv: string[];
  /** Stay connected after `done` until a signal (default true). */
  linger?: boolean;
}

interface Identity {
  agent_id: string;
  wave?: string;
  task: string;
  role: string;
}

interface Outcome {
  summary: string;
  pr_url?: string;
  result?: { type: string; payload: unknown };
  /** `blocked` / `failed` instead of `done`. */
  terminal?: "blocked" | "failed";
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** Run git in the worktree; throws (the agent reports `failed`) on a non-zero exit. */
function g(cwd: string, ...args: string[]): string {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** The release branch the brief names (`… against \`<b>\`` / `cut from \`<b>\``), else main. */
function releaseBranch(cwd: string): string {
  const brief = read(join(cwd, ".volley", "brief.md"));
  return (
    /pull request against `([^`]+)`/.exec(brief)?.[1] ??
    /cut from `([^`]+)`/.exec(brief)?.[1] ??
    /^Release branch: `([^`]+)`/m.exec(read(join(cwd, ".volley", "integrate.md")))?.[1] ??
    "main"
  );
}

/** The marker the implementer leaves in its PR body, so later roles find the task's PR. */
const taskMarker = (task: string) => `volley-sim-task: ${task}`;

/** The PR branch a `.volley/<file>` push line names, else the task's open PR's. */
function prBranch(o: AgentOptions, id: Identity, file: string): string {
  const named = /origin HEAD:([^\s`]+)/.exec(read(join(o.cwd, ".volley", file)))?.[1];
  if (named !== undefined) return named;
  const w = readWorld(simHome(o.env));
  const repo = repoOfCwd(w, o.cwd)?.slug;
  const pr = w.prs.find(
    (p) => p.repo === repo && p.state === "OPEN" && p.body.includes(taskMarker(id.task)),
  );
  if (pr === undefined) throw new Error(`no PR branch for task ${id.task}`);
  return pr.headRefName;
}

/** Open (or find) the PR for `head` through the fake gh; its URL. */
function openPr(o: AgentOptions, head: string, base: string, title: string, body: string): string {
  const r = runGh(
    ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", head],
    {
      cwd: o.cwd,
      env: o.env,
    },
  );
  if (r.code === 0) return r.stdout.trim();
  const existing = /already exists:\n(\S+)/.exec(r.stderr)?.[1];
  if (existing !== undefined) return existing;
  throw new Error(`gh pr create: ${r.stderr.trim()}`);
}

/** The task's file (soak's ROLE_FILE): written, committed. */
function commitTaskFile(cwd: string, id: Identity, subject: string, line: string): void {
  const file = `src/${id.task.toLowerCase()}.ts`;
  const p = join(cwd, file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${read(p)}${line}\n`);
  g(cwd, "add", "--", file);
  g(cwd, "commit", "-q", "-m", subject);
}

async function work(o: AgentOptions, id: Identity): Promise<Outcome> {
  const { cwd } = o;
  const attempt = Number(/-(\d+)$/.exec(id.agent_id)?.[1] ?? 1);
  switch (id.role) {
    case "implementer": {
      const base = releaseBranch(cwd);
      const branch = g(cwd, "rev-parse", "--abbrev-ref", "HEAD");
      commitTaskFile(
        cwd,
        id,
        `feat: ${id.task}`,
        `export const task_${attempt} = ${JSON.stringify(id.task)};`,
      );
      g(cwd, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
      const url = openPr(
        o,
        branch,
        base,
        `feat: ${id.task}`,
        `Simulated by volley-sim.\n\n<!-- ${taskMarker(id.task)} -->\n`,
      );
      return { summary: `implemented ${id.task}`, pr_url: url };
    }
    case "spec_reviewer":
    case "quality_reviewer":
      return {
        summary: `reviewed ${id.task}`,
        result: {
          type: "review",
          payload: {
            findings: [],
            verdict: "approve",
            hygiene: { checked: true, findings: [] },
            summary: `${id.role} of ${id.task}`,
          },
        },
      };
    case "fixup": {
      const pr = prBranch(o, id, "findings.md");
      commitTaskFile(cwd, id, "fix: review findings", `// fixup ${attempt}`);
      g(cwd, "push", "-q", "origin", `HEAD:refs/heads/${pr}`);
      const findings = read(join(cwd, ".volley", "findings.json"));
      const ids =
        findings === ""
          ? []
          : ((JSON.parse(findings) as { findings?: { id: string }[] }).findings ?? []).map(
              (f) => f.id,
            );
      return {
        summary: `fixed up ${id.task}`,
        result: {
          type: "fixup",
          payload: {
            resolved: (ids.length > 0 ? ids : ["CI"]).map((finding) => ({
              finding,
              how: "changed it",
            })),
          },
        },
      };
    }
    case "rebase": {
      const pr = prBranch(o, id, "rebase.md");
      const release = releaseBranch(cwd);
      const merge = /\bgit merge\b/.test(read(join(cwd, ".volley", "rebase.md")));
      g(cwd, "fetch", "-q", "origin", release);
      const r = git(
        merge ? ["merge", "--no-edit", `origin/${release}`] : ["rebase", `origin/${release}`],
        cwd,
      );
      if (r.code !== 0) {
        git([merge ? "merge" : "rebase", "--abort"], cwd);
        return { summary: "conflict", terminal: "blocked" };
      }
      g(
        cwd,
        "push",
        "-q",
        ...(merge ? [] : ["--force-with-lease"]),
        "origin",
        `HEAD:refs/heads/${pr}`,
      );
      return {
        summary: `${merge ? "merged" : "rebased"} ${id.task}`,
        result: { type: "rebase", payload: { summary: "no conflicts" } },
      };
    }
    case "integrator": {
      const md = read(join(cwd, ".volley", "integrate.md"));
      const train = /^Train branch: `([^`]+)`/m.exec(md)?.[1];
      const base = /^Release branch: `[^`]+` at `([0-9a-f]{40})`/m.exec(md)?.[1];
      if (train === undefined || base === undefined)
        throw new Error("integrate.md names no train branch or release sha");
      const members = [
        ...md.matchAll(
          /^\d+\. PR #(\d+) \(task \S+\): branch `[^`]+`, gated head `([0-9a-f]{40})`/gm,
        ),
      ].map((m) => ({ pr: Number(m[1]), head: m[2] as string }));
      g(cwd, "fetch", "-q", "origin");
      g(cwd, "checkout", "-q", "-B", train, base);
      for (const m of members) g(cwd, "merge", "-q", "--no-ff", "--no-edit", m.head);
      g(cwd, "push", "-q", "origin", `HEAD:refs/heads/${train}`);
      const url = openPr(
        o,
        train,
        releaseBranch(cwd),
        `train: ${members.map((m) => `#${m.pr}`).join(", ")}`,
        `Simulated merge train.\n\n<!-- ${taskMarker(id.task)} -->\n`,
      );
      return {
        summary: `integrated ${id.task}`,
        pr_url: url,
        result: {
          type: "integrate",
          payload: { merged: members.map((m) => m.pr), conflicts: [], touched: [] },
        },
      };
    }
    case "release": {
      const stage = /-release-(.+)-\d+$/.exec(id.agent_id)?.[1] ?? id.task;
      return {
        summary: `stage ${stage}`,
        result: { type: "stage", payload: { stage, commands: [] } },
      };
    }
    default:
      return { summary: `nothing to simulate for role ${id.role}` };
  }
}

/** Run the agent in `o.cwd`; resolves with the process's exit code. */
export async function runAgent(o: AgentOptions): Promise<number> {
  const id = JSON.parse(read(join(o.cwd, ".volley", "agent.json"))) as Identity;
  const config = loadConfig(o.env, o.cwd, () => {});
  const model = o.argv[o.argv.indexOf("--model") + 1] ?? "claude-sim";
  const { agentId, namespace, parentId } = config;
  const envelope = (
    channel: string,
    type: string,
    payload: unknown,
    correlationId?: string | null,
  ) =>
    buildEnvelope({
      agentId,
      parentId,
      channel,
      type,
      payload,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  const broker = new VolleyBroker();
  await broker.connect({
    url: config.brokerUrl,
    agentId,
    willTopic: buildTopic(namespace, agentId, "status"),
    willPayload: JSON.stringify(envelope("status", "reaped", { reason: "disconnect" })),
    ...(config.auth !== undefined ? config.auth : {}),
  });
  const retained = new Set(["status", "result"]);
  const pub = (channel: string, type: string, payload: unknown, correlationId?: string | null) =>
    broker.publish(
      buildTopic(namespace, agentId, channel),
      JSON.stringify(envelope(channel, type, payload, correlationId)),
      { qos: retained.has(channel) ? 1 : 0, retain: retained.has(channel) },
    );
  let seq = 0;
  const narrate = (progress: number, msg: string) =>
    pub("progress", "narration", { progress, msg });

  // The session start: the MCP server's registration and the SessionStart hook's.
  await pub("status", "spawning", {});
  await broker.publish(
    registryTopic(agentId),
    JSON.stringify({
      ...envelope("_system/registry", "registered", {
        capabilities: [],
        cwd: o.cwd,
        model,
        model_source: "harness-hook",
        started_at: new Date().toISOString(),
        pid: process.pid,
      }),
      namespace,
    }),
    { qos: 1, retain: true },
  );
  await pub("status", "working", { source: "harness-hook" });
  await pub("progress", "heartbeat", {
    source: "harness-hook",
    seq: ++seq,
    hook_event: "SessionStart",
  });
  await narrate(10, `starting ${id.role} for ${id.task}`);

  let outcome: Outcome;
  let code = 0;
  try {
    outcome = await work(o, id);
  } catch (e) {
    outcome = { summary: (e as Error).message.split("\n")[0] ?? "error", terminal: "failed" };
    code = 1;
  }
  const terminal = async () => {
    if (outcome.terminal !== undefined) {
      await pub("status", outcome.terminal, {
        reason: outcome.summary,
        worktree: o.cwd,
        msg: outcome.summary,
      });
      return;
    }
    await narrate(100, outcome.summary);
    if (outcome.result !== undefined)
      await pub("result", outcome.result.type, outcome.result.payload);
    await pub("status", "done", {
      summary: outcome.summary,
      ...(outcome.pr_url !== undefined ? { pr_url: outcome.pr_url } : {}),
      worktree: o.cwd,
      msg: outcome.summary,
    });
  };
  await terminal();

  if (o.linger !== false) {
    // An idle session: a steer is acknowledged and the terminal status said again.
    const stop = await broker.subscribeStream(buildTopic(namespace, agentId, "mailbox"), (m) => {
      const e = parseEnvelope(m.payload);
      void pub(
        "progress",
        "steering_acked",
        { progress: 100, msg: "acknowledged: nothing left to change" },
        e?.correlation_id ?? null,
      ).then(terminal);
    });
    await new Promise<void>((resolve) => {
      for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(s, () => resolve());
    });
    await stop();
  }
  await broker.disconnect();
  return code;
}
