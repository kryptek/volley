/**
 * Where an agent runs (pure): its wave task's machine (SPEC §4.6.15), from
 * `tasks[].host`, else the placement's `host` (which names the supervisor's
 * own machine too), with that machine's retained record and volleyd's
 * readiness verdict. A wave task with neither runs on the supervisor's own
 * machine. An agent with no wave task (an ad-hoc agent or a session) gives
 * `null`: the Desk does not know where it runs.
 */
import { DAEMON_AGENT_ID } from "../../store/control";
import { supervisorHealth } from "../../store/reducer";
import type {
  AgentView,
  DeskState,
  MachinePayload,
  ReadinessPayload,
  TaskPlacement,
  WaveView,
} from "../../store/types";

/** What the chip reads for the supervisor's own machine. */
export const LOCAL_LABEL = "this machine";

/** A task `host` that names no paired machine: the supervisor's own (`local`) or not yet placed. */
const SUPERVISOR_HOSTS = new Set(["local", "auto"]);

export interface AgentMachine {
  /** The machine's name (the supervisor's `fleet.local_name` for its own). */
  name: string;
  /** The supervisor's own machine. */
  local: boolean;
  record?: MachinePayload;
  readiness?: ReadinessPayload;
  placement?: TaskPlacement;
  /** Whether volleyd is live: the local machine's dot. */
  hubUp: boolean;
}

export function machineFor(
  agent: Pick<AgentView, "task">,
  wave: WaveView | undefined,
  state: Pick<DeskState, "config" | "machines" | "readiness" | "supervisors">,
): AgentMachine | null {
  if (!agent.task) return null;
  const task = wave?.state?.tasks.find((t) => t.id === agent.task);
  if (!task) return null;
  // `host` is authoritative: it is the machine the effective plan spawns on (volleyd's reducer
  // sets it in the same step as `placement`, and a wave file's own host has no placement). It is
  // absent for the supervisor's own machine, which only `placement.host` names; a task with
  // neither (a `placement: local` wave, which volleyd never places) runs there too.
  const localName = state.config?.fleet?.local_name;
  const host = task.host && !SUPERVISOR_HOSTS.has(task.host) ? task.host : undefined;
  const placed = host ?? task.placement?.host;
  const name = placed ?? localName ?? "local";
  const record = state.machines?.[name];
  const verdict = state.readiness?.[name];
  return {
    name,
    local: placed === undefined || name === localName,
    ...(record ? { record } : {}),
    ...(verdict ? { readiness: verdict } : {}),
    ...(task.placement ? { placement: task.placement } : {}),
    hubUp: !supervisorHealth(state.supervisors?.[DAEMON_AGENT_ID]).down,
  };
}
