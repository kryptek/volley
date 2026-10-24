/**
 * The agent window's machine chip: where the agent runs (`machine.ts`), a
 * status dot from the machine's record and volleyd's readiness verdict, and,
 * on hover or keyboard focus, a tooltip with why it is there (the placement
 * rule and the chosen host's own candidate line, verbatim: the Desk never
 * scores machines) and the machine's load. The tooltip is a `Popover`, drawn
 * above the canvas so the window never clips it; it stays open while the pointer
 * is on the card and closes a moment after it leaves both. A click opens
 * Settings › Machines at that machine's card.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Popover } from "../../look/Popover";
import type { MachinePayload, ReadinessPayload, TaskPlacement } from "../../store/types";
import { placementRule } from "../wave/Dag";
import { type AgentMachine, LOCAL_LABEL } from "./machine";

export type MachineDot = "up" | "down" | "overloaded" | "unknown";

/**
 * `down` when the tunnel is down (or, for the supervisor's own machine, volleyd
 * is not live); `overloaded` when volleyd drains it or finds it ineligible; `up`
 * with a record; `unknown` (no dot) otherwise.
 */
export function machineDot(
  record: MachinePayload | undefined,
  readiness: ReadinessPayload | undefined,
  hubUp: boolean,
  local = record?.tunnel === "local",
): MachineDot {
  if (record?.tunnel === "down" || (local && !hubUp)) return "down";
  if (readiness && (readiness.drain || !readiness.eligible)) return "overloaded";
  return record ? "up" : "unknown";
}

/** The tooltip's lines: why the machine was picked, then its load when known. */
export function machineTip(
  name: string,
  placement: TaskPlacement | undefined,
  record: MachinePayload | undefined,
  readiness: ReadinessPayload | undefined,
): string[] {
  const lines: string[] = [];
  if (placement) {
    lines.push(placementRule(placement));
    const own = placement.candidates.find((c) => c.host === name);
    if (own) lines.push(own.line);
  }
  if (record) {
    const load = record.load[0];
    const agents = readiness ? `${record.agents}/${readiness.max_agents}` : `${record.agents}`;
    lines.push(
      [`${record.cores} cores`, load === undefined ? null : `load ${load}`, `${agents} agents`]
        .filter(Boolean)
        .join(" · "),
    );
  }
  return lines;
}

/** How long the tooltip waits after the pointer leaves, so crossing the gap to the card does not close it. */
const CLOSE_GRACE_MS = 120;

const DOT_TITLE: Record<MachineDot, string> = {
  up: "up",
  down: "down",
  overloaded: "overloaded",
  unknown: "status unknown",
};

export function MachineChip({
  machine,
  onOpen,
}: {
  machine: AgentMachine;
  onOpen?: ((name: string) => void) | undefined;
}) {
  const tipId = useId();
  const chip = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = useCallback(() => clearTimeout(timer.current), []);
  const show = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  const close = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    timer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);
  const { name, local, record, readiness, placement, hubUp } = machine;
  const label = local ? LOCAL_LABEL : name;
  const dot = machineDot(record, readiness, hubUp, local);
  const tip = machineTip(name, placement, record, readiness);
  return (
    <span className="m-chip-wrap">
      <button
        ref={chip}
        type="button"
        className="chip m-chip"
        aria-label={`Runs on ${label}: why here`}
        aria-describedby={open ? tipId : undefined}
        onClick={() => onOpen?.(name)}
        onPointerEnter={show}
        onPointerLeave={scheduleClose}
        onFocus={show}
        onBlur={close}
      >
        {dot !== "unknown" && <i className={`m-dot m-dot--${dot}`} />}
        {label}
      </button>
      <Popover
        anchor={chip}
        open={open}
        role="tooltip"
        id={tipId}
        className="m-tip"
        dismiss="none"
        onClose={close}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
      >
        <p className="host-rule">
          {local ? `${LOCAL_LABEL} (${name})` : name} · {DOT_TITLE[dot]}
        </p>
        {tip.length > 0 && (
          <ul className="host-lines">
            {tip.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
      </Popover>
    </span>
  );
}
