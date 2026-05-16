import type { IO } from "../../../io";
import type { Surface } from "./types";

/**
 * Terminal-bell surface: writes BEL (`\x07`) to stdout and a one-line summary to stderr.
 * Cheapest possible surface — works in any terminal that honors the BEL byte.
 */
export function createBellSurface(io: IO): Surface {
  return {
    name: "bell",
    async fire({ topic, envelope }) {
      io.stdout("\x07");
      io.stderr(`[notify] ${envelope.agent_id} → ${envelope.type} (${topic})\n`);
    },
  };
}
