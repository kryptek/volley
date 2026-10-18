/**
 * The wave's dependency graph, ported from the prototype `Dag`: one column per
 * dependency depth (a task sits one column right of its deepest `after`),
 * tasks in wave-file order within a column, each column centred vertically,
 * and cubic edges from a task's right edge to its dependents' left edge. The
 * layout is split out as the pure `layoutDag`.
 */
import { type DeskStage, STAGE_LABEL } from "./stages";

export interface DagNode {
  id: string;
  issue: number;
  title?: string;
  after: string[];
  stage: DeskStage;
  /** Cancelled by a plan change: drawn faded, labelled `cancelled`, kept out of progress. */
  cancelled?: boolean;
}

export interface DagLayout {
  cols: number;
  nodes: (DagNode & { col: number; row: number; x: number; y: number })[];
  edges: { from: string; to: string; d: string }[];
  width: number;
  height: number;
}

const W = 132;
const H = 44;
const GX = 40;
const GY = 14;

export function layoutDag(tasks: readonly DagNode[]): DagLayout {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const d = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // A dependency cycle is a malformed wave file; break it rather than recurse forever.
    if (visiting.has(id)) return -1;
    visiting.add(id);
    const deps = (byId.get(id)?.after ?? []).filter((a) => byId.has(a));
    const n = Math.max(0, deps.length ? 1 + Math.max(...deps.map(d)) : 0);
    visiting.delete(id);
    depth.set(id, n);
    return n;
  };

  const cols: DagNode[][] = [];
  for (const t of tasks) {
    const c = d(t.id);
    const list = cols[c] ?? [];
    list.push(t);
    cols[c] = list;
  }
  const ncol = cols.length;
  const maxRows = Math.max(0, ...cols.map((c) => c?.length ?? 0));

  const at = new Map<string, DagLayout["nodes"][number]>();
  cols.forEach((list, col) => {
    const off = ((maxRows - list.length) * (H + GY)) / 2;
    list.forEach((t, row) => {
      at.set(t.id, { ...t, col, row, x: 4 + col * (W + GX), y: 4 + off + row * (H + GY) });
    });
  });
  // Keep wave-file order so the DOM follows the file.
  const nodes = tasks.flatMap((t) => at.get(t.id) ?? []);

  const edges: DagLayout["edges"] = [];
  for (const e of nodes) {
    for (const a of e.after) {
      const s = at.get(a);
      if (!s) continue;
      const x1 = s.x + W;
      const y1 = s.y + H / 2;
      const x2 = e.x;
      const y2 = e.y + H / 2;
      edges.push({
        from: a,
        to: e.id,
        d: `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`,
      });
    }
  }

  return {
    cols: ncol,
    nodes,
    edges,
    width: ncol ? ncol * W + (ncol - 1) * GX + 8 : 0,
    height: maxRows ? maxRows * H + (maxRows - 1) * GY + 8 : 0,
  };
}

export function Dag({ tasks, accent }: { tasks: readonly DagNode[]; accent: string }) {
  const l = layoutDag(tasks);
  return (
    <div className="dag-scroll">
      <svg
        className="dag"
        width={l.width}
        height={l.height}
        viewBox={`0 0 ${l.width} ${l.height}`}
        role="img"
        aria-label="Task dependency graph"
      >
        {l.edges.map((e) => (
          <path key={`${e.from}>${e.to}`} d={e.d} className="dag-edge" />
        ))}
        {l.nodes.map((t) => (
          <g
            key={t.id}
            transform={`translate(${t.x},${t.y})`}
            className={`dag-node st-${t.cancelled ? "cancelled" : t.stage}`}
            data-col={t.col}
          >
            {t.title && <title>{`${t.id} · ${t.title}`}</title>}
            <rect width={W} height={H} rx="9" />
            <text x="10" y="18" className="dag-id" fill={accent}>
              {t.id}
            </text>
            <text x="10" y="34" className="dag-stage">
              {t.cancelled ? "cancelled" : STAGE_LABEL[t.stage]}
            </text>
            <text x={W - 10} y="18" textAnchor="end" className="dag-issue">
              #{t.issue}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
