/**
 * The agent window, ported from the prototype `AgentWindow`. The title bar is
 * two rows that never bunch: row 1 (the drag bar) starts with the agent's
 * Clawd character (`ClawdSprite`: an animated pixel Clawd doing the agent's
 * pipeline step, or resting, `clawd/state.ts`) or, with the look's Classic
 * spinner, a React Bits `StatusMark` (status + progress), then the wave chip in the wave accent, the role chip, the
 * stage chip and the machine chip (`MachineChip`: where the agent runs, its
 * dot, why here on hover / focus, a click opens Settings › Machines), then the
 * actions; row 2 (Frame's `subtitle`) has the headline, `task #issue` or the
 * purpose (`purpose.ts`: the wave task's title, the title the agent registered,
 * a session's workspace; at most two lines, the whole text on hover and on
 * tap) with its issue and PR links, and the account picker. When the purpose
 * names the window the headline shows it and the agent id moves to a small
 * secondary line; otherwise a purpose line in the body (a cwd basename, a
 * narration) says what it is for. A session (`isSession`) gets a
 * `session` chip, its hooks' work log as its narration and, in place of a
 * progress bar, `N tool calls · last 12s ago` and `working` / `idle · 3m`. A
 * dispatched agent with no progress of its own for 10 minutes gets an amber
 * badge (`attention.ts` `staleProgressFor`); the pipeline; the latest narration (`payload.msg`, with the look's
 * narration effect, D7); attention-line (D3) and steering-panel (D4) slots; the Volley
 * feed and Terminal tabs (React Bits Gooey Nav, D10); and a footer with progress, heartbeat age and the
 * registry model. Markup and classes follow the prototype; everything is read
 * from the store's `AgentView` and the agent's `WaveView`. An agent with no
 * signal (`attention.ts` `noSignalFor`, kind `mcp`) gets a dozing Clawd (a grey status mark) and
 * a one-line label above the tabs; a `quiet` one keeps its mark and gets a
 * neutral `quiet for Nm` label; while the Desk is syncing after a (re)connect
 * the label reads `syncing…` instead of any judgement. A narration restored
 * from this browser's session carries an `as of HH:MM` marker. A task whose
 * two reviewers run in parallel gets a `review (spec + quality)` stage chip.
 * From the agent's `usage` sample (SPEC §4.6.12) the footer gets a context
 * meter (`ctx 72% · 143K/200K`, hot ≥ 85, warn ≥ 65; pulse ≥ 70, faster when
 * hot, none under reduced motion), and row 2 an
 * account picker listing the Claude accounts of the agent's own machine with
 * their 5-hour usage and machine (`Work · 12% · peer-a`): picking another asks
 * to confirm (the agent restarts with a resume note) and then calls
 * `agent_move_account`. On hover or focus its tooltip says why the agent runs
 * under its account (`accountWhy`: the latest `account_chosen`, or the move
 * after it), and the Volley feed shows the task role's account events as
 * `Account · …` rows. An open `agent_account_limit` decision on the agent is a
 * banner: what autopilot will do while it is on, else Move / Not now, which
 * answer it with the decision's own options. The Terminal tab's ⤢ (`onPopout`)
 * opens the agent's screen in a floating window (`TerminalPopout`).
 */
import { BubbleChatIcon, ListViewIcon, TerminalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useReducedMotion } from "../../a11y/motion";
import { type NoSignal, SYNCING_LABEL, type Tier } from "../../attention";
import { BORN_MS, Frame, type FrameProps } from "../../canvas/Frame";
import { ClawdSprite } from "../../clawd/ClawdSprite";
import { clawdState } from "../../clawd/state";
import { plural } from "../../lib/plural";
import { GooeyTabs, tabPanelProps } from "../../look/GooeyTabs";
import type { AgentIcons } from "../../look/options";
import StatusMark from "../../rb/StatusMark/StatusMark";
import {
  type AccountChoice,
  LOCAL_MACHINE,
  NO_USAGE_YET,
  accountEventsFor,
  accountWhy,
  choicesFor,
  fiveHourLabel,
  machineName,
  moveOption,
  notNowAnswer,
} from "../../store/claude";
import { UNASSIGNED, isSession } from "../../store/reducer";
import type {
  AgentView,
  DecisionPayload,
  FeedEntry,
  Role,
  UsagePayload,
  WaveView,
} from "../../store/types";
import { Feed } from "./Feed";
import { MachineChip } from "./MachineChip";
import { Narration, type NarrationFx } from "./Narration";
import { Pipeline } from "./Pipeline";
import { Terminal } from "./Terminal";
import type { AgentMachine } from "./machine";
import { markStatus } from "./markStatus";
import { namesWindow, purposeOf } from "./purpose";
import "../../styles/agent.css";

export { markStatus };

export const AGENT_WIDTH = 460;
/** Accent for agents no wave references. */
export const NEUTRAL_ACCENT = "#a3abc0";
/** A heartbeat older than this is stale. */
export const HEARTBEAT_STALE_MS = 60_000;
/** The status mark of an agent with no signal. */
export const NO_SIGNAL_GREY = "#6b7280";

export const ROLE_LABEL: Record<Role, string> = {
  implementer: "implementer",
  spec_reviewer: "spec review",
  quality_reviewer: "quality review",
  fixup: "fixup",
  rebase: "rebase",
  integrator: "train integrator",
};

/** Frame props the App supplies; the window fills in the rest. */
export type AgentFrameProps = Omit<
  FrameProps,
  "id" | "title" | "subtitle" | "accent" | "width" | "children" | "actions" | "footer" | "born"
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
  /** The title's mark from the look: the Clawd character (default) or the classic status ring. */
  icons?: AgentIcons;
  /** The agent's attention tier (`agentAttention`): the Clawd asks for you only on `you`. */
  attentionTier?: Tier;
  /** Attention line under the narration (D3). */
  attention?: ReactNode;
  /** Chat glyph: opens the steering panel (D4). */
  onChat?: (agentId: string) => void;
  /** The chat glyph is lit while the steering panel is open (D4). */
  steerOpen?: boolean;
  /** Steering panel, rendered at the bottom of the body (D4). */
  steer?: ReactNode;
  /** Set while the agent has no signal (greys the status mark) or is quiet: shows the label. */
  noSignal?: NoSignal | null;
  /** The reconnect / resume grace window is open: `syncing…`, no judgement. */
  syncing?: boolean;
  /** The task's stage chip (`review (spec + quality)`), when it has one. */
  stageChip?: string | null;
  /** The agent's retained `usage` sample: the footer's context meter. */
  usage?: UsagePayload | null;
  /** The Claude accounts for the title's picker; none known, no picker. */
  accounts?: readonly AccountChoice[];
  /** `agent_move_account` to the picked account; absent = read-only (picker disabled). */
  onMoveAccount?: (acct: string) => Promise<{ ok: boolean; error?: string }> | undefined;
  /** The amber `no progress reported for N m` badge, when the agent has gone that long. */
  stale?: string | null;
  /** The Terminal tab's ⤢: opens the agent's screen in a floating window; absent, no ⤢. */
  onPopout?: (agentId: string) => void;
  /** Where the agent runs (`machineFor`); `null` / absent, no machine chip. */
  machine?: AgentMachine | null;
  /** The machine chip's click: opens Settings › Machines at that machine. */
  onOpenMachine?: (name: string) => void;
  /** The wave's account events (`accountFeed`): the picker's why and the feed's `Account ·` rows. */
  accountEvents?: readonly FeedEntry[];
  /** The agent's open `agent_account_limit` decision: the banner. */
  accountLimit?: DecisionPayload | null;
  /** Answers a decision (`resolve`); absent = read-only (the banner has no buttons). */
  onResolve?: (d: DecisionPayload, answer: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * What the Terminal shows for `agent`, on the card and in the popout alike: the
 * supervisor flags a backed-off capture per task (SPEC §4.6.1 `tasks[].screen_stale`),
 * and an agent with no wave task was not launched by volleyd, so it has no screen.
 */
export function terminalProps(
  agent: AgentView,
  wave: WaveView | undefined,
  noSignal: NoSignal | null,
): { screen: AgentView["screen"]; stale: boolean; noSignal: boolean; selfRegistered: boolean } {
  const task = agent.task ? wave?.state?.tasks.find((t) => t.id === agent.task) : undefined;
  return {
    screen: agent.screen,
    stale: task?.screen_stale === true,
    noSignal: noSignal?.kind === "mcp",
    selfRegistered: agent.wave === UNASSIGNED || !agent.task,
  };
}

/** Context meter tones: compaction risk as the window fills. */
export const CTX_HOT_PCT = 85;
export const CTX_WARN_PCT = 65;
/** From here the meter's bar pulses (slowly; fast once hot): compaction is getting close. */
export const CTX_PULSE_PCT = 70;

/** `143K`, `1M`, `1.5M`. */
function tokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  return `${Math.round(n / 1000)}K`;
}

/** The footer's context meter for a usage sample, or `null` while nothing is known. */
export function contextMeter(usage: UsagePayload | null | undefined): {
  pct: number;
  tone: "ok" | "warn" | "hot";
  pulse: "none" | "slow" | "fast";
  text: string;
} | null {
  const cw = usage?.context_window;
  if (!cw) return null;
  const { used, size } = cw;
  const raw = cw.used_percentage ?? (used !== null && size ? (used / size) * 100 : null);
  if (raw === null) return null;
  const pct = Math.round(Math.max(0, Math.min(100, raw)));
  const tone = pct >= CTX_HOT_PCT ? "hot" : pct >= CTX_WARN_PCT ? "warn" : "ok";
  const pulse = tone === "hot" ? "fast" : pct >= CTX_PULSE_PCT ? "slow" : "none";
  const amounts = used !== null && size ? ` · ${tokens(used)}/${tokens(size)}` : "";
  return { pct, tone, pulse, text: `ctx ${pct}%${amounts}` };
}

/**
 * `Work · 34% · peer-a`; `Fresh · no usage yet · this machine` until the account has reported
 * usage (`fiveHourLabel`).
 */
const choiceLabel = (a: AccountChoice) =>
  `${a.label} · ${fiveHourLabel(a.fivePct, a.weeklyPct)} · ${machineName(a.machine)}`;

/** `5h 12%, 7d 40%`, as the Settings card's `accountFigures`; `no usage yet` without. */
const choiceFigures = (a: AccountChoice | undefined) => {
  const bits = [
    ...(a && a.fivePct !== null ? [`5h ${Math.round(a.fivePct)}%`] : []),
    ...(a && a.weeklyPct !== null ? [`7d ${Math.round(a.weeklyPct)}%`] : []),
  ];
  return bits.length ? bits.join(", ") : NO_USAGE_YET;
};

/**
 * The title's account picker. The current account is the usage sample's (else
 * the registry's `claude_account`); picking another confirms, then moves. Its
 * tooltip (hover / focus, `MachineChip`'s pattern) says why it runs there.
 */
function AccountPicker({
  name,
  current,
  accounts,
  why,
  onMove,
}: {
  name: string;
  current: string | null;
  accounts: readonly AccountChoice[];
  why: string | null;
  onMove: AgentWindowProps["onMoveAccount"];
}) {
  const tipId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (acct: string) => {
    const to = accounts.find((a) => a.id === acct);
    if (!onMove || !to || acct === current) return;
    if (!window.confirm(`Move ${name} to ${to.label}? It restarts with a resume note.`)) return;
    setBusy(true);
    setError(null);
    const r = await onMove(acct);
    setBusy(false);
    if (r && !r.ok) setError(r.error ?? "volleyd refused the move");
  };
  const own = accounts.find((a) => a.id === current);
  return (
    <span className="acct-pick-wrap">
      <select
        className="acct-pick"
        aria-label={`Claude account for ${name}`}
        aria-describedby={tipId}
        value={current ?? ""}
        disabled={!onMove || busy}
        onChange={(e) => void pick(e.target.value)}
      >
        {current === null && <option value="">Account…</option>}
        {current !== null && !accounts.some((a) => a.id === current) && (
          <option value={current}>{current}</option>
        )}
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {choiceLabel(a)}
          </option>
        ))}
      </select>
      <div role="tooltip" id={tipId} className="host-pop acct-tip">
        <p className="host-rule">{own ? choiceLabel(own) : (current ?? "no account known yet")}</p>
        <p className="dim">{why ?? "why this account: not seen since the Desk loaded"}</p>
        <p className="dim">Pick another to move it (it restarts with a resume note).</p>
      </div>
      {error && (
        <span className="acct-err" role="alert" title={error}>
          Move failed: {error}
        </span>
      )}
    </span>
  );
}

/**
 * An open `agent_account_limit` on the agent: while autopilot is on, what it will do; else (or
 * with nothing to move to) the decision's own answers.
 */
function AccountLimitBanner({
  d,
  autopilot,
  accounts,
  onResolve,
}: {
  d: DecisionPayload;
  autopilot: boolean;
  accounts: readonly AccountChoice[];
  onResolve: AgentWindowProps["onResolve"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = moveOption(d);
  const at = `account at ${Math.round(d.pct ?? 0)}%`;
  const answer = async (text: string) => {
    if (!onResolve) return;
    setBusy(true);
    setError(null);
    const r = await onResolve(d, text);
    setBusy(false);
    if (!r.ok) setError(r.error ?? "volleyd refused the answer");
  };
  const line = autopilot
    ? d.suggested
      ? `${at} — autopilot will move it to ${d.suggested}`
      : `${at} — no other login on its machine has room; it finishes where it is`
    : d.suggested
      ? `${at} — move it to ${d.suggested}?`
      : `${at} — no other login on its machine has room`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a banner live region, as the Needs-you banners
    <div className="a-limit" role="status" aria-label="Claude account limit">
      <span className="a-limit-line">{line}</span>
      {!autopilot && onResolve && (
        <span className="a-limit-actions">
          {move && d.suggested && (
            <button
              type="button"
              className="btn btn--hot"
              disabled={busy}
              onClick={() => void answer(move)}
            >
              Move to {d.suggested} ({choiceFigures(accounts.find((a) => a.id === d.suggested))})
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void answer(notNowAnswer(d))}
          >
            Not now
          </button>
        </span>
      )}
      {error && (
        <span className="acct-err" role="alert" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

/** The prototype's `ago`: `42s`, `3m`, `1.5h`. */
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const Icon = ({ i, s = 15 }: { i: typeof BubbleChatIcon; s?: number }) => (
  <HugeiconsIcon icon={i} size={s} strokeWidth={1.8} />
);

const AGENT_TABS = [
  { key: "feed", label: "Volley feed", icon: <Icon i={ListViewIcon} s={13} /> },
  { key: "term", label: "Terminal", icon: <Icon i={TerminalIcon} s={13} /> },
] as const;

/** The footer's progress bar and percentage (a session has none: it reports no %). */
function ProgressBar({ name, progress }: { name: string; progress: number | null }) {
  return (
    <>
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
    </>
  );
}

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
  icons = "clawd",
  attentionTier = "none",
  attention,
  onChat,
  steerOpen = false,
  steer,
  noSignal = null,
  syncing = false,
  stageChip = null,
  usage = null,
  accounts = [],
  onMoveAccount,
  stale = null,
  onPopout,
  machine = null,
  onOpenMachine,
  accountEvents = [],
  accountLimit = null,
  onResolve,
}: AgentWindowProps) {
  const now = useNow(fixedNow);
  const [tab, setTab] = useState<"feed" | "term">("feed");
  const tabsId = useId();
  const accent = agent.wave === UNASSIGNED ? NEUTRAL_ACCENT : waveAccent;
  const ws = wave?.state ?? null;
  const task = agent.task ? ws?.tasks.find((t) => t.id === agent.task) : undefined;
  const spec = agent.task ? ws?.spec?.tasks[agent.task] : undefined;
  const issue = task?.issue ?? spec?.issue;
  const purpose = purposeOf(agent, wave);
  const named = namesWindow(purpose);
  const session = isSession(agent);
  const [purposeOpen, setPurposeOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  // The title's name: the purpose when it names the window, else the task (or the id) as before.
  const headline = named ? purpose.label : (agent.task ?? agent.id);
  const progress = agent.progress === null ? null : Math.max(0, Math.min(100, agent.progress));
  const status = markStatus(agent);
  const hbAge = agent.heartbeat === null ? null : now - agent.heartbeat;
  const hbStale = hbAge === null || hbAge > HEARTBEAT_STALE_MS;
  const born = agent.bornAt !== null && now - agent.bornAt < BORN_MS;
  const mcpMissing = noSignal?.kind === "mcp";
  const asOf =
    agent.narrationRestored && agent.narration !== null && agent.narrationAt !== undefined
      ? new Date(agent.narrationAt).toTimeString().slice(0, 5)
      : null;

  const title = (
    <>
      {icons !== "classic" ? (
        <ClawdSprite
          agentId={agent.id}
          state={clawdState({
            agent,
            stage: task?.stage ?? null,
            tier: attentionTier,
            noSignal: mcpMissing,
            session,
          })}
          size={24}
        />
      ) : mcpMissing ? (
        <StatusMark status="pending" color={NO_SIGNAL_GREY} size={18} className="sm-nosignal" />
      ) : (
        <StatusMark
          status={status}
          {...(progress === null ? {} : { progress: progress / 100 })}
          color={accent}
          size={18}
        />
      )}
      {session ? (
        <span className="chip chip--session" title="An interactive Claude Code session">
          session
        </span>
      ) : (
        <span className="chip chip--wave" title={`Linked to wave ${agent.wave}`}>
          <i style={{ background: accent }} />
          {agent.wave}
        </span>
      )}
      {agent.role && <span className="chip chip--role">{ROLE_LABEL[agent.role]}</span>}
      {stageChip && <span className="chip chip--stage">{stageChip}</span>}
      {machine && <MachineChip machine={machine} onOpen={onOpenMachine} />}
    </>
  );

  // The window's accessible name: its wave, task and role (or its title's name).
  // A window named by its purpose is named by it everywhere; an unnamed task keeps `<wave> · <task>`.
  const name = [
    named || !agent.task ? headline : `${agent.wave} · ${agent.task}`,
    agent.role && ROLE_LABEL[agent.role],
  ]
    .filter(Boolean)
    .join(" · ");
  const label = `Message ${[headline, agent.role && ROLE_LABEL[agent.role]]
    .filter(Boolean)
    .join(" ")}`;
  const ctx = contextMeter(usage);
  // Reduced motion keeps the colour change and drops the pulse.
  const ctxPulse = ctx && ctx.pulse !== "none" && !reducedMotion ? ` ctx--pulse-${ctx.pulse}` : "";
  const account = usage?.account ?? str(agent.registry?.claude_account);
  // Only the agent's own machine's accounts: `agent_move_account` refuses any other.
  const choices = machine
    ? choicesFor(accounts, machine.local ? LOCAL_MACHINE : machine.name)
    : accounts;
  const own = accountEventsFor(accountEvents, agent.task, agent.role);
  const nameText = named ? purpose.full : `${headline}${issue !== undefined ? ` #${issue}` : ""}`;
  const subtitle = (
    <>
      <span className="t-head">
        {/* A button so a tap unclamps it: touch has no hover for the `title`. */}
        <button
          type="button"
          className={`t-name${nameOpen ? " t-name--open" : ""}`}
          title={nameText}
          aria-expanded={nameOpen}
          onClick={() => setNameOpen((o) => !o)}
        >
          {headline}
          {!named && issue !== undefined && <span className="dim"> #{issue}</span>}
        </button>
        {purpose.links.map((l) =>
          l.href ? (
            <a
              key={l.text}
              className="a-link"
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={l.label}
            >
              {l.text}
            </a>
          ) : (
            <span key={l.text} className="a-link dim">
              {l.text}
            </span>
          ),
        )}
      </span>
      {choices.length > 0 && (
        <AccountPicker
          name={agent.task ?? headline}
          current={account}
          accounts={choices}
          why={accountWhy(accountEvents, agent.task, agent.role)}
          onMove={onMoveAccount}
        />
      )}
    </>
  );
  const actions = (
    <>
      <button
        type="button"
        className={`icon-btn${steerOpen ? " icon-btn--hot" : ""}`}
        aria-label={label}
        title={label}
        onClick={() => onChat?.(agent.id)}
      >
        <Icon i={BubbleChatIcon} />
      </button>
    </>
  );

  const work = agent.work;
  const footer = (
    <div className="agent-foot">
      {session ? (
        <span className="work mono" title="From this session's hooks: no progress % is reported">
          {/* Nothing heard from its hooks yet (a cold load): no claim either way. */}
          {work ? (
            <span className={`work-state work-state--${work.state}`}>
              {work.state === "idle" ? `idle · ${age(now - work.since)}` : "working"}
            </span>
          ) : (
            <span className="work-state dim">no activity seen yet</span>
          )}
          {" · "}
          {work && work.toolCalls > 0
            ? `${plural(work.toolCalls, "tool call")}${work.lastToolAt === null ? "" : ` · last ${age(now - work.lastToolAt)} ago`}`
            : "no tool calls yet"}
        </span>
      ) : (
        <ProgressBar name={name} progress={progress} />
      )}
      {ctx && (
        <span
          className={`ctx ctx--${ctx.tone}${ctxPulse}`}
          title="Context window used (compaction risk as it fills)"
        >
          <span className="ctx-bar">
            <span style={{ width: `${ctx.pct}%` }} />
          </span>
          <span className="mono">{ctx.text}</span>
        </span>
      )}
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
      subtitle={subtitle}
      label={name}
      accent={accent}
      width={AGENT_WIDTH}
      born={born}
      actions={actions}
      footer={footer}
    >
      {/* Only a purpose that does not name the window: the headline already shows one that does. */}
      {!named && purpose.source !== "id" && (
        <div className={`a-purpose${purposeOpen ? " a-purpose--open" : ""}`}>
          {/* A button so a tap unwraps it: touch has no hover for the `title`. */}
          <button
            type="button"
            className="a-purpose-text ell"
            title={purpose.full}
            aria-expanded={purposeOpen}
            onClick={() => setPurposeOpen((o) => !o)}
          >
            {purpose.label}
          </button>
        </div>
      )}
      {headline !== agent.id && (
        <div className="a-id mono dim ell" title="Agent id">
          {agent.id}
        </div>
      )}
      {stale && (
        <div className="a-stale" title="It has not published progress of its own for this long">
          <span className="chip chip--stale">{stale}</span>
        </div>
      )}
      {agent.task !== null && <Pipeline stage={task?.stage ?? null} agentRole={agent.role} />}
      {/* A session narrates through its hooks' work log. */}
      <Narration text={agent.narration ?? work?.last ?? null} fx={narrationFx} />
      {asOf && (
        <div className="narr-asof dim" title="Restored from this browser's session">
          as of {asOf}
        </div>
      )}
      {syncing ? (
        <div className="a-nosignal a-syncing" title="Waiting for live messages after a reconnect">
          <span className="chip">{SYNCING_LABEL}</span>
        </div>
      ) : (
        noSignal && (
          <div className={`a-nosignal${mcpMissing ? "" : " a-quiet"}`} title={noSignal.title}>
            <span className="chip">
              {mcpMissing && <i style={{ background: NO_SIGNAL_GREY }} />}
              {noSignal.label}
            </span>
          </div>
        )
      )}
      {accountLimit && (
        <AccountLimitBanner
          d={accountLimit}
          autopilot={ws?.autopilot?.enabled === true}
          accounts={accounts}
          onResolve={onResolve}
        />
      )}
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
          <Feed
            feed={own.length ? [...agent.feed, ...own] : agent.feed}
            noSignal={mcpMissing}
            heartbeats={{ count: agent.heartbeats ?? 0, last: agent.heartbeat }}
            now={now}
          />
        ) : (
          <>
            {onPopout && (
              <div className="term-tools">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Open terminal in a window"
                  title="Open in a window"
                  onClick={() => onPopout(agent.id)}
                >
                  ⤢
                </button>
              </div>
            )}
            <Terminal {...terminalProps(agent, wave, noSignal)} />
          </>
        )}
      </div>
      {steer}
    </Frame>
  );
}
