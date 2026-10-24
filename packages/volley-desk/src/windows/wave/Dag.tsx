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
 *
 * A planned wave's nodes (the overlap plan) carry their cluster: every node of
 * one cluster sits on a hull tinted with that cluster's palette hue, with a
 * badge naming it (`A`, `A · 4/4` while capped, `A · hold` while held). A
 * bundle (one task closing several issues) reads `#310 +1` in its corner, each
 * issue a link and the whole list in its tooltip; an `after` the planner
 * chained is drawn dashed.
 *
 * `HostChips` lists, under the graph, the machine each placed task runs on
 * and why (SPEC §4.6.15 `tasks[].placement`).
 */
import { type RefObject, useRef, useState } from "react";
import { issueLabel } from "../../lib/github";
import { Popover } from "../../look/Popover";
import type { TaskPlacement, WaveTask } from "../../store/types";
import { hueOf } from "./accent";
import { type DeskStage, STAGE_LABEL } from "./stages";

export interface DagNode {
  id: string;
  issue: number;
  title?: string;
  after: string[];
  stage: DeskStage;
  /** Cancelled by a plan change: drawn faded, labelled `cancelled`, kept out of progress. */
  cancelled?: boolean;
  /** The issue on GitHub (the wave state's `github`): the corner label links there. */
  issueHref?: string;
  /** A synthetic fixer task (SPEC §4.6.16): the tasks it fixes; drawn with a wrench. */
  fixerFor?: string[];
  /** The overlap plan's cluster: `hue` indexes `ACCENT_PALETTE`, `badge` is what the node shows. */
  cluster?: { id: string; hue: number; badge: string };
  /** A bundle's other issues (beyond `issue`), each with its link when the wave has `github`. */
  bundle?: { issue: number; href?: string }[];
  /** The `after` entries the planner chained: their edges are drawn dashed. */
  chained?: string[];
}

/** `fixer for T3, T7` (just `fixer` when the supervisor names no task). */
export const fixerLabel = (fixes: readonly string[]) =>
  fixes.length ? `fixer for ${fixes.join(", ")}` : "fixer";

/** A bundle's issues, its own first: `#310, #312`. */
const bundleList = (t: DagNode) =>
  [t.issue, ...(t.bundle ?? []).map((b) => b.issue)].map((n) => `#${n}`).join(", ");

/**
 * A node's tooltip: its title, or what a fixer fixes, and a bundle's issues; else the id itself
 * when the node elides it.
 */
function nodeTip(t: DagNode): string | undefined {
  if (t.fixerFor) return `${t.id} · ${fixerLabel(t.fixerFor)}`;
  const parts = [t.title, t.bundle?.length ? bundleList(t) : undefined].filter(Boolean);
  if (parts.length) return [t.id, ...parts].join(" · ");
  return fitId(t.id, idFit(t)) === t.id ? undefined : t.id;
}

export interface DagLayout {
  cols: number;
  nodes: (DagNode & { col: number; row: number; x: number; y: number })[];
  edges: { from: string; to: string; d: string; chained?: boolean }[];
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
/** A `.dag-id` character's advance: 600 13px mono is about 0.6 em. */
export const DAG_ID_CHAR_PX = 7.8;
/** Characters of id that fit between the node's 10 px insets. */
const ID_FIT = Math.floor((W - 20) / DAG_ID_CHAR_PX);
/** A `.dag-cluster` badge character's advance: 9.5px mono. */
const BADGE_CHAR_PX = 5.8;

/** Characters of the node's id that fit beside its cluster badge, if it has one. */
const idFit = (t: DagNode) =>
  t.cluster
    ? Math.max(4, Math.floor((W - 26 - t.cluster.badge.length * BADGE_CHAR_PX) / DAG_ID_CHAR_PX))
    : ID_FIT;

/**
 * A task id that fits its node (`fit` characters): as is when it does, else `head…tail` (the
 * first 6 and the last 5 characters), as a flake-fixer's `fix-<slug>` id can run to 44; beside a
 * cluster badge, where fewer fit, its head and `…`. The node's tooltip keeps the full id.
 */
export function fitId(id: string, fit = ID_FIT): string {
  if (id.length <= fit) return id;
  return fit >= 12 ? `${id.slice(0, 6)}…${id.slice(-5)}` : `${id.slice(0, fit - 1)}…`;
}

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
  const chain = (t: DagNode, a: string) => (t.chained?.includes(a) ? { chained: true } : {});
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
        edges.push({ from: a, to: e.id, d, ...chain(e, a) });
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
        ...chain(e, a),
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
      {/* A group, not an img: an img's children are presentational, and the issue labels are links. */}
      <svg
        className={`dag${ended ? " dag--ended" : ""}`}
        width={l.width}
        height={l.height}
        viewBox={`0 0 ${l.width} ${l.height}`}
        // biome-ignore lint/a11y/useSemanticElements: an <svg> cannot be a <fieldset>
        role="group"
        aria-label="Task dependency graph"
      >
        {l.edges.map((e) => (
          <path
            key={`${e.from}>${e.to}`}
            d={e.d}
            className={`dag-edge${e.chained ? " dag-edge--chain" : ""}`}
          />
        ))}
        {l.nodes.map((t) => (
          <g
            key={t.id}
            transform={`translate(${t.x},${t.y})`}
            className={`dag-node st-${t.cancelled ? "cancelled" : t.stage}`}
            data-col={t.col}
            data-id={t.id}
            {...(t.cluster ? { "data-cluster": t.cluster.id } : {})}
          >
            {nodeTip(t) && <title>{nodeTip(t)}</title>}
            {t.cluster && <ClusterHull hue={t.cluster.hue} />}
            <rect width={W} height={H} rx="9" />
            <text x="10" y="18" className="dag-id" fill={accent}>
              {fitId(t.id, idFit(t))}
            </text>
            {t.cluster && (
              <text
                x={W - 8}
                y="15"
                textAnchor="end"
                className="dag-cluster"
                fill={hueOf(t.cluster.hue)}
              >
                {t.cluster.badge}
              </text>
            )}
            <text x="10" y="34" className="dag-stage">
              {t.cancelled ? "cancelled" : (labels[t.id] ?? STAGE_LABEL[t.stage])}
            </text>
            {/* Second line, right: a fixer's wrench, else its issue (none for a synthetic `#0`). */}
            {t.fixerFor ? (
              <text x={W - 10} y="34" textAnchor="end" className="dag-fixer">
                🔧
              </text>
            ) : t.issue > 0 && t.bundle?.length ? (
              <BundleLabel t={t} />
            ) : t.issue > 0 && t.issueHref ? (
              <a
                href={t.issueHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={issueLabel(t.issue)}
                className="dag-issue-link"
                onClick={(e) => e.stopPropagation()}
              >
                <text x={W - 10} y="34" textAnchor="end" className="dag-issue">
                  #{t.issue}
                </text>
              </a>
            ) : t.issue > 0 ? (
              <text x={W - 10} y="34" textAnchor="end" className="dag-issue">
                #{t.issue}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    </div>
  );
}

/** The tinted hull behind a clustered node: static, so reduced motion keeps it as is. */
function ClusterHull({ hue }: { hue: number }) {
  return (
    <rect
      className={`dag-hull hull-${hue}`}
      x={-5}
      y={-5}
      width={W + 10}
      height={H + 10}
      rx="12"
      fill={hueOf(hue)}
    />
  );
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A bundle's corner label, `#310 +1`: its own issue and, on `+N`, the next; every further issue
 * has its own (textless) link, reached by keyboard and named for assistive tech. The tooltip
 * lists them all.
 */
function BundleLabel({ t }: { t: DagNode }) {
  const extra = t.bundle ?? [];
  const link = (n: number, href: string | undefined, text: string) =>
    href ? (
      <a
        key={n}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={issueLabel(n)}
        className="dag-issue-link"
        onClick={stop}
      >
        <tspan>{text}</tspan>
      </a>
    ) : (
      <tspan key={n}>{text}</tspan>
    );
  return (
    <text x={W - 10} y="34" textAnchor="end" className="dag-issue">
      {link(t.issue, t.issueHref, `#${t.issue}`)}
      <tspan> </tspan>
      {extra.map((b, i) => link(b.issue, b.href, i === 0 ? `+${extra.length}` : ""))}
    </text>
  );
}

/** The rule that put a task where it is (SPEC §4.6.15 `placement.by`). */
export function placementRule(p: TaskPlacement): string {
  if (p.by === "wave_file") return "pinned by the wave file";
  if (p.by === "decision") return `re-placed by owner on ${p.decided_at.slice(0, 10)}`;
  return "placed automatically at admission";
}

/**
 * One chip per placed task under the graph: its host, and, on click or tap, a popover with
 * why it is there: the rule that applied, volleyd's candidate lines verbatim (best first, as
 * volleyd lists them; the Desk never scores machines itself) and the commit it was cut from.
 */
export function HostChips({ tasks }: { tasks: readonly WaveTask[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const chips = useRef(new Map<string, HTMLButtonElement>());
  const placed = tasks.filter((t): t is WaveTask & { placement: TaskPlacement } => !!t.placement);
  if (placed.length === 0) return null;
  return (
    <ul className="host-chips" aria-label="Where tasks run">
      {placed.map((t) => {
        const p = t.placement;
        const shown = open === t.id;
        const anchor: RefObject<HTMLElement | null> = {
          get current() {
            return chips.current.get(t.id) ?? null;
          },
        };
        return (
          <li key={t.id}>
            <button
              ref={(el) => {
                if (el) chips.current.set(t.id, el);
                else chips.current.delete(t.id);
              }}
              type="button"
              className="chip host-chip"
              aria-label={`${t.id} on ${p.host}: why here`}
              aria-expanded={shown}
              onClick={() => setOpen(shown ? null : t.id)}
            >
              <span className="mono">{t.id}</span> · {p.host}
            </button>
            <Popover
              anchor={anchor}
              open={shown}
              // biome-ignore lint/a11y/useSemanticElements: a non-modal popover, not a <dialog> element
              role="dialog"
              aria-label={`Why ${t.id} runs on ${p.host}`}
              dismiss="outside"
              onClose={() => setOpen(null)}
            >
              <p className="host-rule">{placementRule(p)}</p>
              <ol className="host-lines">
                {p.candidates.map((c) => (
                  <li key={c.host} className={c.score === null ? "dim" : undefined}>
                    {c.line}
                  </li>
                ))}
              </ol>
              {t.base_sha && <p className="mono dim">cut from {t.base_sha.slice(0, 7)}</p>}
            </Popover>
          </li>
        );
      })}
    </ul>
  );
}
