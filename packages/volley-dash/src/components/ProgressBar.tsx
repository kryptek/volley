/**
 * ProgressBar — single visualisation across all 7 status states per the
 * handoff "Progress bar + foot label" table.
 */
import type { AgentStatus } from "../types";

export interface ProgressBarProps {
  status: AgentStatus;
  pct: number | null;
}

export function ProgressBar({ status, pct }: ProgressBarProps): JSX.Element {
  if (status === "working" && pct != null) {
    return (
      <div className="vd-progress-track">
        <i style={{ width: `${clampPct(pct)}%` }} />
      </div>
    );
  }
  if (status === "working" || status === "spawning") {
    return (
      <div className="vd-progress-track" data-variant="indeterminate">
        <i />
      </div>
    );
  }
  if (status === "done") {
    return (
      <div className="vd-progress-track">
        <i style={{ width: "100%" }} />
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="vd-progress-track" data-variant="failed">
        <i style={{ width: "100%" }} />
      </div>
    );
  }
  if (status === "blocked") {
    return (
      <div className="vd-progress-track" data-variant="blocked">
        <i style={{ width: `${clampPct(pct ?? 50)}%` }} />
      </div>
    );
  }
  if (status === "reaped") {
    return (
      <div className="vd-progress-track" data-variant="reaped">
        <i style={{ width: "100%" }} />
      </div>
    );
  }
  // registered (and any unknown future status): empty track.
  return (
    <div className="vd-progress-track">
      <i style={{ width: 0 }} />
    </div>
  );
}

export function progressLabel(status: AgentStatus, pct: number | null): string {
  switch (status) {
    case "working":
      return pct != null ? `${Math.round(pct)}%` : "running";
    case "done":
      return "✓ done";
    case "failed":
      return "✗ exit 1";
    case "blocked":
      return "⏸ waiting";
    case "reaped":
      return "◌ reaped";
    case "spawning":
      return "starting…";
    case "registered":
      return "ready";
    default:
      return "";
  }
}

function clampPct(p: number): number {
  if (Number.isNaN(p)) return 0;
  return Math.max(0, Math.min(100, p));
}
