import { SwitchToAdmin } from "../auth/AccountActions";
/**
 * Settings › Supervisor: volleyd's global config (the retained `_config`) as
 * D5's schema-driven rows (`ConfigRows`, global scope). A wave's own ⚙ shows
 * that wave's effective config and links back here. Above them, the lease
 * pools (`volley/_system/leases/+`, SPEC §4.6.5): each pool's holders grouped
 * by the machine they run on, its `per_machine` cap and the queue's reasons.
 *
 * The section drills into groups (`GroupList`): Lease pools (the pools and
 * their capacity rows), Admission, Attention, Recovery and Other, one page each.
 */
import { plural } from "../lib/plural";
import type { ConfigPayload, LeasePoolPayload } from "../store/types";
import { ConfigRows } from "./ConfigRows";
import { GroupList } from "./GroupNav";
import type { ConfigTransport } from "./configTransport";
import { CONFIG_SCHEMA, type Section, schemaRows } from "./schemaRows";
import { sectionDef } from "./sections";

/** Each group's page: the config rows (`schemaRows` section) it shows. */
const PAGE_ROWS: Record<string, Section> = {
  leases: "Leases",
  admission: "Admission",
  attention: "Attention",
  recovery: "Recovery",
  other: "Other",
};

/** A config row's group (a deep link into `fleet.local_agents` opens Admission). */
export function supervisorGroupOf(section: Section): string {
  return Object.entries(PAGE_ROWS).find(([, s]) => s === section)?.[0] ?? "other";
}

/** `1800` → `30 min`; a time that is not whole minutes stays in seconds. */
const duration = (s: number | undefined) =>
  s === undefined ? "—" : s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`;

/** The group list's one-line summaries, from the retained config and lease pools. */
export function supervisorSummaries({
  config,
  leases,
}: {
  config: ConfigPayload | null;
  leases: Record<string, LeasePoolPayload>;
}): Record<string, string> {
  const pools = Object.values(leases);
  const held = pools.reduce((n, p) => n + p.held.length, 0);
  const capacity = pools.reduce((n, p) => n + p.capacity, 0);
  const other = schemaRows(CONFIG_SCHEMA, config).filter((r) => r.section === "Other").length;
  return {
    leases: pools.length
      ? `${plural(pools.length, "pool")} · ${held}/${capacity} held`
      : "No pools",
    admission: config
      ? `ceiling ${config.hard_ceiling ?? "—"} · budget ${config.spawn_budget_multiplier ?? "—"}×`
      : "",
    attention: config ? `heartbeat ${duration(config.heartbeat_alarm_s)}` : "",
    recovery: config
      ? `${config.fallback_model ?? "no fallback model"} · spawn ${duration(config.spawn_timeout_s)}`
      : "",
    other: plural(other, "setting"),
  };
}

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
    // The page title is already "Lease pools": the region keeps the name, not a second heading.
    <section className="s-group lease-pools" aria-label="Lease pools">
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
  group,
  onOpenGroup = () => {},
  hit,
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
  /** The open group's page, or null for the group list. */
  group: string | null;
  onOpenGroup?: (group: string) => void;
  /** The group a sidebar search hit. */
  hit?: string | undefined;
}) {
  const rows = group !== null && Object.hasOwn(PAGE_ROWS, group) ? PAGE_ROWS[group] : undefined;
  if (rows === undefined) {
    return (
      <GroupList
        section={sectionDef("supervisor")}
        summaries={supervisorSummaries({ config, leases })}
        onOpen={onOpenGroup}
        hit={hit}
      />
    );
  }
  return (
    <>
      {group === "leases" && <LeasePools leases={leases} />}
      {!transport && (
        <p className="s-note">
          Read-only: the Desk has no broker credentials. Pick a new value, then copy its command and
          run it in a terminal. <SwitchToAdmin />
        </p>
      )}
      <ConfigRows
        scope="global"
        sections={[rows]}
        untitled={group !== "leases"}
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
