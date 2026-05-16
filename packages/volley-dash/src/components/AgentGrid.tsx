/**
 * AgentGrid — `repeat(auto-fill, minmax(260px, 1fr))` grid of `<AgentCard />`s
 * preceded by the section header (AGENTS label · displayed/total count ·
 * StatusFilters chips). Sort order is fixed by Phase 1's STATUS_ORDER
 * (working > spawning > blocked > failed > registered > done > reaped),
 * then by lastSeen ascending so most-recently-active sits at the top of
 * each status band.
 *
 * Within a status band, agents are ordered by `lastSeen` descending so the
 * most recently active agent sits at the top of its band — matches the
 * "what should I look at right now?" dashboard intuition.
 *
 * Cards reconcile by `agent.id` (React key) so transitions don't re-mount
 * — important for Phase 3 dot/progress animation continuity.
 */
import { useMemo } from "react";
import { STATUS_ORDER } from "../lib/lifecycle-meta";
import type { Agent, AgentId, AgentStatus } from "../types";
import { AgentCard } from "./AgentCard";
import { StatusFilters } from "./StatusFilters";

export interface AgentGridProps {
  agents?: Agent[] | undefined;
  filter?: AgentStatus | "all" | undefined;
  setFilter?: ((next: AgentStatus | "all") => void) | undefined;
  query?: string | undefined;
  selectedId?: AgentId | null | undefined;
  onSelect?: ((id: AgentId) => void) | undefined;
  now?: number | undefined;
  totalCount?: number | undefined;
}

const STATUS_RANK: Record<AgentStatus, number> = (() => {
  const r = {} as Record<AgentStatus, number>;
  STATUS_ORDER.forEach((s, i) => {
    r[s] = i;
  });
  return r;
})();

export function AgentGrid({
  agents = [],
  filter = "all",
  setFilter = () => {},
  query = "",
  selectedId = null,
  onSelect,
  now = Date.now(),
  totalCount,
}: AgentGridProps = {}): JSX.Element {
  const filtered = useMemo(() => {
    let list = agents;
    if (filter !== "all") list = list.filter((a) => a.status === filter);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (a) =>
          a.id.toLowerCase().includes(q) ||
          a.ns.toLowerCase().includes(q) ||
          a.caps.some((c) => c.toLowerCase().includes(q)) ||
          (a.parent?.toLowerCase().includes(q) ?? false) ||
          a.msg.toLowerCase().includes(q),
      );
    }
    return [...list].sort(
      (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.lastSeen - a.lastSeen,
    );
  }, [agents, filter, query]);

  const counts = useMemo(() => {
    const m = { all: agents.length } as Record<AgentStatus | "all", number>;
    for (const s of STATUS_ORDER) m[s] = 0;
    for (const a of agents) m[a.status]++;
    return m;
  }, [agents]);

  const total = totalCount ?? agents.length;

  return (
    <div data-testid="agent-grid">
      <div className="vd-section-hd">
        <h2>AGENTS</h2>
        <span className="vd-count-pill">
          {filtered.length} / {total}
        </span>
        <StatusFilters filter={filter} setFilter={setFilter} counts={counts} />
      </div>
      {filtered.length === 0 && agents.length > 0 ? (
        <div className="vd-no-match">
          no agents match <span className="vd-q">"{query || filter}"</span>{" "}
          <span className="vd-tip">· clear filters to widen scope</span>
        </div>
      ) : (
        <div className="vd-grid">
          {filtered.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              selected={selectedId === a.id}
              now={now}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
