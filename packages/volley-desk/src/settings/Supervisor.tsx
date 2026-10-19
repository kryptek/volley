/**
 * Settings › Supervisor: volleyd's global config (the retained `_config`) as
 * D5's schema-driven rows (`ConfigRows`, global scope). A wave's own ⚙ shows
 * that wave's effective config and links back here.
 */
import type { ConfigPayload } from "../store/types";
import { ConfigRows } from "./ConfigRows";
import type { ConfigTransport } from "./configTransport";

/** The prototype's macOS accent for the Supervisor sliders. */
const ACCENT = "#0a84ff";

export function Supervisor({
  config,
  transport,
}: {
  /** The retained `volley/_waves/_config` payload. */
  config: ConfigPayload | null;
  /** `null` = no broker credentials: read-only with copyable commands. */
  transport: ConfigTransport | null;
}) {
  return (
    <>
      {!transport && (
        <p className="s-note">
          Read-only: the Desk has no broker credentials. Pick a new value, then copy its command and
          run it in a terminal.
        </p>
      )}
      <ConfigRows
        scope="global"
        values={config}
        transport={transport}
        accent={ACCENT}
        foot="Saved through volleyd config set · applies at the next admission tick · never preempts running work. A wave’s own ⚙ shows the values that wave runs with."
      />
    </>
  );
}
