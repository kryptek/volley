/**
 * The Terminal popout's size, sent to volleyd (`terminal_resize`, SPEC §4.6.6; #403): a paired
 * machine's agent runs in a detached tmux session that is otherwise 200×50 whatever the popout's
 * size, so the Desk asks volleyd to resize it to the popout's cells while the popout is open,
 * and to put it back to its launch size (`reset: true`) when the popout closes. Fire and forget:
 * a refusal or no answer only leaves the terminal at its size, so it is never surfaced.
 */
import type { SteerTransport } from "./transport";

/** How long a popout's size must hold before it is sent (a drag resizes it many times). */
export const TERMINAL_RESIZE_DEBOUNCE_MS = 300;

/** A terminal's size in character cells, or `"launch"`: back to the size it started at. */
export type TerminalSize = { cols: number; rows: number } | "launch";

export function terminalResizeFields(agentId: string, size: TerminalSize): Record<string, unknown> {
  return size === "launch"
    ? { agent_id: agentId, reset: true }
    : { agent_id: agentId, cols: size.cols, rows: size.rows };
}

/** Send `size` for `agentId` over `control`; never rejects. */
export function sendTerminalSize(
  control: SteerTransport["control"],
  agentId: string,
  size: TerminalSize,
): void {
  const text =
    size === "launch"
      ? `Reset ${agentId}'s terminal to its launch size`
      : `Resize ${agentId}'s terminal to ${size.cols}×${size.rows}`;
  void control("terminal_resize", terminalResizeFields(agentId, size), text).catch(() => {});
}
