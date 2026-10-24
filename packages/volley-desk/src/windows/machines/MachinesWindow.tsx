/**
 * The Machines window: one dense row per machine in this supervisor's pool, the supervisor's own
 * (`this machine`) first, then every configured host with a record (the Settings › Machines
 * rule). A row reads the health dot (the agent window's machine chip's), `load <1-min>/<cores>`,
 * `mem <used %>` and the agents chip `<n>/<max>`, then `<cores> cores · <GB> GB` and two
 * sparklines over the last 10 minutes (`Sparkline.tsx`, from the store's `machineHistory`): load
 * per core (teal) and memory used (coral), amber at or above 70 % and red at or above 90 %, the
 * number beside each too. A down machine reads `down · last seen 6m ago` with both lines flat
 * grey. A click opens Settings › Machines at the machine's card (the chip's deep link). Each row
 * is described in words (`summary`), so its state is never colour alone. A machine that runs a
 * machine role (SPEC §4.6.24) carries its letters after the name, `B S D` for the broker, the
 * supervisor and the Desk, and its summary says them in words.
 *
 * Phone layout (`narrow`): the name line, then the two sparklines full width
 * (styles/machines-window.css).
 */
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useId } from "react";
import { Frame, type FrameProps } from "../../canvas/Frame";
import { DEFAULT_MAX_AGENTS, ago, rolesOn } from "../../settings/MachineCard";
import { ROLE_NAME } from "../../settings/RoleMoveSheet";
import { usePanelSound } from "../../sounds/usePanelSound";
import type { MachineSample } from "../../store/machineHistory";
import { sampleOf } from "../../store/machineHistory";
import type { DeskState, MachinePayload, MachineRole, ReadinessPayload } from "../../store/types";
import { type MachineDot, machineDot } from "../agent/MachineChip";
import { LOCAL_LABEL } from "../agent/machine";
import { IconBtn } from "../wave/WaveWindow";
import { type SparkLevel, Sparkline, sparkLevel } from "./Sparkline";
import "../../styles/agent.css";
import "../../styles/machines-window.css";

export const MACHINES_ID = "machines";
export const MACHINES_W = 460;
const ACCENT = "#6ee7f9";

export interface MachineRow {
  /** The machine's name (the supervisor's `fleet.local_name` for its own). */
  name: string;
  /** What the row reads: `this machine` for the supervisor's own. */
  label: string;
  record: MachinePayload;
  readiness?: ReadinessPayload;
  dot: MachineDot;
  history: MachineSample[];
  /** The machine roles it runs (volleyd's record), in the record's order. */
  roles: MachineRole[];
}

/** The rows: the supervisor's own record first, then the configured hosts with a record, by name. */
export function machineRows(
  state: Pick<DeskState, "config" | "machines" | "readiness" | "machineHistory" | "roles">,
  hubUp: boolean,
): MachineRow[] {
  const machines = state.machines ?? {};
  const localName = state.config?.fleet?.local_name;
  const row = (record: MachinePayload, local: boolean): MachineRow => {
    const readiness = state.readiness?.[record.name];
    return {
      name: record.name,
      label: local ? LOCAL_LABEL : record.name,
      record,
      ...(readiness ? { readiness } : {}),
      dot: machineDot(record, readiness, hubUp, local),
      history: state.machineHistory?.[record.name] ?? [],
      roles: state.roles ? rolesOn(state.roles, record.name) : [],
    };
  };
  const own = localName ? machines[localName] : undefined;
  const hosts = Object.keys(state.config?.hosts ?? {})
    .filter((n) => n !== localName && machines[n])
    .sort((a, b) => a.localeCompare(b))
    .map((n) => row(machines[n] as MachinePayload, false));
  return [...(own ? [row(own, true)] : []), ...hosts];
}

const ROLE_LETTER: Record<MachineRole, string> = { broker: "B", supervisor: "S", desk: "D" };

/** `the broker, the supervisor and the Desk`. */
function roleWords(roles: readonly MachineRole[]): string {
  const names = roles.map((r) => ROLE_NAME[r]);
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const LEVEL_WORD: Record<SparkLevel, string> = { ok: "", warn: ", high", bad: ", critical" };

/** One row's figures, as the row shows them and as its summary says them. */
function figures(r: MachineRow, now: number) {
  const m = r.record;
  const s = sampleOf(m);
  const load1 = m.load[0];
  const max = r.readiness?.max_agents ?? DEFAULT_MAX_AGENTS;
  const down = r.dot === "down";
  const seen = ago(m.last_seen, now);
  const specs = [
    `${m.cores} cores`,
    ...(m.memory ? [`${Math.round(m.memory.total_mb / 1024)} GB`] : []),
  ];
  const loadPct = s?.load ?? null;
  const memPct = s?.mem ?? null;
  const loadText = load1 === undefined ? "—" : load1.toFixed(1);
  const agents = `${m.agents} of ${max} agents`;
  /** `95 %, critical`: a reading and its level in words. */
  const pct = (v: number) => `${Math.round(v)} %${LEVEL_WORD[sparkLevel(v)]}`;
  const runs = r.roles.length > 0 ? ` — runs ${roleWords(r.roles)}` : "";
  const summary = `${
    down
      ? `${r.label}: down, last seen ${seen} ago — ${agents}`
      : [
          `${r.label}: load ${loadText} of ${m.cores} cores${loadPct === null ? "" : `, ${pct(loadPct)}`}`,
          memPct === null ? "memory unknown" : `memory ${pct(memPct)}`,
          agents,
        ].join(" — ")
  }${runs}`;
  return { down, seen, max, specs: specs.join(" · "), loadPct, memPct, loadText, summary };
}

function Row({ r, now, onOpen }: { r: MachineRow; now: number; onOpen: (name: string) => void }) {
  const id = useId();
  const f = figures(r, now);
  const m = r.record;
  return (
    <li className={`mrow-item${f.down ? " mrow-item--down" : ""}`}>
      <button
        type="button"
        className="mrow"
        aria-label={`${r.label}: open in Settings › Machines`}
        aria-describedby={id}
        onClick={() => onOpen(r.name)}
      >
        <span className="mrow-line">
          {r.dot !== "unknown" && <i className={`m-dot m-dot--${r.dot}`} />}
          <span className="mrow-name">{r.label}</span>
          {r.roles.length > 0 && (
            <span className="mrow-roles" aria-hidden="true">
              {r.roles.map((x) => ROLE_LETTER[x]).join(" ")}
            </span>
          )}
          {f.down ? (
            <span className="mrow-down">down · last seen {f.seen} ago</span>
          ) : (
            <>
              <span className={`mrow-load lvl--${sparkLevel(f.loadPct)}`}>
                load {f.loadText}/{m.cores}
              </span>
              <span className={`mrow-mem lvl--${sparkLevel(f.memPct)}`}>
                mem {f.memPct === null ? "—" : `${Math.round(f.memPct)}%`}
              </span>
            </>
          )}
          <span className="chip mrow-agents">
            {m.agents}/{f.max} agents
          </span>
        </span>
        <span className="mrow-specs">{f.specs}</span>
        <span className="mrow-sparks">
          <Sparkline
            kind="load"
            samples={r.history.map((s) => ({ at: s.at, value: s.load }))}
            now={now}
            down={f.down}
          />
          <Sparkline
            kind="mem"
            samples={r.history.map((s) => ({ at: s.at, value: s.mem }))}
            now={now}
            down={f.down}
          />
        </span>
      </button>
      <span id={id} className="mrow-summary">
        {f.summary}
      </span>
    </li>
  );
}

export interface MachinesWindowProps {
  rows: readonly MachineRow[];
  /** The clock the sparklines' window ends at and `last seen` counts from. */
  now: number;
  narrow?: boolean;
  frame: Omit<
    FrameProps,
    "id" | "title" | "label" | "accent" | "width" | "actions" | "footer" | "children" | "attn"
  >;
  /** A row's click: Settings › Machines at that machine's card. */
  onOpen: (name: string) => void;
  onClose: () => void;
}

export function MachinesWindow(p: MachinesWindowProps) {
  usePanelSound();
  return (
    <Frame
      {...p.frame}
      id={MACHINES_ID}
      title={<span className="t-name">Machines</span>}
      label="Machines"
      accent={ACCENT}
      width={MACHINES_W}
      actions={<IconBtn label="Close Machines" i={Cancel01Icon} onClick={p.onClose} />}
    >
      <div className={`machines-win${p.narrow ? " machines-win--phone" : ""}`}>
        {p.rows.length === 0 ? (
          <p className="machines-empty dim">No machines yet: pair one in Settings › Machines.</p>
        ) : (
          <ul className="mrows">
            {p.rows.map((r) => (
              <Row key={r.name} r={r} now={p.now} onOpen={p.onOpen} />
            ))}
          </ul>
        )}
      </div>
    </Frame>
  );
}
