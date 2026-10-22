/**
 * One machine's card in Settings › Machines (SPEC §4.6.14–15): its name (and
 * "this one" for the supervisor's own record), os · cores · memory · disk,
 * the tunnel with its heartbeat dot, load, `agents/max_agents`, the 5-hour
 * usage of the account its agents run under, volleyd's readiness verdict
 * (ready for agents, the reasons it is not, draining, overloaded, or down
 * since when), and the doctor's checks as rows (✓ / ! / ✗) with the Desk's
 * fix for each failing one (`machineFixes.ts`). An admin also gets the cap
 * editor (`config_set hosts.<name>.max_agents`), **Repair…** (the doctor,
 * `RepairSheet`), **Re-pair…** (a code bound to the machine, `invite --for`)
 * and **Remove…** (`RemoveMachineSheet`); the supervisor's own machine has
 * none of them (its cap is `hard_ceiling`, and it is not paired). `signIn` is
 * the slot a remote Claude sign-in fills (the machine's default login); the
 * **Claude accounts** block lists every account with a filled dot where a
 * profile of it is signed in here and, where none is, **Sign in on <machine>**
 * (off while the tunnel is down). The supervisor's own card also
 * carries the local agents chip (`fleet.local_agents` from volleyd's verdict:
 * `always`, `never`, `fallback`, or `fallback · active` while no paired machine
 * is eligible), titled with volleyd's why; a click opens the setting.
 */

import { type ReactNode, useEffect, useState } from "react";
import { maskEmail } from "../lib/email";
import { plural } from "../lib/plural";
import { type PeerInvite, type PeerOps, joinCommand } from "../store/peerOps";
import type { ClaudeAccountPayload, MachinePayload, ReadinessPayload } from "../store/types";
import { CheckRows, CopyCommand } from "./MachineRows";
import { RemoveMachineSheet } from "./RemoveMachineSheet";
import { RepairSheet } from "./RepairSheet";
import type { ConfigAck, ConfigTransport } from "./configTransport";

/** volleyd's default `hosts.<name>.max_agents` (SPEC §4.6.15). */
export const DEFAULT_MAX_AGENTS = 4;
/** A verdict older than twice `machine_down_after_ms` (90 s) is stale (SPEC §4.6.15). */
const VERDICT_STALE_MS = 180_000;

/** `20s`, `5m`, `3h`, `2d`: how long ago `iso` was. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "a while";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** `m:ss` left until `iso`. */
export const countdown = (iso: string, now: number) => {
  const left = Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
};

const DOWN_REASON: Record<string, string> = {
  heartbeat_timeout: "no heartbeat",
  disconnect: "disconnected",
};

/** One load average as the record has it, at most two decimals. */
const load = (n: number | undefined) => (n === undefined ? "—" : String(Number(n.toFixed(2))));

/** `linux x64 · 16 cores · 64 GB · 312 GB free`: what the record says the machine is. */
function specs(m: MachinePayload): string {
  const parts = [`${m.os}${m.arch ? ` ${m.arch}` : ""}`, plural(m.cores, "core")];
  if (m.memory) parts.push(`${Math.round(m.memory.total_mb / 1024)} GB`);
  if (m.disk) parts.push(`${Math.round(m.disk.free_gb)} GB free`);
  return parts.join(" · ");
}

/** volleyd's verdict, in one line (or the reasons it is not ready). */
export function ReadinessLine({
  m,
  r,
  now,
  hubUp = true,
}: {
  m: MachinePayload;
  r: ReadinessPayload | undefined;
  now: number;
  /** Whether volleyd is live: while it is not, its verdict is stale (SPEC §4.6.15). */
  hubUp?: boolean;
}) {
  if (m.tunnel === "down") {
    return (
      <p className="m-ready m-ready--down">
        down · last seen {ago(m.last_seen, now)} ago ·{" "}
        {DOWN_REASON[m.reason ?? ""] ?? "tunnel down"}
      </p>
    );
  }
  if (!r) return <p className="s-hint">no verdict from volleyd yet</p>;
  const stale = !hubUp ? (
    <span className="dim"> · volleyd is not live</span>
  ) : now - Date.parse(r.checked_at) > VERDICT_STALE_MS ? (
    <span className="dim"> · verdict from {ago(r.checked_at, now)} ago</span>
  ) : null;
  if (r.drain) {
    return (
      <p className="m-ready m-ready--warn">
        draining · {plural(m.agents, "agent")} left{stale}
      </p>
    );
  }
  if (!r.ready) {
    return (
      <div className="m-ready m-ready--bad">
        <p>not ready{stale}</p>
        <ul className="m-reasons">
          {r.reasons.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (!r.eligible) {
    return (
      <p className="m-ready m-ready--warn">
        overloaded: {r.ineligible_reason ?? "placement skips it now"}
        {stale}
      </p>
    );
  }
  return <p className="m-ready m-ready--ok">ready for agents{stale}</p>;
}

/** `fallback · active` while the fallback profile is in force, else the mode. */
export function localAgentsText(la: NonNullable<ReadinessPayload["local_agents"]>): string {
  return la.mode === "fallback" && la.active ? "fallback · active" : la.mode;
}

/** The supervisor's own machine's `fleet.local_agents` mode; a click opens the setting. */
function LocalAgentsChip({
  la,
  onOpen,
}: {
  la: NonNullable<ReadinessPayload["local_agents"]>;
  onOpen?: (() => void) | undefined;
}) {
  const text = localAgentsText(la);
  const cls = `chip m-local${la.active ? " m-local--active" : ""}`;
  if (!onOpen) {
    return (
      <span className={cls} title={la.why}>
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      title={la.why}
      aria-label={`Local agents: ${text}`}
      onClick={onOpen}
    >
      {text}
    </button>
  );
}

/** The 5-hour usage of the account the machine's agents run under. */
function UsageMeter({ account, pct }: { account: string; pct: number }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="m-usage">
      <span className="mono ell">{account}</span>
      <span
        className="m-meter"
        role="meter"
        aria-label={`${account} 5-hour usage`}
        aria-valuenow={v}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i style={{ width: `${v}%` }} />
      </span>
      <span className="mono">{v}%</span>
    </div>
  );
}

/** One Claude account as a machine card lists it. */
export interface MachineAccountRow {
  /** The account group's key. */
  key: string;
  label: string;
  email: string | null;
  plan: string | null;
  /** Its profile here (`default login` for the machine's own); `null`: not signed in here. */
  held: { label: string } | null;
  /** The machine's tunnel is up: a sign-in can start. */
  up: boolean;
}

/** The Claude accounts signed in here, and Sign in on the machine for the ones that are not. */
function AccountRows({
  name,
  rows,
  onSignInOn,
}: {
  name: string;
  rows: MachineAccountRow[];
  onSignInOn?: ((key: string) => void) | undefined;
}) {
  return (
    <div className="m-accounts-block">
      <div className="s-hint">Claude accounts</div>
      <ul className="m-accounts" aria-label={`Claude accounts on ${name}`}>
        {rows.map((a) => (
          <li key={a.key} className={a.held ? undefined : "gap"}>
            <span className={`cc-dot${a.held ? " cc-dot--in" : ""}`} aria-hidden="true" />
            <span className="sr-only">{a.held ? "signed in here" : "not signed in here"}</span>
            <b className="ell">{a.label}</b>
            {a.email && <span className="mono dim ell">{maskEmail(a.email)}</span>}
            {a.plan && <span className="chip">{a.plan}</span>}
            {a.held ? (
              <span className="dim ell">{a.held.label}</span>
            ) : (
              onSignInOn && (
                <span className="cc-signin">
                  {!a.up && <span className="s-hint">tunnel down</span>}
                  <button
                    type="button"
                    className="btn"
                    disabled={!a.up}
                    aria-label={`Sign in on ${name} with ${a.label}`}
                    onClick={() => onSignInOn(a.key)}
                  >
                    Sign in on {name}
                  </button>
                </span>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `hosts.<name>.max_agents` (1–100): set through volleyd's config_set. */
export function CapEditor({
  name,
  value,
  transport,
}: {
  name: string;
  value: number;
  transport: ConfigTransport;
}) {
  const [draft, setDraft] = useState(String(value));
  const [ack, setAck] = useState<ConfigAck | "sending" | null>(null);
  useEffect(() => setDraft(String(value)), [value]);
  const n = Number(draft);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100;
  const set = async () => {
    setAck("sending");
    setAck(
      await transport.send(
        { hosts: { [name]: { max_agents: n } } },
        { text: `set ${name} max_agents to ${n}` },
      ),
    );
  };
  return (
    <div className="m-cap">
      <label>
        <span className="s-hint">Max agents</span>
        <input
          className="recessed mono"
          type="number"
          min={1}
          max={100}
          aria-label={`Max agents on ${name}`}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setAck(null);
          }}
        />
      </label>
      <button
        type="button"
        className="btn"
        disabled={!valid || n === value || ack === "sending"}
        onClick={() => void set()}
      >
        Set
      </button>
      {ack !== null && ack !== "sending" && (
        <output className={`s-hint${ack.applied ? " cfg-ack--ok" : " s-error"}`}>
          {ack.applied
            ? `saved${ack.version ? ` (config v${ack.version})` : ""}`
            : (ack.rejected[0]?.reason ?? ack.error ?? "volleyd refused")}
        </output>
      )}
    </div>
  );
}

/** Re-pair: a code that joins only as this machine (`peer_invite { for }`), and its command. */
function RePair({
  name,
  ops,
  now,
  host,
  onClose,
  onCountdown,
}: {
  name: string;
  ops: PeerOps;
  now: number;
  host: string;
  onClose: () => void;
  onCountdown?: ((on: boolean) => void) | undefined;
}) {
  const [invite, setInvite] = useState<PeerInvite | null>(null);
  const [to, setTo] = useState("");
  useEffect(() => {
    onCountdown?.(true);
    return () => onCountdown?.(false);
  }, [onCountdown]);
  useEffect(() => {
    let live = true;
    void ops.invite(name).then((r) => {
      if (live) setInvite(r);
    });
    return () => {
      live = false;
    };
  }, [ops, name]);
  return (
    <div className="m-confirm">
      {invite === null && (
        <p className="dim">
          <span className="spinner" aria-hidden="true" /> Creating a re-pairing code for {name}…
        </p>
      )}
      {invite && !invite.ok && (
        <p className="s-error" role="alert">
          No code: {invite.error}
        </p>
      )}
      {invite?.ok && (
        <>
          <p className="s-hint">
            On {name}, run this. It replaces {name}'s account and keeps its cap; the code works once
            and expires in <span className="mono">{countdown(invite.expiresAt, now)}</span>.
          </p>
          <label className="m-to">
            <span className="s-hint">This machine’s ssh address (user@host)</span>
            <input
              className="recessed"
              aria-label="This machine's ssh address"
              placeholder={`you@${host || "hub-hostname"}`}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <CopyCommand text={joinCommand(invite.code, to, name)} ready={to.trim() !== ""} />
        </>
      )}
      <div className="ny-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

type Open = "repair" | "repair-code" | "remove" | null;

export interface MachineCardProps {
  m: MachinePayload;
  /** volleyd's verdict on it; absent until one arrives. */
  r?: ReadinessPayload | undefined;
  now: number;
  /** Whether volleyd is live: while it is not, the verdict shows as stale. */
  hubUp?: boolean | undefined;
  /** The supervisor's own machine ("this one"): no pairing ops, no cap editor. */
  self?: boolean;
  /** An admin session: Repair, Re-pair, Remove and the cap editor. */
  admin: boolean;
  ops: PeerOps | null;
  /** volleyd's config channel, for the cap editor; `null` = read-only. */
  config?: ConfigTransport | null | undefined;
  /** The Claude account records (`volley/_system/claude-accounts/+`), for the usage meter. */
  accounts?: Record<string, ClaudeAccountPayload> | undefined;
  /** The machine's live agents, listed by Remove. */
  agents?: readonly string[] | undefined;
  /** This machine's host, for the re-pair command's ssh address hint. */
  host?: string | undefined;
  /** Removal accepted (done, draining, or stopping): what to tell the section. */
  onRemoved: (notice: string) => void;
  /** The remote Claude sign-in's button for this machine, when one exists. */
  signIn?: ReactNode;
  /** Every Claude account, held here or not (the account matrix's column for this machine). */
  accountRows?: MachineAccountRow[] | undefined;
  /** Sign in on this machine with an account (by group key); absent: read-only. */
  onSignInOn?: ((key: string) => void) | undefined;
  /** A re-pairing code starts (`true`) or stops counting down: the section ticks faster meanwhile. */
  onCountdown?: (on: boolean) => void;
  /** The local agents chip's click (own card only): open the `fleet.local_agents` setting. */
  onOpenLocalAgents?: (() => void) | undefined;
}

export function MachineCard(p: MachineCardProps) {
  const { m, r, now, ops } = p;
  const [open, setOpen] = useState<Open>(null);
  const down = m.tunnel === "down";
  const ctx = { machine: m.name, repo: m.repo?.path };
  const account = r?.usage.account ?? `primary@${m.name}`;
  const pct = p.accounts?.[account]?.five_hour?.pct ?? r?.usage.five_hour_pct ?? null;
  const pairing = p.admin && !p.self && ops !== null;
  return (
    <article
      className={`machine${down ? " machine--down" : ""}${p.self ? " machine--hub" : ""}`}
      aria-label={m.name}
    >
      <div className="m-head">
        <b>{m.name}</b>
        {p.self && <span className="chip chip--mine">this one</span>}
        {p.self && r?.local_agents && (
          <LocalAgentsChip la={r.local_agents} onOpen={p.onOpenLocalAgents} />
        )}
      </div>
      <div className="dim">{specs(m)}</div>
      <div className="m-stats">
        <span className={`hb${down ? " hb--stale" : ""}`}>
          <i />
          {m.tunnel === "local" ? "local" : `tunnel ${m.tunnel}`}
        </span>
        <span className="mono">load {load(m.load[0])}</span>
        <span>{r ? `${m.agents}/${r.max_agents} agents` : plural(m.agents, "agent")}</span>
      </div>
      {!down && <div className="s-hint">seen {ago(m.last_seen, now)} ago</div>}
      <ReadinessLine m={m} r={r} now={now} hubUp={p.hubUp ?? true} />
      {down && (
        <p className="s-hint m-note">
          New agents for it wait until it is back; the ones already running keep going.
        </p>
      )}
      {pct !== null && <UsageMeter account={account} pct={pct} />}
      {p.accountRows && p.accountRows.length > 0 && (
        <AccountRows name={m.name} rows={p.accountRows} onSignInOn={p.onSignInOn} />
      )}
      {m.checks && m.checks.length > 0 && (
        <CheckRows checks={m.checks} ctx={ctx} label={`Checks on ${m.name}`} />
      )}
      {p.signIn}
      {p.admin && !p.self && p.config && (
        <CapEditor name={m.name} value={r?.max_agents ?? DEFAULT_MAX_AGENTS} transport={p.config} />
      )}
      {pairing && open !== "repair-code" && (
        <div className="m-actions">
          <button type="button" className="btn" onClick={() => setOpen("repair")}>
            Repair…
          </button>
          <button type="button" className="btn" onClick={() => setOpen("repair-code")}>
            Re-pair…
          </button>
          <button type="button" className="btn m-remove" onClick={() => setOpen("remove")}>
            Remove…
          </button>
        </div>
      )}
      {pairing && open === "repair-code" && (
        <RePair
          name={m.name}
          ops={ops}
          now={now}
          host={p.host ?? ""}
          onClose={() => setOpen(null)}
          onCountdown={p.onCountdown}
        />
      )}
      {pairing && open === "repair" && (
        <RepairSheet machine={m.name} ops={ops} repo={m.repo?.path} onClose={() => setOpen(null)} />
      )}
      {pairing && open === "remove" && (
        <RemoveMachineSheet
          machine={m.name}
          agents={p.agents ?? []}
          ops={ops}
          onClose={() => setOpen(null)}
          onDone={(notice) => {
            setOpen(null);
            p.onRemoved(notice);
          }}
        />
      )}
    </article>
  );
}
