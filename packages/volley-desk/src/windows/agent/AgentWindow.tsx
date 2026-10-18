/**
 * The agent window, ported from the prototype `AgentWindow`: a React Bits
 * `StatusMark` (status + progress), `task #issue`, the wave chip in the wave
 * accent and the role chip in the title; the task title from the wave `spec`;
 * the pipeline; the latest narration (`payload.msg`, plain text — effects
 * land in D7); attention-line (D3) and steering-panel (D4) slots; the Volley
 * feed and Terminal tabs; and a footer with progress, heartbeat age and the
 * registry model. Markup and classes follow the prototype; everything is read
 * from the store's `AgentView` and the agent's `WaveView`.
 */
import { BubbleChatIcon, ListViewIcon, TerminalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { BORN_MS, Frame, type FrameProps } from "../../canvas/Frame";
import StatusMark, { type StatusMarkStatus } from "../../rb/StatusMark/StatusMark";
import { UNASSIGNED } from "../../store/reducer";
import type { AgentView, Role, WaveView } from "../../store/types";
import { Feed } from "./Feed";
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
  /** Attention line under the narration (D3). */
  attention?: ReactNode;
  /** Chat glyph: opens the steering panel (D4). */
  onChat?: (agentId: string) => void;
  /** The chat glyph is lit while the steering panel is open (D4). */
  steerOpen?: boolean;
  /** Steering panel, rendered at the bottom of the body (D4). */
  steer?: ReactNode;
}

function markStatus(type: string | undefined): StatusMarkStatus {
  switch (type) {
    case "working":
      return "running";
    case "done":
      return "done";
    case "failed":
    case "reaped":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
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
  attention,
  onChat,
  steerOpen = false,
  steer,
}: AgentWindowProps) {
  const now = useNow(fixedNow);
  const [tab, setTab] = useState<"feed" | "term">("feed");
  const accent = agent.wave === UNASSIGNED ? NEUTRAL_ACCENT : waveAccent;
  const ws = wave?.state ?? null;
  const task = agent.task ? ws?.tasks.find((t) => t.id === agent.task) : undefined;
  const spec = agent.task ? ws?.spec?.tasks[agent.task] : undefined;
  const issue = task?.issue ?? spec?.issue;
  const progress = agent.progress === null ? null : Math.max(0, Math.min(100, agent.progress));
  const status = markStatus(agent.status?.type);
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
      <div className="bar">
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
      accent={accent}
      width={AGENT_WIDTH}
      born={born}
      actions={actions}
      footer={footer}
    >
      {agent.task === null && <div className="a-id mono dim ell">{agent.id}</div>}
      {spec?.title && <div className="a-title">{spec.title}</div>}
      {agent.task !== null && <Pipeline stage={task?.stage ?? null} agentRole={agent.role} />}
      <div className="narr" aria-live="polite">
        {agent.narration ? (
          <span>{agent.narration}</span>
        ) : (
          <span className="dim">no narration yet</span>
        )}
      </div>
      {attention}
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "feed"}
          onClick={() => setTab("feed")}
        >
          <Icon i={ListViewIcon} s={13} /> Volley feed
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "term"}
          onClick={() => setTab("term")}
        >
          <Icon i={TerminalIcon} s={13} /> Terminal
        </button>
      </div>
      {tab === "feed" ? (
        <Feed feed={agent.feed} />
      ) : (
        <Terminal screen={agent.screen} stale={task?.screen_stale === true} />
      )}
      {steer}
    </Frame>
  );
}
