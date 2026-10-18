/**
 * The App's steering glue (D4): the log of what this Desk sent, the transport
 * over the store's writer (none when read-only), and `panel()`, which renders
 * the steering panel for one target with its last message's delivery state.
 */
import { type ReactNode, useMemo, useReducer, useRef } from "react";
import type { DeskState } from "../store/types";
import { SteerPanel } from "./SteerPanel";
import { ackStateOf, steerLog } from "./ackState";
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
  copy?: { wave: string; task: string } | null;
  onClose: () => void;
}

export function useSteering(
  desk: DeskState,
  writer: SteerClient | null,
  identity: string | null,
): { transport: SteerTransport | null; panel: (p: PanelSpec) => ReactNode } {
  const [log, dispatch] = useReducer(steerLog, []);
  const daemonNs = useRef("default");
  daemonNs.current = desk.agents[DAEMON_AGENT_ID]?.namespace ?? "default";
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

  const panel = ({ target, label, coordinator, copy, onClose }: PanelSpec) => {
    const last = target ? [...log].reverse().find((m) => m.target === target.agentId) : undefined;
    return (
      <SteerPanel
        target={label}
        coordinator={coordinator}
        onSend={
          target && transport ? (text, urgent) => transport.send(target, text, { urgent }) : null
        }
        last={
          last ? { text: last.text, state: ackStateOf(last, log, desk), error: last.error } : null
        }
        copy={copy}
        readOnlyReason={
          target ? undefined : "This wave has no coordinator to message. Claim it first."
        }
        onClose={onClose}
      />
    );
  };
  return { transport, panel };
}
