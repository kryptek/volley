/**
 * The Coordinator card (SPEC §4.6.25), at the top of Settings › Machines and embedded by the
 * Getting started Access step: where the coordinator role runs and how it is doing.
 *
 * The picker lists "this computer" (`local`) and every paired machine's record; a machine whose
 * record says `laptop: true` is greyed with "a laptop: sleeps and travels" until **allow anyway**
 * (`coordinator.allow_laptop`) is on, as volleyd refuses it otherwise. Picking a machine writes
 * `coordinator.machine` through the config transport (and tells `onMachine`); the switch turns
 * the role off (`null`) or on (the machine shown). The state line follows volleyd's retained
 * `volley/_system/federation/coordinator`; **Open** is its link, **Restart** the admin op
 * `coordinator_restart`. Without a transport the card is read-only; without admin ops, no Restart.
 */
import { useState } from "react";
import type { AuthOps } from "../store/control";
import type { CoordinatorRolePayload, MachinePayload } from "../store/types";
import type { ConfigTransport } from "./configTransport";
import { Toggle } from "./primitives";

/** The machine name volleyd reads as its own (SPEC §4.6.25). */
export const LOCAL_COORDINATOR = "local";
export const LAPTOP_REASON = "a laptop: sleeps and travels";

export interface CoordinatorCardProps {
  /** volleyd's retained role state; null or absent: the role is off (or not known yet). */
  coordinatorRole: CoordinatorRolePayload | null | undefined;
  /** Machine records, by name; only `hosts` (and `localName`'s, for its laptop flag) are read. */
  machines: Record<string, MachinePayload>;
  /** The paired machines (`_waves/_config` `hosts`). */
  hosts?: readonly string[] | undefined;
  /** The supervisor's own machine name: its record says whether this computer is a laptop. */
  localName?: string | null | undefined;
  /** The effective `coordinator` tunables (`_waves/_config`). */
  coordinator?: { machine?: string | null; allow_laptop?: boolean } | undefined;
  /** volleyd's config channel; `null`: read-only. */
  transport: ConfigTransport | null;
  /** The admin channel, for Restart; `null`: no Restart. */
  ops: AuthOps | null;
  /** Told the machine once a pick (or Off, `null`) was applied (the Getting started Access step). */
  onMachine?: ((machine: string | null) => void) | undefined;
}

interface Choice {
  value: string;
  label: string;
  laptop: boolean;
}

/** `running on box-a since 12:00:00` · `restarting (2)` · `failed: <last_error>` · `off`. */
export function coordinatorStateLine(role: CoordinatorRolePayload | null | undefined): string {
  if (!role) return "off";
  const where = role.machine === LOCAL_COORDINATOR ? "this computer" : role.machine;
  const why = role.last_error?.split("\n").at(-1);
  switch (role.state) {
    case "running": {
      const t = Date.parse(role.since);
      const since = Number.isNaN(t) ? role.since : new Date(t).toLocaleString();
      const asks = role.needs_terminal ? ` · waiting on its screen (${role.needs_terminal})` : "";
      return `running on ${where} since ${since}${asks}`;
    }
    case "starting":
      return `starting on ${where}`;
    case "restarting":
      return `restarting (${role.restarts})`;
    case "failed":
      return why ? `failed: ${why}` : "failed";
    case "stopped":
      return why ? `stopped: ${why}` : "stopped";
  }
}

export function CoordinatorCard(p: CoordinatorCardProps) {
  const current = p.coordinator?.machine ?? null;
  const allowLaptop = p.coordinator?.allow_laptop === true;
  const own = p.localName ? p.machines[p.localName] : undefined;
  const choices: Choice[] = [
    { value: LOCAL_COORDINATOR, label: "this computer", laptop: own?.laptop === true },
    ...(p.hosts ?? [])
      .filter((h) => p.machines[h] !== undefined)
      .sort((a, b) => a.localeCompare(b))
      .map((h) => ({ value: h, label: h, laptop: p.machines[h]?.laptop === true })),
  ];
  const firstOk = choices.find((c) => allowLaptop || !c.laptop)?.value ?? LOCAL_COORDINATOR;
  const [picked, setPicked] = useState<string>(current ?? firstOk);
  const shown = current ?? picked;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = p.transport === null;

  const write = async (patch: Record<string, unknown>, text: string): Promise<boolean> => {
    if (p.transport === null) return false;
    setBusy(true);
    setError(null);
    try {
      const ack = await p.transport.send({ coordinator: patch }, { text });
      if (!ack.applied) {
        setError(ack.rejected[0]?.reason ?? ack.error ?? "volleyd did not apply it");
        return false;
      }
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setMachine = async (machine: string | null) => {
    const text =
      machine === null ? "turn the coordinator off" : `run the coordinator on ${machine}`;
    if (await write({ machine }, text)) p.onMachine?.(machine);
  };

  const restart = async () => {
    if (p.ops === null) return;
    setBusy(true);
    setError(null);
    try {
      const a = await p.ops.request("coordinator_restart");
      if (!a.ok) setError(a.error ?? "volleyd refused the restart");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const link = p.coordinatorRole?.state === "running" ? p.coordinatorRole.session_url : undefined;
  const laptops = choices.some((c) => c.laptop);

  return (
    <article className="coord-card" aria-label="Coordinator">
      <header className="coord-card-head">
        <span className="coord-card-title">Coordinator</span>
        <Toggle
          on={current !== null}
          label="Coordinator on"
          disabled={readOnly || busy}
          onChange={(on) => void setMachine(on ? shown : null)}
        />
      </header>
      <p className="dim">
        Your Claude Code session that runs the waves, reachable from the Claude app on your phone.
        Pick a machine that stays on.
      </p>
      <label className="coord-card-pick">
        <span>Runs on</span>
        <select
          aria-label="Coordinator machine"
          value={shown}
          disabled={readOnly || busy}
          onChange={(e) => {
            setPicked(e.target.value);
            void setMachine(e.target.value);
          }}
        >
          {choices.map((c) => (
            <option key={c.value} value={c.value} disabled={c.laptop && !allowLaptop}>
              {c.laptop ? `${c.label} (${LAPTOP_REASON})` : c.label}
            </option>
          ))}
        </select>
      </label>
      {laptops && (
        <label className="coord-card-allow dim">
          <input
            type="checkbox"
            checked={allowLaptop}
            disabled={readOnly || busy}
            onChange={(e) =>
              void write(
                { allow_laptop: e.target.checked },
                e.target.checked ? "allow a laptop to host the coordinator" : "refuse laptops",
              )
            }
          />{" "}
          Laptops: allow anyway
        </label>
      )}
      <p className="mono coord-card-state" data-testid="coord-state">
        {coordinatorStateLine(p.coordinatorRole)}
      </p>
      {error && <output className="s-hint coord-card-error">{error}</output>}
      <div className="coord-card-actions">
        {link && (
          <a className="btn" href={link} target="_blank" rel="noreferrer noopener">
            Open
          </a>
        )}
        {p.ops !== null && current !== null && (
          <button type="button" className="btn" disabled={busy} onClick={() => void restart()}>
            Restart
          </button>
        )}
      </div>
    </article>
  );
}
