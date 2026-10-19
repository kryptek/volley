/**
 * The wave's dependency graph, ported from the prototype `Dag`: one column per
 * dependency depth (a task sits one column right of its deepest `after`),
 * tasks in wave-file order within a column, each column centred vertically,
 * and cubic edges from a task's right edge to its dependents' left edge. The
 * layout is split out as the pure `layoutDag`.
 *
 * Given a `maxWidth` the graph cannot span (a phone: `columns × 172 px` wider
 * than the window), the columns wrap into bands stacked top to bottom, as many
 * columns per band as fit; an edge into a later band leaves its task's side,
 * runs down the gutter between columns to the gap above the dependent's band,
 * and enters the dependent from the top (or, below the first row, from the
 * side through its own gutter), so it never crosses another node. Without one
 * (the desktop) it is one band in a horizontally scrolling container.
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
/** Gap between wrapped bands. */
const GB = 2 * GY;
export const DAG_NODE_W = W;
export const DAG_NODE_H = H;

/** The width of `n` columns side by side. */
const spanOf = (n: number) => (n ? n * W + (n - 1) * GX + 8 : 0);

export function layoutDag(tasks: readonly DagNode[], maxWidth?: number): DagLayout {
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
  // Columns per band: all of them, unless they overflow maxWidth.
  const fit =
    maxWidth !== undefined && spanOf(ncol) > maxWidth
      ? Math.max(1, Math.floor((maxWidth - 8 + GX) / (W + GX)))
      : Math.max(1, ncol);
  const bands: DagNode[][][] = [];
  for (let b = 0; b * fit < ncol; b++) bands.push(cols.slice(b * fit, b * fit + fit));

  const at = new Map<string, DagLayout["nodes"][number]>();
  const band = new Map<string, number>();
  const bandTop: number[] = [];
  let top = 4;
  let maxRows = 0;
  bands.forEach((bandCols, b) => {
    bandTop[b] = top;
    const rows = Math.max(0, ...bandCols.map((c) => c?.length ?? 0));
    maxRows = Math.max(maxRows, rows);
    bandCols.forEach((list, i) => {
      const col = b * fit + i;
      const off = ((rows - list.length) * (H + GY)) / 2;
      list.forEach((t, row) => {
        band.set(t.id, b);
        at.set(t.id, { ...t, col, row, x: 4 + i * (W + GX), y: top + off + row * (H + GY) });
      });
    });
    top += rows * (H + GY) - GY + GB;
  });
  // Keep wave-file order so the DOM follows the file.
  const nodes = tasks.flatMap((t) => at.get(t.id) ?? []);

  /** The x of the free lane beside a node at band column `i`: a gutter, else the right margin. */
  const gutter = (i: number, x: number) =>
    i < fit - 1 ? x + W + GX / 2 : i > 0 ? x - GX / 2 : x + W + 2;
  const edges: DagLayout["edges"] = [];
  for (const e of nodes) {
    for (const a of e.after) {
      const s = at.get(a);
      if (!s) continue;
      const bs = band.get(a) ?? 0;
      const be = band.get(e.id) ?? 0;
      if (bs !== be) {
        // Into a later band, through the gutters and the gap between bands (see the header).
        const gs = gutter(s.col - bs * fit, s.x);
        const ge = gutter(e.col - be * fit, e.x);
        const gap = (bandTop[be] ?? e.y) - GB / 2;
        const exit = gs > s.x ? s.x + W : s.x;
        let d = `M${exit},${s.y + H / 2} H${gs} V${gap}`;
        if (e.row === 0) d += ` H${e.x + W / 2} V${e.y}`;
        else d += ` H${ge} V${e.y + H / 2} H${ge > e.x ? e.x + W : e.x}`;
        edges.push({ from: a, to: e.id, d });
        continue;
      }
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
    width: spanOf(Math.min(ncol, fit)),
    height: maxRows ? top - GB + 4 : 0,
  };
}

export function Dag({
  tasks,
  accent,
  maxWidth,
  ended = false,
  labels = {},
}: {
  tasks: readonly DagNode[];
  accent: string;
  /** Wrap into bands within this width (a phone); omitted: one band, scrolled. */
  maxWidth?: number | undefined;
  /** The wave stopped or completed: stages are shown as they were, struck through. */
  ended?: boolean;
  /** Stage text overrides by task id (e.g. `waiting for CI`). */
  labels?: Readonly<Record<string, string>>;
}) {
  const l = layoutDag(tasks, maxWidth);
  return (
    <div className="dag-scroll">
      <svg
        className={`dag${ended ? " dag--ended" : ""}`}
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
            data-id={t.id}
          >
            {t.title && <title>{`${t.id} · ${t.title}`}</title>}
            <rect width={W} height={H} rx="9" />
            <text x="10" y="18" className="dag-id" fill={accent}>
              {t.id}
            </text>
            <text x="10" y="34" className="dag-stage">
              {t.cancelled ? "cancelled" : (labels[t.id] ?? STAGE_LABEL[t.stage])}
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
