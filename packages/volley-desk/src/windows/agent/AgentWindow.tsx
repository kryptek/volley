/**
 * The agent window, ported from the prototype `AgentWindow`: a React Bits
 * `StatusMark` (status + progress), `task #issue`, the wave chip in the wave
 * accent and the role chip in the title; the task title from the wave `spec`;
 * the pipeline; the latest narration (`payload.msg`, with the look's
 * narration effect, D7); attention-line (D3) and steering-panel (D4) slots; the Volley
 * feed and Terminal tabs (React Bits Gooey Nav, D10); and a footer with progress, heartbeat age and the
 * registry model. Markup and classes follow the prototype; everything is read
 * from the store's `AgentView` and the agent's `WaveView`.
 */
import { BubbleChatIcon, ListViewIcon, TerminalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { BORN_MS, Frame, type FrameProps } from "../../canvas/Frame";
import { GooeyTabs, tabPanelProps } from "../../look/GooeyTabs";
import StatusMark, { type StatusMarkStatus } from "../../rb/StatusMark/StatusMark";
import { UNASSIGNED } from "../../store/reducer";
import type { AgentView, FeedEntry, Role, WaveView } from "../../store/types";
import { Feed, feedChannel } from "./Feed";
import { Narration, type NarrationFx } from "./Narration";
import { Pipeline } from "./Pipeline";
import { Terminal } from "./Terminal";
import "../../styles/agent.css";

export const AGENT_WIDTH = 460;
/** Accent for agents no wave references. */
export const NEUTRAL_ACCENT = "#a3abc0";
/** A heartbeat older than this is stale. */
export const HEARTBEAT_STALE_MS = 60_000;

export const ROLE_LABEL: Record<Role, string> = {
  implementer: "implementer",
  spec_reviewer: "spec review",
  quality_reviewer: "quality review",
  fixup: "fixup",
  rebase: "rebase",
};

/** Frame props the App supplies; the window fills in the rest. */
export type AgentFrameProps = Omit<
  FrameProps,
  "id" | "title" | "accent" | "width" | "children" | "actions" | "footer" | "born"
>;

export interface AgentWindowProps {
  agent: AgentView;
  wave: WaveView | undefined;
  /** The wave's accent; agents in `unassigned` always use `NEUTRAL_ACCENT`. */
  accent: string;
  frame: AgentFrameProps;
  /** Clock override (tests); otherwise the window ticks every 2 s. */
  now?: number;
  /** Narration effect from the look (D7); plain by default. */
  narrationFx?: NarrationFx;
  /** Attention line under the narration (D3). */
  attention?: ReactNode;
  /** Chat glyph: opens the steering panel (D4). */
  onChat?: (agentId: string) => void;
  /** The chat glyph is lit while the steering panel is open (D4). */
  steerOpen?: boolean;
  /** Steering panel, rendered at the bottom of the body (D4). */
  steer?: ReactNode;
}

/** The mark for an outcome status: `blocked` (SPEC §5.2, terminal) needs the operator, like `failed`. */
function outcomeMark(type: string): StatusMarkStatus | null {
  if (type === "done") return "done";
  if (type === "failed" || type === "blocked") return "failed";
  return null;
}

/**
 * The status mark for an agent. `reaped` (SPEC §5.2) only says the connection
 * ended, normally right after `done`, so it shows the outcome before it: the
 * latest other `status` in the feed, else (a retained replay, where only the
 * `reaped` status survives) `done` if the agent left a `result`. Anything else
 * — reaped while working, or with nothing known — is a crash.
 */
export function markStatus(agent: Pick<AgentView, "status" | "feed">): StatusMarkStatus {
  const type = agent.status?.type;
  if (type === "working") return "running";
  if (type !== "reaped") return (type ? outcomeMark(type) : null) ?? "pending";
  for (let i = agent.feed.length - 1; i >= 0; i--) {
    const e = agent.feed[i] as FeedEntry;
    if (feedChannel(e) === "status" && e.envelope.type !== "reaped") {
      return outcomeMark(e.envelope.type) ?? "failed";
    }
  }
  return agent.feed.some((e) => feedChannel(e) === "result") ? "done" : "failed";
}

/** The prototype's `ago`: `42s`, `3m`, `1.5h`. */
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

const Icon = ({ i, s = 15 }: { i: typeof BubbleChatIcon; s?: number }) => (
  <HugeiconsIcon icon={i} size={s} strokeWidth={1.8} />
);

const AGENT_TABS = [
  { key: "feed", label: "Volley feed", icon: <Icon i={ListViewIcon} s={13} /> },
  { key: "term", label: "Terminal", icon: <Icon i={TerminalIcon} s={13} /> },
] as const;

function useNow(fixed: number | undefined): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, [fixed]);
  return fixed ?? now;
}

export function AgentWindow({
  agent,
  wave,
  accent: waveAccent,
  frame,
  now: fixedNow,
  narrationFx = "plain",
  attention,
  onChat,
  steerOpen = false,
  steer,
}: AgentWindowProps) {
  const now = useNow(fixedNow);
  const [tab, setTab] = useState<"feed" | "term">("feed");
  const tabsId = useId();
  const accent = agent.wave === UNASSIGNED ? NEUTRAL_ACCENT : waveAccent;
  const ws = wave?.state ?? null;
  const task = agent.task ? ws?.tasks.find((t) => t.id === agent.task) : undefined;
  const spec = agent.task ? ws?.spec?.tasks[agent.task] : undefined;
  const issue = task?.issue ?? spec?.issue;
  const progress = agent.progress === null ? null : Math.max(0, Math.min(100, agent.progress));
  const status = markStatus(agent);
  const hbAge = agent.heartbeat === null ? null : now - agent.heartbeat;
  const hbStale = hbAge === null || hbAge > HEARTBEAT_STALE_MS;
  const born = agent.bornAt !== null && now - agent.bornAt < BORN_MS;

  const title = (
    <>
      <StatusMark
        status={status}
        {...(progress === null ? {} : { progress: progress / 100 })}
        color={accent}
        size={18}
      />
      <span className="t-name ell min0">
        {agent.task ?? agent.id}
        {issue !== undefined && <span className="dim"> #{issue}</span>}
      </span>
      <span className="chip chip--wave" title={`Linked to wave ${agent.wave}`}>
        <i style={{ background: accent }} />
        {agent.wave}
      </span>
      {agent.role && <span className="chip chip--role">{ROLE_LABEL[agent.role]}</span>}
    </>
  );

  // The window's accessible name: its wave, task and role (or the agent id).
  const name = [
    agent.task ? `${agent.wave} · ${agent.task}` : agent.id,
    agent.role && ROLE_LABEL[agent.role],
  ]
    .filter(Boolean)
    .join(" · ");
  const label = `Message ${[agent.task ?? agent.id, agent.role && ROLE_LABEL[agent.role]]
    .filter(Boolean)
    .join(" ")}`;
  const actions = (
    <button
      type="button"
      className={`icon-btn${steerOpen ? " icon-btn--hot" : ""}`}
      aria-label={label}
      title={label}
      onClick={() => onChat?.(agent.id)}
    >
      <Icon i={BubbleChatIcon} />
    </button>
  );

  const footer = (
    <div className="agent-foot">
      {/* biome-ignore lint/a11y/useFocusableInteractive: a progressbar is a read-only status, not a control */}
      <div
        className="bar"
        role="progressbar"
        aria-label={`${name} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        // No value yet: an indeterminate progressbar.
        aria-valuenow={progress ?? undefined}
      >
        <span style={{ width: `${progress ?? 0}%` }} />
      </div>
      <span className="mono">{progress === null ? "—" : `${progress}%`}</span>
      <span className={`hb${hbStale ? " hb--stale" : ""}`} title="Hook heartbeat">
        <i /> {hbAge === null ? "—" : age(hbAge)}
      </span>
      <span
        className="mono dim ell"
        title={agent.registry?.model_source ? `model: ${agent.registry.model_source}` : undefined}
      >
        {agent.model?.replace("claude-", "") ?? "model unknown"}
      </span>
    </div>
  );

  return (
    <Frame
      {...frame}
      id={agent.id}
      title={title}
      label={name}
      accent={accent}
      width={AGENT_WIDTH}
      born={born}
      actions={actions}
      footer={footer}
    >
      {spec?.title && <div className="a-title">{spec.title}</div>}
      {agent.task !== null && <Pipeline stage={task?.stage ?? null} agentRole={agent.role} />}
      <Narration text={agent.narration} fx={narrationFx} />
      {attention}
      <GooeyTabs
        id={tabsId}
        label="Agent views"
        tabs={AGENT_TABS}
        value={tab}
        onChange={setTab}
        accent={accent}
      />
      <div className="tab-panel" {...tabPanelProps(tabsId, tab)}>
        {tab === "feed" ? (
          <Feed feed={agent.feed} />
        ) : (
          // The supervisor flags a backed-off capture per task (SPEC §4.6.1 `tasks[].screen_stale`).
          <Terminal screen={agent.screen} stale={task?.screen_stale === true} />
        )}
      </div>
      {steer}
    </Frame>
  );
}
