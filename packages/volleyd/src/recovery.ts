import { DAEMON_DEFAULTS } from "./config-defaults";
import type { DecisionInput } from "./decisions";
import type { Host } from "./hosts/host";
import type { JournalEvent, TaskId } from "./types";
import { type AgentWatch, sameModel } from "./verify";

/**
 * Approval-gated recovery from credit exhaustion. A `credit_exhausted` signal (the hooks'
 * `class: "credit"`, or the credit prompt on a silent agent's screen) opens a `model_switch`
 * decision offering `switch to <fallback_model>` / `wait` / `stop task`. Nothing is typed into
 * the agent's terminal until the decision is resolved with a switch: then `/model <m>` + Enter,
 * verified by the hooks' PostModelSwitch registry re-publish (`model == m`). A switch that is not
 * verified re-opens the decision with the screen capture. The same recovery fires at most
 * `recovery_max_per_window` times per agent per `recovery_window_ms`; past that the decision
 * offers no switch (decision only). Models are never switched without approval.
 */

/** `class` of the decision a credit_exhausted signal opens. */
export const CREDIT_CLASS = "credit_exhausted";
/** `class` of the decision re-opened when a switch was not verified. */
export const UNVERIFIED_CLASS = "model_switch_unverified";

export type SwitchAnswer =
  | { kind: "switch"; model: string }
  | { kind: "wait" }
  | { kind: "stop" }
  | { kind: "other" };

export const STOP_ANSWER = "stop task";

/** The options a model_switch decision offers. */
export function switchOptions(fallback: string | null, allowed: boolean): string[] {
  return [...(fallback !== null && allowed ? [`switch to ${fallback}`] : []), "wait", STOP_ANSWER];
}

export interface ModelSwitchRequest {
  task: TaskId;
  agent_id: string;
  fallback_model: string | null;
  /** False once the agent hit the recovery limit: decision only. */
  allowed: boolean;
  source: "hook" | "screen";
  text: string | null;
  /** Path of the saved screen capture, if any. */
  screen?: string;
  /** `CREDIT_CLASS` (default) or `UNVERIFIED_CLASS`. */
  class?: string;
  /** The model a failed switch tried. */
  tried?: string;
}

/** The decision input and the extra facts kept on it. Pure. */
export function modelSwitchInput(r: ModelSwitchRequest): {
  input: DecisionInput;
  data: Record<string, unknown>;
} {
  const cls = r.class ?? CREDIT_CLASS;
  const what =
    cls === UNVERIFIED_CLASS
      ? `the switch of ${r.agent_id} to ${r.tried} was not confirmed by its hooks (no PostModelSwitch re-publish)`
      : `${r.agent_id} is out of credits (${r.source === "hook" ? "the hooks reported a usage-limit prompt" : "a usage-limit prompt is on its screen"})`;
  const offer =
    r.fallback_model === null
      ? " No fallback_model is configured: wait for the limit to reset, or stop the task."
      : !r.allowed
        ? " This recovery already ran twice in the last hour for this agent: no automatic switch is offered."
        : ` Switch it to ${r.fallback_model}?`;
  return {
    input: {
      kind: "model_switch",
      task: r.task,
      question: `Needs you: ${what}.${offer}`,
      options: switchOptions(r.fallback_model, r.allowed),
      pointers: r.screen !== undefined ? { screen: r.screen } : {},
    },
    data: {
      class: cls,
      agent_id: r.agent_id,
      fallback_model: r.fallback_model,
      recovery_allowed: r.allowed,
      source: r.source,
      ...(r.text !== null ? { text: r.text } : {}),
      ...(r.tried !== undefined ? { tried_model: r.tried } : {}),
    },
  };
}

/** What a resolve answer to a model_switch decision asks for. Pure. */
export function parseSwitchAnswer(
  answer: string,
  d: { fallback_model?: unknown; recovery_allowed?: unknown },
): SwitchAnswer {
  const a = answer.trim();
  const lower = a.toLowerCase();
  if (lower === "wait") return { kind: "wait" };
  if (lower === STOP_ANSWER || lower === "stop") return { kind: "stop" };
  const m = /^switch(?:\s+to\s+(\S+))?$/i.exec(a);
  if (m === null || d.recovery_allowed === false) return { kind: "other" };
  const model = m[1] ?? (typeof d.fallback_model === "string" ? d.fallback_model : undefined);
  return model !== undefined ? { kind: "switch", model } : { kind: "other" };
}

const within = (e: JournalEvent, now: number) =>
  now - Date.parse(e.at) < DAEMON_DEFAULTS.recovery_window_ms;

/** Credit-exhaustion decisions opened for `agentId` within the recovery window. */
export function creditOccurrences(events: readonly JournalEvent[], agentId: string, now: number) {
  return events.filter(
    (e) =>
      e.type === "decision_opened" &&
      e.data.class === CREDIT_CLASS &&
      e.data.agent_id === agentId &&
      within(e, now),
  ).length;
}

/** Model switches typed into `agentId`'s terminal within the recovery window. */
export function switchesSent(events: readonly JournalEvent[], agentId: string, now: number) {
  return events.filter(
    (e) =>
      e.type === "alarm_raised" &&
      e.data.alarm === "model_switch_sent" &&
      e.data.agent_id === agentId &&
      within(e, now),
  ).length;
}

/** Whether a recovery that already happened `count` times in the window may fire again. */
export const recoveryAllowed = (count: number) => count < DAEMON_DEFAULTS.recovery_max_per_window;

/**
 * Type `/model <m>` + Enter into the agent's terminal and wait for the hooks' PostModelSwitch
 * registry re-publish naming `m`. An entry that already named `m` before the switch does not
 * count: the registry must be re-published.
 */
export async function switchModel(r: {
  host: Host;
  workspace: string;
  watch: AgentWatch;
  model: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; registry: Record<string, unknown> | null }> {
  const before = r.watch.state.hookRegistry;
  await r.host.sendText(r.workspace, `/model ${r.model}`);
  await r.host.sendKeys(r.workspace, "Enter");
  const ok = await r.watch.waitFor((s) => {
    const reg = s.hookRegistry;
    return (
      reg !== null &&
      reg !== before &&
      reg.model_source === "harness-hook" &&
      typeof reg.model === "string" &&
      sameModel(reg.model, r.model)
    );
  }, r.timeoutMs);
  return { ok, registry: r.watch.state.hookRegistry };
}
