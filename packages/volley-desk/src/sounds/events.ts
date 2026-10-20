/**
 * The Desk's sound events: the one table the catalogue test, the theme
 * manifests, the generation prompts (`sounds/prompts.yaml`) and Settings ›
 * Sound all read. Class drives policy (`policy.ts`): **ui** never plays while
 * the tab is hidden; **signal** follows "only when hidden" and quiet hours;
 * **attention** ignores the hidden-tab rule, is optional in quiet hours and
 * may vibrate. Severity drives the theme's pitch and intensity (failure <
 * neutral < success). Pure data: no DOM, no audio.
 */

export type SoundClass = "ui" | "signal" | "attention";
export type Severity = "failure" | "neutral" | "success" | "attention";
export type SoundGroup =
  | "UI"
  | "Agents"
  | "Pipeline"
  | "Wave"
  | "Steering"
  | "System"
  | "Attention";

export interface SoundEventDef {
  class: SoundClass;
  severity: Severity;
  /** The Settings row and audition chip. */
  label: string;
  /** "<count> <many>" for a coalesced burst in the status line, e.g. "12 agents completed". */
  many: string;
  group: SoundGroup;
  defaultOn: boolean;
}

const ev = (
  cls: SoundClass,
  severity: Severity,
  group: SoundGroup,
  label: string,
  many: string,
  defaultOn = true,
): SoundEventDef => ({ class: cls, severity, label, many, group, defaultOn });

export const SOUND_EVENTS = {
  ui_click: ev("ui", "neutral", "UI", "Click", "clicks"),
  ui_drag_start: ev("ui", "neutral", "UI", "Drag start", "drags started"),
  ui_drop: ev("ui", "neutral", "UI", "Drop", "drops"),
  tethers_on: ev("ui", "success", "UI", "Tethers on", "tethers shown"),
  tethers_off: ev("ui", "neutral", "UI", "Tethers off", "tethers hidden"),
  panel_open: ev("ui", "neutral", "UI", "Panel open", "panels opened"),
  panel_close: ev("ui", "neutral", "UI", "Panel close", "panels closed"),
  agent_spawned: ev("signal", "neutral", "Agents", "Agent spawned", "agents spawned"),
  // Noisy: every agent starts working moments after it spawns.
  agent_working: ev("signal", "neutral", "Agents", "Agent working", "agents working", false),
  agent_complete: ev("signal", "success", "Agents", "Agent complete", "agents completed"),
  agent_failed: ev("signal", "failure", "Agents", "Agent failed or blocked", "agents failed"),
  agent_reaped: ev("signal", "failure", "Agents", "Agent reaped", "agents reaped"),
  review_written: ev("signal", "neutral", "Agents", "Review written", "reviews written"),
  decision_answered: ev("signal", "success", "Pipeline", "Decision answered", "decisions answered"),
  ci_passed: ev("signal", "success", "Pipeline", "CI passed", "CI runs passed"),
  ci_failed: ev("signal", "failure", "Pipeline", "CI failed", "CI runs failed"),
  merge_ready: ev("signal", "success", "Pipeline", "Merge ready", "tasks merge-ready"),
  pr_merged: ev("signal", "success", "Pipeline", "PR merged", "PRs merged"),
  wave_start: ev("signal", "neutral", "Wave", "Wave start", "waves started"),
  wave_complete: ev("signal", "success", "Wave", "Wave complete", "waves completed"),
  wave_stopped: ev("signal", "failure", "Wave", "Wave stopped", "waves stopped"),
  steering_sent: ev("signal", "neutral", "Steering", "Steering sent", "messages sent"),
  steering_delivered: ev(
    "signal",
    "success",
    "Steering",
    "Steering delivered",
    "messages delivered",
  ),
  account_limit: ev("signal", "failure", "System", "Account limit", "account limits"),
  machine_down: ev("signal", "failure", "System", "Machine down", "machines down"),
  broker_disconnected: ev(
    "signal",
    "failure",
    "System",
    "Broker disconnected",
    "broker disconnects",
  ),
  broker_reconnected: ev("signal", "success", "System", "Broker reconnected", "broker reconnects"),
  attention_needed: ev("attention", "attention", "Attention", "Needs you", "items need you"),
} as const satisfies Record<string, SoundEventDef>;

export type SoundEventId = keyof typeof SOUND_EVENTS;

export const SOUND_EVENT_IDS = Object.keys(SOUND_EVENTS) as SoundEventId[];

/** Settings › Sound's per-event groups, in order. */
export const EVENT_GROUPS: readonly { group: SoundGroup; ids: readonly SoundEventId[] }[] = (
  ["UI", "Agents", "Pipeline", "Wave", "Steering", "System", "Attention"] as const
).map((group) => ({
  group,
  ids: SOUND_EVENT_IDS.filter((id) => SOUND_EVENTS[id].group === group),
}));

export const isSoundEventId = (v: unknown): v is SoundEventId =>
  typeof v === "string" && Object.hasOwn(SOUND_EVENTS, v);
