/**
 * The App's steering glue (D4): the log of what this Desk sent, the transport
 * over the store's writer (none when read-only), and `panel()`, which renders
 * the steering panel for one target with its last message's delivery state.
 */
import { type ReactNode, useEffect, useMemo, useReducer, useRef } from "react";
import { emitSound } from "../sounds/emit";
import type { SoundEventId } from "../sounds/events";
import { supervisorNamespace } from "../store/reducer";
import type { DeskState } from "../store/types";
import { SteerPanel } from "./SteerPanel";
import { type SentSteer, ackStateOf, ackStep, steerLog } from "./ackState";
import {
  DAEMON_AGENT_ID,
  type SteerClient,
  type SteerTarget,
  type SteerTransport,
  createSteerTransport,
} from "./transport";

export interface PanelSpec {
  /** Who to message; `null` when there is nobody (a wave with no coordinator). */
  target: SteerTarget | null;
  label: string;
  coordinator: boolean;
  /** Wave and task for the read-only `volleyd steer` command. */
  copy?: { wave: string; task: string; role?: string | undefined } | null;
  /** Why there is nobody to message (with `target: null`). */
  readOnlyReason?: string | undefined;
  onClose: () => void;
}

/**
 * Who a wave's chat messages: its coordinator session, never the Desk itself.
 * Once the Desk owns the wave (it claimed it) there is no coordinator session
 * to message; a coordinator that is gone (or reconnecting, or whose owner is away) has no
 * session either.
 */
export function waveChatTarget(
  owner: string | null | undefined,
  coordinator: { id: string | null; state: string } | undefined,
  identity: string | null,
): { agentId: string } | { agentId: null; reason: string } {
  if (identity !== null && owner === identity)
    return {
      agentId: null,
      reason: "You own this wave; there is no coordinator session to message.",
    };
  if (!coordinator?.id || coordinator.id === identity)
    return { agentId: null, reason: "This wave has no coordinator to message. Claim it first." };
  if (coordinator.state === "gone")
    return { agentId: null, reason: "This wave's coordinator is gone. Claim it first." };
  if (coordinator.state === "reconnecting")
    return {
      agentId: null,
      reason: "This wave's coordinator is reconnecting. Message it once it is back.",
    };
  if (coordinator.state === "away")
    return {
      agentId: null,
      reason: "This wave's owner is away; autopilot runs it. Message it once a session is back.",
    };
  return { agentId: coordinator.id };
}

/**
 * The steering sounds since `heard` (each message's highest step already
 * sounded, updated in place): `steering_sent` at the PUBACK, then
 * `steering_delivered` at the first of delivered or acked (only that one
 * when both arrive together).
 */
export function steerSounds(
  log: readonly SentSteer[],
  desk: DeskState,
  heard: Map<string, number>,
): SoundEventId[] {
  const out: SoundEventId[] = [];
  for (const m of log) {
    const step = Math.min(2, ackStep(ackStateOf(m, log, desk)));
    if (step <= (heard.get(m.id) ?? 0)) continue;
    heard.set(m.id, step);
    out.push(step >= 2 ? "steering_delivered" : "steering_sent");
  }
  return out;
}

export function useSteering(
  desk: DeskState,
  writer: SteerClient | null,
  identity: string | null,
): { transport: SteerTransport | null; panel: (p: PanelSpec) => ReactNode } {
  const [log, dispatch] = useReducer(steerLog, []);
  const daemonNs = useRef("default");
  daemonNs.current = supervisorNamespace(desk, DAEMON_AGENT_ID);
  const transport = useMemo(
    () =>
      writer && identity
        ? createSteerTransport(writer, {
            identity,
            onEvent: dispatch,
            daemonNamespace: () => daemonNs.current,
          })
        : null,
    [writer, identity],
  );

  const heard = useRef(new Map<string, number>());
  useEffect(() => {
    for (const id of steerSounds(log, desk, heard.current)) emitSound(id);
  }, [log, desk]);

  const panel = ({ target, label, coordinator, copy, readOnlyReason, onClose }: PanelSpec) => {
    const last = target ? [...log].reverse().find((m) => m.target === target.agentId) : undefined;
    return (
      <SteerPanel
        target={label}
        coordinator={coordinator}
        onSend={
          target && transport ? (text, urgent) => transport.send(target, text, { urgent }) : null
        }
        last={
          last
            ? {
                text: last.text,
                state: ackStateOf(last, log, desk),
                error: last.error,
                urgent: last.urgent === true,
                interrupt: last.interrupt,
              }
            : null
        }
        copy={copy}
        readOnlyReason={
          target
            ? undefined
            : (readOnlyReason ?? "This wave has no coordinator to message. Claim it first.")
        }
        onClose={onClose}
      />
    );
  };
  return { transport, panel };
}
