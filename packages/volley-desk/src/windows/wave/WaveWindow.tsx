/**
 * The wave window, ported from the prototype `WaveWindow`: Clawd + wave id +
 * owner chip in the title, chat and gear glyphs (their panels land with the
 * steering panel and settings tasks), a banner slot for the Needs-you / claim
 * banners, the dependency graph above the wave file, and a footer rail with
 * one segment per task, the wave's completion and its counts.
 *
 * A `stopped` or `complete` wave renders dimmed with a `Stopped` / `Complete`
 * chip, its stages as they were (struck through) and its clock frozen at the
 * last state update (`stopped 2.8h ago`). That is an approximation of the stop
 * time: volleyd bumps `updated_at` for every journaled event, so one after
 * `wave_stopped` (an agent reaped, a decision resolved) moves it on; the wave
 * state carries no stop time of its own yet. Each graph node and rail segment
 * says what its task is doing now (`taskActivity`, #451): a running agent
 * (`implementing`, `reviewing`, `fixing`), else a CI hold, else a merge turn,
 * else a decision, else the stage. A task volleyd holds for CI with no agent
 * running (its `why_waiting` is one of volleyd's four hold wordings, `ciPending`)
 * shows `waiting for CI` (`· 3/13` when its jobs are counted) in the graph, a
 * `waiting for CI` chip in the title and a row under the graph with the same
 * words, its pipeline (`implement ✓ · CI ⟳ · review`), the reason and, when no
 * job finished for longer than the slowest job's last duration, `possibly
 * stuck: …` (#415); no agent window is needed for it. On a phone the graph wraps to the window's
 * width (`dagWidthFor`). Under the graph each placed task has a host chip
 * whose popover says why it runs there (`HostChips`).
 *
 * Autopilot (SPEC §4.6.16–19): the title's `autopilot on · N auto · M escalated`
 * (or `autopilot off`) chip from `state.autopilot`; under the graph the merge
 * queue as one line (`merging T3 · updating T5 · queued T7, T9`), the release
 * train's stages while the wave is `releasing`, the synthetic fixer tasks (a
 * wrench, `fixer for T3, T7`) and the wave's autopilot events as a feed.
 */
import { BubbleChatIcon, Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { ciStuck } from "../../attention";
import { Frame, type FrameProps } from "../../canvas/Frame";
import { issueHref } from "../../lib/github";
import { plural } from "../../lib/plural";
import { RepoChip } from "../../look/RepoChip";
import { fixerFor, mergeQueueLine } from "../../store/autopilot";
import type {
  AgentView,
  CoordinatorState,
  FeedEntry,
  WaveRelease,
  WaveStatePayload,
  WaveView,
} from "../../store/types";
import { Feed } from "../agent/Feed";
import { Clawd } from "./Clawd";
import { Dag, type DagNode, HostChips, fixerLabel } from "./Dag";
import { WaveYaml, taskOrder } from "./WaveYaml";
import { accentFor } from "./accent";
import { taskActivity } from "./activity";
import { STAGE_LABEL, STAGE_WEIGHT, deskStage, wavePct } from "./stages";
import "../../styles/wave.css";

export const WAVE_W = 620;
/** The window body's horizontal padding (desk.css `.win-body`), left plus right. */
const BODY_PAD_X = 28;

/** The graph's width inside a wave window capped at `maxWidth` (a phone). */
export function dagWidthFor(maxWidth: number): number {
  return Math.min(WAVE_W, maxWidth) - BODY_PAD_X;
}

const ENDED_CHIP: Partial<Record<WaveStatePayload["status"], string>> = {
  stopped: "Stopped",
  complete: "Complete",
  archived: "Archived",
};

export interface WaveWindowProps {
  wave: WaveView;
  /** This browser's coordinator agent id (`?me=`); `null` = no wave is mine. */
  me: string | null;
  /** The Desk's broker identity: a wave it owns (it claimed it) is mine too. */
  identity?: string | null | undefined;
  /** The store's view of the owner coordinator; falls back to the wave state's `coordinator`. */
  coordinatorState?: CoordinatorState | undefined;
  /** ms when the wave started (its earliest agent); omitted → no age shown. */
  startedAt?: number | null | undefined;
  /** Fixed clock for tests; otherwise the window re-renders every 5 s. */
  now?: number;
  frame: Omit<
    FrameProps,
    "id" | "title" | "label" | "accent" | "width" | "actions" | "footer" | "children"
  >;
  /** Needs-you / claim banners, shown above the graph. */
  banner?: ReactNode;
  /** The wave's autopilot events (`waveFeed`), shown as a feed under the graph. */
  autopilotFeed?: readonly FeedEntry[] | undefined;
  /** The Desk's agent records: a task's agent counts as running only while its record is live. */
  agents?: Readonly<Record<string, AgentView>>;
  /** Children after the wave file (the steering panel). */
  children?: ReactNode;
  /** Highlights the chat glyph while the steering panel is open. */
  steerOpen?: boolean;
  onChat?: (wave: string) => void;
  onSettings?: (wave: string) => void;
}

/** Desk read of `?me=<agent_id>`: the coordinator this browser speaks for. */
export function meFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("me") || null;
}

/** The wave is this browser's: owned by its coordinator (`?me=`) or by the Desk itself (claimed). */
export function isMine(
  owner: string | null | undefined,
  me: string | null,
  identity?: string | null,
): boolean {
  return !!owner && (owner === me || owner === identity);
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}

function useNow(fixed: number | undefined, ms = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [fixed, ms]);
  return fixed ?? now;
}

export function IconBtn(p: {
  label: string;
  i: typeof BubbleChatIcon;
  onClick: () => void;
  hot?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-btn${p.hot ? " icon-btn--hot" : ""}`}
      onClick={p.onClick}
      aria-label={p.label}
      title={p.label}
    >
      <HugeiconsIcon icon={p.i} size={15} strokeWidth={1.8} />
    </button>
  );
}

/**
 * Graph nodes in wave-file order (`taskOrder`). A cancelled task the spec still
 * lists is flagged `cancelled`; one the spec no longer lists was removed by a
 * plan change and is dropped. With the state's `github`, each node links its issue.
 */
export function dagNodes(s: WaveStatePayload): DagNode[] {
  const spec = s.spec?.tasks ?? {};
  const state = new Map(s.tasks.map((t) => [t.id, t]));
  const href = (n: number) => {
    const h = issueHref(s.github, n);
    return h !== null ? { issueHref: h } : {};
  };
  return taskOrder(s).flatMap((id): DagNode[] => {
    const t = state.get(id);
    const sp = spec[id];
    if (!sp) {
      if (!t || t.stage === "cancelled") return [];
      const fixes = fixerFor(t);
      return [
        {
          id,
          issue: t.issue,
          after: [],
          stage: deskStage(t.stage),
          ...(fixes ? { fixerFor: fixes } : {}),
          ...href(t.issue),
        },
      ];
    }
    return [
      {
        id,
        issue: sp.issue,
        after: sp.after,
        stage: t ? deskStage(t.stage) : "queued",
        ...(sp.title ? { title: sp.title } : {}),
        ...(t?.stage === "cancelled" ? { cancelled: true } : {}),
        ...href(sp.issue),
      },
    ];
  });
}

/** The header chip: `autopilot on · 4 auto · 1 escalated`, or `autopilot off`. */
export function autopilotChip(a: NonNullable<WaveStatePayload["autopilot"]>): string {
  return a.enabled
    ? `autopilot on · ${a.auto_resolved} auto · ${a.escalated} escalated`
    : "autopilot off";
}

/** The chip in a compact window: `⚙ 4 · ↑ 1` (auto-resolved, escalated), or `⚙ off`. */
export function autopilotTokens(a: NonNullable<WaveStatePayload["autopilot"]>): string {
  return a.enabled ? `⚙ ${a.auto_resolved} · ↑ ${a.escalated}` : "⚙ off";
}

/** The release train's stages as plain rows (the inbox's release item draws the Stepper). */
function TrainRows({ release }: { release: WaveRelease }) {
  return (
    <ul className="wave-train" aria-label="Release train">
      {release.stages.map((st) => (
        <li
          key={st.name}
          className={`train-${st.state}`}
          {...(st.name === release.stage ? { "aria-current": "step" as const } : {})}
        >
          <span className="mono">{st.name}</span> · {st.state.replaceAll("_", " ")}
        </li>
      ))}
    </ul>
  );
}

export function WaveWindow(p: WaveWindowProps) {
  const now = useNow(p.now);
  const s = p.wave.state;
  const id = p.wave.id;
  const accent = accentFor(id);
  const waiting = (p.coordinatorState ?? s?.coordinator?.state) === "awaiting_input";
  const mine = isMine(s?.owner, p.me, p.identity);
  const tasks = s ? dagNodes(s) : [];
  // Cancelled tasks never run, so they stay out of the rail and the progress maths.
  const live = tasks.filter((t) => !t.cancelled);
  const pct = wavePct(live.map((t) => t.stage));
  const merged = live.filter((t) => t.stage === "merged").length;
  // Count unresolved decisions from the store, not state.open_decisions: a resolved decision can linger in the
  // retained state until the supervisor re-publishes it (D0 fixup, "ghost" decisions).
  const openDecisions = Object.values(p.wave.decisions).filter((d) => !d.resolved).length;
  const ended = s ? ENDED_CHIP[s.status] : undefined;
  // Frozen at the last state update: the supervisor published it when the wave ended.
  const endedAt = Date.parse(s?.updated_at ?? "");
  const fixers = tasks.filter((t) => t.fixerFor && !t.cancelled);
  const queue = s?.merge_queue ?? [];
  const activity = new Map(
    (s?.tasks ?? []).map((t) => [t.id, taskActivity(t, { agent: (a) => p.agents?.[a], queue })]),
  );
  const ci = s?.tasks.filter((t) => activity.get(t.id)?.kind === "ci") ?? [];
  const labels = Object.fromEntries([...activity].map(([t, a]) => [t, a.node]));

  const title = (
    <>
      <Clawd waiting={waiting} />
      <span className="t-name">{id}</span>
      {s && (
        <span className={`chip${mine ? " chip--mine" : ""}`} title={`owner: ${s.owner ?? "none"}`}>
          {mine ? "★ yours" : (s.owner ?? "no owner")}
        </span>
      )}
      <RepoChip github={s?.github} />
      {ended && <span className="chip chip--ended">{ended}</span>}
      {s?.autopilot && (
        // Never ellipsized: the full sentence, or its tokens in a compact window (desk.css).
        <span
          className={`chip chip--autopilot${s.autopilot.enabled ? "" : " chip--off"}`}
          title={autopilotChip(s.autopilot)}
        >
          <span className="ap-full">{autopilotChip(s.autopilot)}</span>
          <span className="ap-short" aria-hidden="true">
            {autopilotTokens(s.autopilot)}
          </span>
        </span>
      )}
      {!ended && ci.length > 0 && (
        <span
          className="chip chip--ci"
          title={ci.map((t) => `${t.id}: ${t.why_waiting}`).join("\n")}
        >
          waiting for CI
        </span>
      )}
    </>
  );

  const actions = (
    <>
      <IconBtn
        label={`Message the coordinator of ${id}`}
        i={BubbleChatIcon}
        onClick={() => p.onChat?.(id)}
        hot={p.steerOpen ?? false}
      />
      <IconBtn label={`Settings for ${id}`} i={Settings02Icon} onClick={() => p.onSettings?.(id)} />
    </>
  );

  const footer = s && (
    <div className={`rail${ended ? " wave-ended" : ""}`}>
      {/* biome-ignore lint/a11y/useFocusableInteractive: a progressbar is a read-only status, not a control */}
      <div
        className="rail-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${id} progress`}
      >
        {live.map((t) => (
          <span
            key={t.id}
            className={`rail-seg st-${t.stage}`}
            title={`${t.id} · ${activity.get(t.id)?.label ?? STAGE_LABEL[t.stage]}`}
          >
            <span style={{ width: `${STAGE_WEIGHT[t.stage] * 100}%` }} />
          </span>
        ))}
      </div>
      <div className="rail-meta">
        <span className="rail-pct">{pct}%</span>
        <span>
          {merged} of {live.length} merged
        </span>
        <span>
          {plural(openDecisions, "decision")} · {plural(s.gates.length, "gate")}
        </span>
        {ended
          ? !Number.isNaN(endedAt) && (
              <span className="mono dim">
                {s.status} {ago(now - endedAt)} ago
              </span>
            )
          : p.startedAt != null && (
              <span className="mono dim">running {ago(now - p.startedAt)}</span>
            )}
      </div>
    </div>
  );

  return (
    <Frame
      {...p.frame}
      id={id}
      title={title}
      label={id}
      accent={accent}
      width={WAVE_W}
      actions={actions}
      footer={footer}
    >
      {p.banner}
      {s ? (
        <div className={`wave-grid${ended ? " wave-ended" : ""}`}>
          <div className="min0">
            <div className="lbl">Dependency graph</div>
            <Dag
              tasks={tasks}
              accent={accent}
              ended={!!ended}
              labels={labels}
              maxWidth={p.frame.maxWidth === undefined ? undefined : dagWidthFor(p.frame.maxWidth)}
            />
            <HostChips tasks={s.tasks} />
            {!ended && queue.length > 0 && (
              <p className="wave-queue" aria-label="Merge queue">
                <span className="dim">merge queue</span> {mergeQueueLine(queue)}
              </p>
            )}
            {s.status === "releasing" && s.release && <TrainRows release={s.release} />}
            {fixers.length > 0 && (
              <ul className="wave-fixers" aria-label="Fixer tasks">
                {fixers.map((t) => (
                  <li key={t.id}>
                    <span aria-hidden="true">🔧</span> <span className="mono">{t.id}</span>{" "}
                    <span className="dim">{fixerLabel(t.fixerFor ?? [])}</span>
                  </li>
                ))}
              </ul>
            )}
            {p.autopilotFeed && p.autopilotFeed.length > 0 && (
              <>
                <div className="lbl">Autopilot</div>
                <Feed feed={p.autopilotFeed} />
              </>
            )}
            {!ended && ci.length > 0 && (
              <ul className="wave-ci">
                {ci.map((t) => (
                  <li key={t.id} aria-label={`${t.id} CI pending`}>
                    <span className="mono">{t.id}</span>
                    <span className="wave-ci-what">{activity.get(t.id)?.label}</span>
                    <span className="wave-ci-pipe">implement ✓ · CI ⟳ · review</span>
                    <span className="dim">{t.why_waiting}</span>
                    {ciStuck(t, now) && <span className="wave-ci-stuck">{ciStuck(t, now)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min0">
            <div className="lbl">
              Wave file <span className="dim mono">v{s.spec?.version ?? s.version}</span>
            </div>
            <WaveYaml wave={s} />
          </div>
        </div>
      ) : (
        <div className="dim">waiting for wave state</div>
      )}
      {p.children}
    </Frame>
  );
}
