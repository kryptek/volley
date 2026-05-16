/**
 * AgentCard — single tile in the AgentGrid. Anatomy follows the design
 * handoff §"Agent card anatomy": 2px status edge (rendered via CSS
 * pseudo-element using inline `--c-st`), status dot + agent id + status
 * badge in the header, relative-time + parent meta row, 2-line clamped
 * progress message, capability tags, progress bar + foot label.
 *
 * Reconciles by `agent.id` (the parent uses it as React key) so transitions
 * between status states preserve component identity — important for Phase 3
 * when the dot pulse / progress-sweep animations need continuity.
 */
import { STATUS_META } from "../lib/lifecycle-meta";
import { relTime } from "../lib/rel-time";
import type { Agent } from "../types";
import { ProgressBar, progressLabel } from "./ProgressBar";

export interface AgentCardProps {
  agent: Agent;
  selected?: boolean | undefined;
  now?: number | undefined;
  onSelect?: ((id: Agent["id"]) => void) | undefined;
}

export function AgentCard({
  agent,
  selected = false,
  now = Date.now(),
  onSelect,
}: AgentCardProps): JSX.Element {
  const meta = STATUS_META[agent.status];
  const cssVars = { "--c-st": meta.color } as React.CSSProperties;
  const seen = relTime(agent.lastSeen, now);
  return (
    <button
      type="button"
      data-testid={`agent-card-${agent.id}`}
      data-agent-id={agent.id}
      data-status={agent.status}
      data-selected={selected ? "1" : "0"}
      className="vd-card"
      style={cssVars}
      onClick={() => onSelect?.(agent.id)}
    >
      <div className="vd-card-hd">
        <span data-testid="status-dot" data-status={agent.status} className="vd-status-dot" />
        <span className="vd-card-id">{agent.id}</span>
        <span className="vd-status-label">{meta.label}</span>
      </div>

      <div className="vd-card-meta">
        <span className="vd-seen">{seen}</span>
        {agent.parent !== null && (
          <span className="vd-parent">
            <span className="vd-parent-id">{agent.parent}</span>
          </span>
        )}
      </div>

      <div className="vd-card-msg">
        <span className="vd-ghost">$ </span>
        {agent.msg}
      </div>

      <div className="vd-tags">
        {agent.caps.map((c) => (
          <span key={c} className="vd-tag">
            {c}
          </span>
        ))}
      </div>

      <div className="vd-card-foot">
        <ProgressBar status={agent.status} pct={agent.pct} />
        <span className="vd-pct">{progressLabel(agent.status, agent.pct)}</span>
      </div>
    </button>
  );
}
