import { parseArgs } from "node:util";
import { type ControlOp, type ControlResponse, resolveTarget, withClient } from "./control";
import { type Command, type CommandArgs, EXIT, type ExitCode } from "./io";
import { resolveCaller } from "./ownership";
import type { WaveRecord } from "./reducer";
import { type Admission, activeTasks, ready } from "./scheduler";
import type { JournalEvent, TaskAgents, TaskId, TaskStage, WaveId } from "./types";

/**
 * Operator controls: pause/resume, stop, the stop --all kill switch, and steer. Pure helpers; the
 * daemon journals, publishes and answers.
 */

export const KILL_SWITCH_REASON = "kill switch engaged";

/** Why a wave admits nothing right now, or null when it may admit. */
export function holdReason(rec: WaveRecord, killSwitch: boolean): string | null {
  const status = rec.state?.status;
  if (status === "paused") return "wave paused";
  if (status === "stopped") return "wave stopped";
  return killSwitch ? KILL_SWITCH_REASON : null;
}

/** The admission verdict for a wave: `base`, or nothing with the hold reason. */
export function admissionFor(rec: WaveRecord, killSwitch: boolean, base: Admission): Admission {
  const why = holdReason(rec, killSwitch);
  return why === null ? base : { allow: 0, reasons: [why] };
}

/**
 * Tasks that would be ready if the wave were running — what a pause or stop holds back. Equal to
 * `ready()` for a running wave; empty for a complete one.
 */
export function candidates(rec: WaveRecord): TaskId[] {
  const s = rec.state;
  if (s === null) return [];
  if (s.status === "paused" || s.status === "stopped") {
    return ready({ ...rec, state: { ...s, status: "running" } });
  }
  return ready(rec);
}

/** The agent each stage is driven by; steering a task goes to its current stage's agent. */
const ROLE_FOR_STAGE: Partial<Record<TaskStage, keyof TaskAgents>> = {
  implement: "implementer",
  spec_review: "spec_reviewer",
  quality_review: "quality_reviewer",
  fixup: "fixup",
};

/** Who a steer to `task` reaches: `role`'s agent, else the current stage's, else the implementer. */
export function steerTarget(
  rec: WaveRecord,
  task: TaskId,
  role?: keyof TaskAgents,
): { role: keyof TaskAgents; agent_id: string } | null {
  const t = rec.state?.tasks.find((x) => x.id === task);
  if (t === undefined) return null;
  const order: (keyof TaskAgents)[] =
    role !== undefined ? [role] : [ROLE_FOR_STAGE[t.stage] ?? "implementer", "implementer"];
  for (const r of order) {
    const id = t.agents[r];
    if (id !== undefined) return { role: r, agent_id: id };
  }
  return null;
}

/** `seq` for the next steer to `task` (1, 2, …) and the message it supersedes. */
export function nextSteer(rec: WaveRecord, task: TaskId): { seq: number; supersedes?: string } {
  const prev = rec.steers?.[task];
  return prev === undefined ? { seq: 1 } : { seq: prev.seq + 1, supersedes: prev.message_id };
}

/** Every agent currently working a task of the wave (admitted, not settled), deduplicated. */
export function runningAgents(
  rec: WaveRecord,
): { task: TaskId; role: keyof TaskAgents; agent_id: string }[] {
  const seen = new Set<string>();
  const out: { task: TaskId; role: keyof TaskAgents; agent_id: string }[] = [];
  for (const id of activeTasks(rec)) {
    const t = rec.state?.tasks.find((x) => x.id === id);
    for (const [role, agent] of Object.entries(t?.agents ?? {})) {
      if (agent === undefined || seen.has(agent)) continue;
      seen.add(agent);
      out.push({ task: id, role: role as keyof TaskAgents, agent_id: agent });
    }
  }
  return out;
}

/** The kill switch is engaged when the last all-waves stop/resume in the system journal is a stop. */
export function killSwitchEngaged(system: readonly JournalEvent[]): boolean {
  for (let i = system.length - 1; i >= 0; i--) {
    const e = system[i];
    if (e?.data.all !== true) continue;
    if (e.type === "wave_stopped") return true;
    if (e.type === "wave_resumed") return false;
  }
  return false;
}

/** Mailbox payload for the cancel `stop` sends to each running agent. */
export function cancelPayload(wave: WaveId, task: TaskId, by: string): Record<string, unknown> {
  return {
    text: `volleyd: wave ${wave} was stopped by ${by}. Stop work on ${task} now: do not push, open or merge anything further, publish your terminal status and exit.`,
    from_agent_id: "volleyd",
    wave,
    task,
  };
}

/**
 * Waits for T0 mailbox acks (`type: "ack"` to the daemon's own mailbox, `correlation_id` = the
 * message id). Register with `wait()` BEFORE publishing so a fast ack is never missed.
 */
export class AckTracker {
  private readonly waiters = new Map<string, (by: string | null) => void>();

  /** Resolves with the acking agent id, or null after `ms`. */
  wait(messageId: string, ms: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(messageId);
        resolve(null);
      }, ms);
      this.waiters.set(messageId, (by: string | null) => {
        clearTimeout(timer);
        this.waiters.delete(messageId);
        resolve(by);
      });
    });
  }

  /** Record an ack; unknown or already-settled ids are ignored. */
  ack(messageId: string, by: string): void {
    this.waiters.get(messageId)?.(by);
  }

  /** Settle every pending wait as unacked (shutdown). */
  clear(): void {
    for (const settle of [...this.waiters.values()]) settle(null);
  }
}

// ---------------------------------------------------------------------------------------------
// CLI plumbing shared by the thin control commands (pause, resume, stop, claim, resolve, steer,
// decisions): parse flags, resolve the caller's identity, send one op, print the answer.
// ---------------------------------------------------------------------------------------------

type Values = Record<string, string | boolean | undefined>;

export interface OpCommand {
  /** e.g. `pause` — used in errors as `volleyd pause: …`. */
  name: string;
  help: string;
  /** Extra flags besides --json, --by, --broker-url, --namespace, --help. */
  options?: Record<string, { type: "string" | "boolean" }>;
  /** The op and its fields, or a usage error. `by` is the caller's agent id when known. */
  build: (
    positionals: string[],
    values: Values,
  ) => { op: ControlOp; fields: Record<string, unknown>; timeoutMs?: number } | string;
  /** Human output for a successful answer. */
  print: (res: ControlResponse, values: Values) => string;
  /** False for read-only commands that do not need the caller's identity. */
  needsCaller?: boolean;
}

/** Build a `Command` from an op description. Exit codes follow the CLI table in io.ts. */
export function opCommand(spec: OpCommand): Command {
  return async ({ argv, env, io }: CommandArgs): Promise<ExitCode> => {
    let parsed: { values: Values; positionals: string[] };
    let target: ReturnType<typeof resolveTarget>;
    try {
      parsed = parseArgs({
        args: argv,
        options: {
          json: { type: "boolean", default: false },
          by: { type: "string" },
          "broker-url": { type: "string" },
          namespace: { type: "string" },
          help: { type: "boolean", short: "h" },
          ...spec.options,
        },
        strict: true,
        allowPositionals: true,
      }) as { values: Values; positionals: string[] };
      target = resolveTarget(parsed.values, env);
    } catch (e) {
      io.stderr(
        `volleyd ${spec.name}: ${e instanceof Error ? e.message : String(e)}\n${spec.help}`,
      );
      return EXIT.USAGE;
    }
    if (parsed.values.help === true) {
      io.stdout(spec.help);
      return EXIT.OK;
    }
    const built = spec.build(parsed.positionals, parsed.values);
    if (typeof built === "string") {
      io.stderr(`volleyd ${spec.name}: ${built}\n${spec.help}`);
      return EXIT.USAGE;
    }
    return withClient(target, io, `volleyd ${spec.name}`, async (client) => {
      const flag = typeof parsed.values.by === "string" ? parsed.values.by : undefined;
      const caller =
        spec.needsCaller === false ? null : (await resolveCaller(client, flag, env)).id;
      const res = await client.request(
        built.op,
        { ...built.fields, ...(caller !== null ? { by: caller } : {}) },
        {
          text: `volleyd ${spec.name} ${parsed.positionals.join(" ")}`.trim(),
          ...(built.timeoutMs !== undefined ? { timeoutMs: built.timeoutMs } : {}),
        },
      );
      if (!res.ok) {
        const hint =
          caller === null && /owned by/.test(res.error ?? "")
            ? "\n(no caller identity: pass --by <agent-id> or set VOLLEY_AGENT_ID)"
            : "";
        io.stderr(`volleyd ${spec.name}: ${res.error ?? "rejected"}${hint}\n`);
        return EXIT.ERROR;
      }
      io.stdout(
        parsed.values.json === true
          ? `${JSON.stringify(res.result, null, 2)}\n`
          : spec.print(res, parsed.values),
      );
      return EXIT.OK;
    });
  };
}
