/**
 * StatusFilters — the row of status chips that lives under the TopBar and
 * above the AgentGrid. One "all" chip + one per status that has at least
 * one agent (per handoff §Section header). Clicking the active chip clears
 * the filter; clicking another swaps to it.
 */
import { STATUS_META, STATUS_ORDER } from "../lib/lifecycle-meta";
import type { AgentStatus } from "../types";

export interface StatusFiltersProps {
  filter: AgentStatus | "all";
  setFilter: (next: AgentStatus | "all") => void;
  counts: Record<AgentStatus | "all", number>;
}

export function StatusFilters({ filter, setFilter, counts }: StatusFiltersProps): JSX.Element {
  return (
    <div
      className="vd-filter-chips"
      data-testid="status-filters"
      role="toolbar"
      aria-label="Status filter"
    >
      <button
        type="button"
        className="vd-filter-chip"
        data-on={filter === "all" ? "1" : "0"}
        onClick={() => setFilter("all")}
      >
        all <span className="vd-chip-count">{counts.all}</span>
      </button>
      {STATUS_ORDER.map((s) =>
        counts[s] ? (
          <button
            type="button"
            key={s}
            className="vd-filter-chip"
            data-on={filter === s ? "1" : "0"}
            data-status={s}
            onClick={() => setFilter(filter === s ? "all" : s)}
            style={{ "--c-st": STATUS_META[s].color } as React.CSSProperties}
          >
            <span className="vd-swatch" />
            {s} <span className="vd-chip-count">{counts[s]}</span>
          </button>
        ) : null,
      )}
    </div>
  );
}
