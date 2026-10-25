/**
 * The CI panel (#488): a task held for CI with no agent running gets this small window, cabled
 * to its wave window like an agent window and placed in an agent slot. It shows the task and its
 * PR, a jobs progress bar with volleyd's estimate (the same jobs and estimate as the wave
 * window's CI row), the jobs still running, the failed ones in red, and a link to the PR's
 * checks. A hold with no readable jobs (`CI pending on …`, `CI unreadable …`, `CI infra
 * incident …`) shows its `why_waiting` sentence instead of the bar. Everything comes from the
 * wave state: the wave state has no per-run URL, so the link is the PR's checks tab. In a wave
 * on a repository with no CI (`ci_mode: none`, #602), a task verified without CI says so instead:
 * no bar and no checks link (there are no checks).
 */
import { Frame, type FrameProps } from "../../canvas/Frame";
import { prHref } from "../../lib/github";
import type { WaveTask } from "../../store/types";
import { AGENT_WIDTH } from "../agent/AgentWindow";

/** volleyd's estimate as `why_waiting` words it (`ci-jobs.ts`): `~8 min left`, `<1 min left`, or nothing. */
export function etaLabel(eta_s?: number): string {
  if (eta_s === undefined || !Number.isFinite(eta_s)) return "";
  return eta_s < 60 ? "<1 min left" : `~${Math.round(eta_s / 60)} min left`;
}

/** What stands in for CI in a repository with none (`ci_mode: none`, SPEC §4.6.8). */
export const NO_CI_CHECK = "the reviewers and the gate are the check";

/** The panel's window id: `<wave>/ci/<task>`. */
export const ciPanelId = (wave: string, task: string) => `${wave}/ci/${task}`;

export interface CiPanelProps {
  task: WaveTask;
  wave: string;
  /** The wave's `ci_mode` (absent: an older supervisor, read as `workflows`). */
  ciMode?: string | undefined;
  accent: string;
  frame: Omit<
    FrameProps,
    "id" | "title" | "label" | "accent" | "width" | "actions" | "footer" | "children"
  >;
}

export function CiPanel({ task, wave, ciMode, accent, frame }: CiPanelProps) {
  const pr = task.pr;
  const noCi = ciMode === "none" && pr?.ci === "none";
  const jobs = pr?.jobs && pr.jobs.total > 0 ? pr.jobs : undefined;
  const href = prHref(task);
  const eta = etaLabel(pr?.eta_s);
  return (
    <Frame
      {...frame}
      id={ciPanelId(wave, task.id)}
      label={`${task.id} CI`}
      title={
        <>
          <span className="t-name">{pr ? `${task.id} · #${pr.number}` : task.id}</span>
          <span className="chip chip--ci">{noCi ? "no CI" : "waiting for CI"}</span>
        </>
      }
      accent={accent}
      width={AGENT_WIDTH}
    >
      <div className="ci-panel">
        {noCi ? (
          <p className="ci-none">{`no CI · ${NO_CI_CHECK}`}</p>
        ) : jobs ? (
          <>
            {/* biome-ignore lint/a11y/useFocusableInteractive: a progressbar is read, not operated; it takes no focus */}
            <div
              className="ci-bar"
              role="progressbar"
              aria-label={`${task.id} CI jobs`}
              aria-valuemin={0}
              aria-valuenow={jobs.done}
              aria-valuemax={jobs.total}
            >
              <span style={{ width: `${Math.min(100, (jobs.done / jobs.total) * 100)}%` }} />
            </div>
            <p className="ci-jobs">
              {`${jobs.done}/${jobs.total} jobs`}
              {eta && ` · ${eta}`}
            </p>
            {jobs.running.length > 0 ? (
              <>
                <h4 className="ci-label" id={`${ciPanelId(wave, task.id)}-running`}>
                  running
                </h4>
                <ul className="ci-list" aria-labelledby={`${ciPanelId(wave, task.id)}-running`}>
                  {jobs.running.map((j) => (
                    <li key={j} className="ci-running">
                      {j}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              jobs.done < jobs.total && <p className="ci-label">queued</p>
            )}
            {jobs.failed.length > 0 && (
              <>
                <h4 className="ci-label" id={`${ciPanelId(wave, task.id)}-failed`}>
                  failed
                </h4>
                <ul className="ci-list" aria-labelledby={`${ciPanelId(wave, task.id)}-failed`}>
                  {jobs.failed.map((j) => (
                    <li key={j} className="ci-failed">
                      {j}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="ci-why">{task.why_waiting}</p>
        )}
        {href && pr && !noCi && (
          <a className="ci-link" href={`${href}/checks`} target="_blank" rel="noreferrer">
            Checks for PR #{pr.number} on GitHub
          </a>
        )}
      </div>
    </Frame>
  );
}
