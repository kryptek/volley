/**
 * The overlap plan's clusters under the wave's graph (wave-state `overlap_plan`): one row per
 * cluster with its id, member count, the files its tasks share (`src/daemon.ts · 11k · 14
 * tasks`), its strategy (`5 bundles · 2 chains · cap 4`), its state (`planned`, `hold`,
 * `train`) and why. The heading collapses and expands the list. In a compact window (a phone)
 * each row is just the id and the state. A wave without a plan shows nothing.
 */
import { type CSSProperties, useState } from "react";
import { plural } from "../../lib/plural";
import { strategyLine } from "../../store/autopilot";
import type { PlanCluster } from "../../store/types";

/** A hot file: its last two path segments, its size and how many tasks share it. */
export function hotLine(h: PlanCluster["hot"][number]): string {
  const name = h.file.split("/").slice(-2).join("/");
  const size = h.bytes < 1000 ? `${h.bytes} B` : `${Math.round(h.bytes / 1000)}k`;
  return `${name} · ${size} · ${plural(h.shared_by.length, "task")}`;
}

export function Clusters({
  clusters,
  hues,
  compact = false,
}: {
  clusters: readonly PlanCluster[] | undefined;
  /** Each cluster's palette hue, as its graph hull shows it. */
  hues: ReadonlyMap<string, string>;
  /** A phone: each row collapses to the cluster id and its state. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (!clusters?.length) return null;
  return (
    <section className={`clusters${compact ? " clusters--compact" : ""}`} aria-label="Clusters">
      <button
        type="button"
        className="lbl clusters-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Clusters <span className="dim">{clusters.length}</span>
      </button>
      {open && (
        <ul className="clusters-rows">
          {clusters.map((c) => {
            const hue = hues.get(c.id);
            return (
              <li key={c.id} className={`cluster-row cluster-${c.state}`}>
                <span
                  className="mono cluster-id"
                  style={hue ? ({ "--hue": hue } as CSSProperties) : undefined}
                >
                  {c.id}
                </span>
                {compact ? (
                  <>
                    {" · "}
                    <span className="cluster-state">{c.state}</span>
                  </>
                ) : (
                  <>
                    <span className="dim">{plural(c.tasks.length, "task")}</span>
                    {c.hot.length > 0 && (
                      <span
                        className="mono cluster-hot"
                        title={c.hot.map((h) => h.file).join("\n")}
                      >
                        {c.hot.map(hotLine).join(", ")}
                      </span>
                    )}
                    <span className="cluster-strategy">{strategyLine(c.strategy)}</span>
                    <span className="cluster-state">{c.state}</span>
                    {c.why && <span className="dim cluster-why">{c.why}</span>}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
