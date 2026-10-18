/**
 * The wave's dependency graph, ported from the prototype `Dag`: one column per
 * dependency depth (a task sits one column right of its deepest `after`),
 * tasks in wave-file order within a column, each column centred vertically,
 * and cubic edges from a task's right edge to its dependents' left edge.
 */
import { type DeskStage, STAGE_LABEL } from "./stages";

export interface DagNode {
  id: string;
  title?: string;
  after: string[];
  stage: DeskStage;
}

export interface DagLayout {
  cols: number;
  rows: number;
  nodes: (DagNode & { col: number; row: number; x: number; y: number })[];
  edges: { from: string; to: string; done: boolean; d: string }[];
  width: number;
  height: number;
}

const NODE_W = 128;
const NODE_H = 40;
const COL_GAP = 40;
const ROW_GAP = 10;

export function layoutDag(input: readonly DagNode[]): DagLayout {
  const byId = new Map(input.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // A dependency cycle is a malformed wave file; break it rather than recurse forever.
    if (visiting.has(id)) return -1;
    visiting.add(id);
    const deps = (byId.get(id)?.after ?? []).filter((d) => byId.has(d));
    const d = deps.length ? Math.max(...deps.map(depthOf)) + 1 : 0;
    visiting.delete(id);
    depth.set(id, Math.max(d, 0));
    return Math.max(d, 0);
  };

  const columns: DagNode[][] = [];
  for (const n of input) {
    const c = depthOf(n.id);
    const list = columns[c] ?? [];
    list.push(n);
    columns[c] = list;
  }
  const cols = columns.length;
  const rows = Math.max(0, ...columns.map((c) => c?.length ?? 0));
  const pitch = NODE_H + ROW_GAP;

  const nodes: DagLayout["nodes"] = [];
  columns.forEach((list, col) => {
    const offset = ((rows - list.length) * pitch) / 2;
    list.forEach((n, row) => {
      nodes.push({ ...n, col, row, x: col * (NODE_W + COL_GAP), y: offset + row * pitch });
    });
  });
  // Keep wave-file order so the DOM (and tab order) follows the file.
  const at = new Map(nodes.map((n) => [n.id, n]));
  const ordered = input.flatMap((n) => at.get(n.id) ?? []);

  const edges: DagLayout["edges"] = [];
  for (const to of ordered) {
    for (const fromId of to.after) {
      const from = at.get(fromId);
      if (!from) continue;
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      edges.push({
        from: from.id,
        to: to.id,
        done: from.stage === "merged",
        d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
      });
    }
  }

  return {
    cols,
    rows,
    nodes: ordered,
    edges,
    width: cols ? cols * NODE_W + (cols - 1) * COL_GAP : 0,
    height: rows ? rows * pitch - ROW_GAP : 0,
  };
}

export function Dag({ nodes }: { nodes: readonly DagNode[] }) {
  const l = layoutDag(nodes);
  return (
    <div className="dag-wrap">
      <div className="dag" style={{ width: l.width, height: l.height }}>
        <svg className="dag-edges" width={l.width} height={l.height} aria-hidden="true">
          {l.edges.map((e) => (
            <path
              key={`${e.from}>${e.to}`}
              className={`dag-edge${e.done ? " dag-edge--done" : ""}`}
              d={e.d}
            />
          ))}
        </svg>
        {l.nodes.map((n) => (
          <div
            key={n.id}
            className={`dag-node dag-node--${n.stage}`}
            data-col={n.col}
            style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
            title={n.title ? `${n.id} · ${n.title}` : n.id}
          >
            <b className="dag-id">{n.id}</b>
            <span className="dag-stage">{STAGE_LABEL[n.stage]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
