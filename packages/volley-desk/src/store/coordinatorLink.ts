/**
 * Where **Open coordinator** goes (SPEC §4.6.25): the coordinator role's `session_url` while it
 * runs; with the role's topic cleared (or not retained), the newest live registry entry carrying a
 * coordinator name (the role's own, once it is known) and a `session_url`; else why there is no
 * link, which the button shows as its label and tooltip.
 */
import { isLiveAgent } from "./reducer";
import type { DeskState } from "./types";

export type CoordinatorLink = { href: string } | { disabled: string };

export const NO_COORDINATOR = "No coordinator running";

/** The newest live registry entry's `session_url` for coordinator `name` (any name when null). */
function registryLink(state: DeskState, name: string | null): string | null {
  let best: { url: string; at: number } | null = null;
  for (const a of Object.values(state.agents)) {
    const reg = a.registry;
    const coord = reg?.coordinator;
    const url = reg?.session_url;
    if (typeof coord !== "string" || typeof url !== "string" || url === "") continue;
    if (name !== null && coord !== name) continue;
    if (!isLiveAgent(state, a.id)) continue;
    const t = Date.parse(reg?.started_at ?? "");
    const at = Number.isNaN(t) ? (a.bornAt ?? 0) : t;
    if (best === null || at > best.at) best = { url, at };
  }
  return best?.url ?? null;
}

export function coordinatorLink(state: DeskState): CoordinatorLink {
  const role = state.coordinatorRole ?? null;
  if (role === null) {
    const url = registryLink(state, null);
    return url !== null ? { href: url } : { disabled: NO_COORDINATOR };
  }
  switch (role.state) {
    case "running": {
      const url = role.session_url ?? registryLink(state, role.name);
      return url !== null
        ? { href: url }
        : { disabled: `No link yet: open the Claude app and pick "${role.name}"` };
    }
    case "starting":
    case "restarting":
      return { disabled: `Coordinator starting on ${role.machine}…` };
    default:
      return { disabled: NO_COORDINATOR };
  }
}
