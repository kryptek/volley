import { parseArgs } from "node:util";
import { type Clock, systemClock } from "./clock";
import {
  type ControlOp,
  type ControlResponse,
  type ControlTarget,
  resolveControlTarget,
  withClient,
} from "./control";
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

/** The roles a steer may name. */
export const TASK_ROLES: readonly (keyof TaskAgents)[] = [
  "implementer",
  "spec_reviewer",
  "quality_reviewer",
  "fixup",
];

export const isTaskRole = (r: string): r is keyof TaskAgents =>
  (TASK_ROLES as readonly string[]).includes(r);

/**
 * Who a steer to `task` reaches: `role`'s agent, else the current stage's, else the implementer;
 * never one in `retired` (task.agents keeps the last agent per role after it is retired). Null
 * when no live agent fits: the steer is queued for the task's next one.
 */
export function steerTarget(
  rec: WaveRecord,
  task: TaskId,
  retired: ReadonlySet<string>,
  role?: keyof TaskAgents,
): { role: keyof TaskAgents; agent_id: string } | null {
  const t = rec.state?.tasks.find((x) => x.id === task);
  if (t === undefined) return null;
  const order: (keyof TaskAgents)[] =
    role !== undefined ? [role] : [ROLE_FOR_STAGE[t.stage] ?? "implementer", "implementer"];
  for (const r of order) {
    const id = Object.hasOwn(t.agents, r) ? t.agents[r] : undefined;
    if (id !== undefined && !retired.has(id)) return { role: r, agent_id: id };
  }
  return null;
}

/**
 * `seq` for the next steer to `task` (1, 2, …) and the message it supersedes: the last steer that
 * is not additive. An `additive` steer (a merge nudge) supersedes nothing.
 */
export function nextSteer(
  rec: WaveRecord,
  task: TaskId,
  opts: { additive?: boolean } = {},
): { seq: number; supersedes?: string } {
  const prev = rec.steers[task];
  const seq = (prev?.seq ?? 0) + 1;
  return prev?.message_id === undefined || opts.additive === true
    ? { seq }
    : { seq, supersedes: prev.message_id };
}

/** Every agent currently working a task of the wave (admitted, not settled), deduplicated. */
export function runningAgents(
  rec: WaveRecord,
  retired: ReadonlySet<string>,
): { task: TaskId; role: keyof TaskAgents; agent_id: string }[] {
  // task.agents keeps the last agent per role after it is retired: never count those.
  const seen = new Set<string>(retired);
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

/** What a steer heard back within its wait. */
export interface SteerAck {
  /** The recipient's mailbox `ack` arrived: it received the message (SPEC §4.4). */
  received: boolean;
  /** The recipient's `steering_acked` arrived: the model acted on it (SPEC §4.3). */
  acked: boolean;
}

interface AckWaiter {
  /** Only this agent's acks count (SPEC §4.4: a sender accepts acks from its addressee only). */
  agent: string;
  state: SteerAck;
  settle: () => void;
}

/**
 * Waits for a steer's answers: the recipient's `steering_acked` progress event (which settles
 * the wait) and, on the way, its mailbox `ack` (recorded as `received`). Both carry the steer's
 * message id as `correlation_id`. Register with `wait()` BEFORE publishing so a fast ack is never
 * missed.
 */
export class AckTracker {
  private readonly waiters = new Map<string, AckWaiter>();
  // real clock: the default when the daemon injects no clock
  constructor(private readonly clock: Clock = systemClock) {}

  /** Resolves once `agent` acts on `messageId`, or after `ms` with what was heard so far. */
  wait(messageId: string, agent: string, ms: number): Promise<SteerAck> {
    return new Promise((resolve) => {
      const state: SteerAck = { received: false, acked: false };
      const settle = () => {
        this.clock.clearTimeout(timer);
        this.waiters.delete(messageId);
        resolve(state);
      };
      const timer = this.clock.setTimeout(settle, ms);
      this.waiters.set(messageId, { agent, state, settle });
    });
  }

  /** A mailbox `ack` from `by`; ignored unless `by` is the addressee of a pending steer. */
  received(messageId: string, by: string): void {
    const w = this.waiters.get(messageId);
    if (w !== undefined && w.agent === by) w.state.received = true;
  }

  /** A `steering_acked` from `by`; settles the wait when `by` is the addressee. */
  acked(messageId: string, by: string): void {
    const w = this.waiters.get(messageId);
    if (w === undefined || w.agent !== by) return;
    w.state.received = true;
    w.state.acked = true;
    w.settle();
  }

  /** Settle every pending wait with what it has (shutdown). */
  clear(): void {
    for (const w of [...this.waiters.values()]) w.settle();
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
  /**
   * The op hands the wave to the caller (`claim`): refuse without an identity, and warn when
   * `VOLLEY_AGENT_ID` names an agent the registry does not know.
   */
  takesOwnership?: boolean;
}

/** Build a `Command` from an op description. Exit codes follow the CLI table in io.ts. */
export function opCommand(spec: OpCommand): Command {
  return async ({ argv, env, io }: CommandArgs): Promise<ExitCode> => {
    let parsed: { values: Values; positionals: string[] };
    let target: ControlTarget;
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
      target = resolveControlTarget(parsed.values, env);
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
      const who = spec.needsCaller === false ? null : await resolveCaller(client, flag, env);
      const caller = who?.id ?? null;
      if (spec.takesOwnership === true) {
        if (caller === null) {
          io.stderr(
            `volleyd ${spec.name}: ${spec.name} needs an identity: pass --by <agent-id> or set VOLLEY_AGENT_ID\n`,
          );
          return EXIT.ERROR;
        }
        if (who?.warning !== undefined) io.stderr(`warning: ${who.warning}\n`);
      }
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
