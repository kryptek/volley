/**
 * Settings › Supervisor: volleyd's global config (the retained `_config`) as
 * D5's schema-driven rows (`ConfigRows`, global scope). A wave's own ⚙ shows
 * that wave's effective config and links back here. Above them, the lease
 * pools (`volley/_system/leases/+`, SPEC §4.6.5): each pool's holders grouped
 * by the machine they run on, its `per_machine` cap and the queue's reasons.
 */
import { SwitchToAdmin } from "../auth/AccountActions";
import type { ConfigPayload, LeasePoolPayload } from "../store/types";
import { ConfigRows } from "./ConfigRows";
import type { ConfigTransport } from "./configTransport";
import { SECTIONS } from "./schemaRows";

/** Every config group but autopilot's, which has its own section (Settings › Autopilot). */
const SUPERVISOR_SECTIONS = SECTIONS.filter((s) => s !== "Autopilot");

/** The prototype's macOS accent for the Supervisor sliders. */
const ACCENT = "#0a84ff";
/** A holder volleyd did not spawn (`host: null`), or one from a volleyd that predates `host`. */
export const UNKNOWN_HOST = "(unknown host)";

/** The per-machine cap in force on `host`: its override, else the pool's `per_machine`. */
export function capInForce(p: LeasePoolPayload, host: string): number | undefined {
  if (host === UNKNOWN_HOST) return undefined;
  return p.per_machine_overrides?.[host] ?? p.per_machine;
}

/**
 * A pool's holders by host, plus every host with a cap override (its cap shows before it holds
 * anything): hosts by name and the unknown host last.
 */
function byHost(p: LeasePoolPayload): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const host of Object.keys(p.per_machine_overrides ?? {})) groups.set(host, []);
  for (const h of p.held) {
    const host = h.host ?? UNKNOWN_HOST;
    groups.set(host, [...(groups.get(host) ?? []), h.holder]);
  }
  return [...groups].sort(
    ([a], [b]) => Number(a === UNKNOWN_HOST) - Number(b === UNKNOWN_HOST) || a.localeCompare(b),
  );
}

export function LeasePools({ leases }: { leases: Record<string, LeasePoolPayload> }) {
  const pools = Object.values(leases).sort((a, b) => a.pool.localeCompare(b.pool));
  if (pools.length === 0) return null;
  return (
    <section className="s-group lease-pools" aria-labelledby="lease-pools-h">
      <h3 id="lease-pools-h">Lease pools</h3>
      {pools.map((p) => (
        <article key={p.pool} className="lease-pool" aria-label={p.pool}>
          <div className="lease-head">
            <b className="mono">{p.pool}</b>
            <span className="dim">
              {p.held.length}/{p.capacity} held
              {p.per_machine !== undefined ? ` · ${p.per_machine} per machine` : ""}
            </span>
          </div>
          {byHost(p).map(([host, holders]) => {
            const cap = capInForce(p, host);
            return (
              // biome-ignore lint/a11y/useSemanticElements: a labelled group of holders, not a form fieldset
              <div key={host} className="lease-host" role="group" aria-label={host}>
                <span className="lease-host-name">{host}</span>
                <span
                  className="lease-host-count mono dim"
                  title={
                    cap !== undefined ? `${holders.length} held of ${cap} on ${host}` : undefined
                  }
                >
                  {cap !== undefined ? `${holders.length}/${cap}` : `${holders.length}`}
                </span>
                <span className="mono">
                  {holders.map((h) => (
                    <span key={h} className="lease-holder">
                      {h}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
          {p.queue.length > 0 && <div className="dim">{p.queue.length} queued</div>}
          {p.reasons.map((r) => (
            <p key={r} className="s-hint lease-reason">
              {r}
            </p>
          ))}
        </article>
      ))}
    </section>
  );
}

export function Supervisor({
  config,
  transport,
  leases = {},
  focus,
  focusSeq,
}: {
  /** The retained `volley/_waves/_config` payload. */
  config: ConfigPayload | null;
  /** `null` = no broker credentials: read-only with copyable commands. */
  transport: ConfigTransport | null;
  /** The retained lease pools, by pool. */
  leases?: Record<string, LeasePoolPayload>;
  /** A config row to scroll to and focus, by its path (a machine card's local agents chip). */
  focus?: string | undefined;
  /** Bumped on every such click, so a second one brings the row back into view. */
  focusSeq?: number | undefined;
}) {
  return (
    <>
      <LeasePools leases={leases} />
      {!transport && (
        <p className="s-note">
          Read-only: the Desk has no broker credentials. Pick a new value, then copy its command and
          run it in a terminal. <SwitchToAdmin />
        </p>
      )}
      <ConfigRows
        scope="global"
        sections={SUPERVISOR_SECTIONS}
        values={config}
        transport={transport}
        accent={ACCENT}
        focus={focus}
        focusSeq={focusSeq}
        foot="Saved through volleyd config set · applies at the next admission tick · never preempts running work. A wave’s own ⚙ shows the values that wave runs with."
      />
    </>
  );
}
