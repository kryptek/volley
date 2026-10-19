/**
 * Settings › Machines, ported from the prototype `MachinesBody` (SPEC
 * §4.6.14): the machines that can run agents for the waves. This machine (the
 * one with the broker and volleyd, "this one") comes first, then one card per
 * paired machine's retained record on `volley/_system/machines/+`: name,
 * os/arch and cores, the tunnel with its heartbeat dot, the 1-minute load, its
 * agents and when it was last heard from (why it is down, when it is).
 *
 * An admin Desk can pair and unpair. **Add a machine** is a Stepper: it first
 * says what a pairing code does, then creates one (`peer_invite`), then shows
 * "Run this on the other machine" with the copyable
 * `volley peer join <code> --to <ssh address>` (the address is editable) and
 * the code's countdown, waiting until a record for a machine that was not
 * there before arrives (joined), then Done. **Remove…** asks first, then
 * sends `peer_remove`, which revokes the machine's account and clears its
 * record. Any other session (not signed in, not an admin, demo) is read-only
 * and is shown the terminal commands instead.
 */
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useEffect, useRef, useState } from "react";
import { plural } from "../lib/plural";
import Stepper, { Step } from "../rb/Stepper/Stepper";
import { type PeerOps, joinCommand } from "../store/peerOps";
import type { MachinePayload } from "../store/types";
import "../styles/machines.css";

const MACHINES_TINT = "#34c759";
/** How often the clock ticks: every second while a code counts down, else for the "seen" ages. */
const COUNTDOWN_TICK_MS = 1000;
const AGE_TICK_MS = 15_000;
const COPIED_MS = 2000;

export interface MachinesProps {
  /** Paired machines' retained records, by name (`volley/_system/machines/+`). */
  machines: Record<string, MachinePayload>;
  /** Whether volleyd, on this machine, is live: this machine's dot. */
  hubUp: boolean;
  /** `null` = no op channel (not signed in, demo): read-only. */
  ops: PeerOps | null;
  /** Clock override (tests); otherwise the section ticks. */
  now?: number;
  /** The `--to` the join command starts with: how the other machine reaches this one over ssh. */
  host?: string;
}

/** The clock, ticking every `ms`; a fixed `now` (tests) never ticks. */
function useNow(fixed: number | undefined, ms: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [fixed, ms]);
  return fixed ?? now;
}

/** Whether `ops` proves an admin: `null` while volleyd has not answered yet. */
function useAdmin(ops: PeerOps | null): boolean | null {
  const [admin, setAdmin] = useState<boolean | null>(ops ? null : false);
  useEffect(() => {
    if (!ops) {
      setAdmin(false);
      return;
    }
    let live = true;
    setAdmin(null);
    void ops.admin().then((a) => {
      if (live) setAdmin(a);
    });
    return () => {
      live = false;
    };
  }, [ops]);
  return admin;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The join command's first `--to`: the host the Desk reaches the broker on,
 * which the other machine can likely reach too; "" for a loopback address
 * (the Desk runs on this machine) or no broker.
 */
export function sshHost(brokerUrl: string | null): string {
  if (!brokerUrl) return "";
  try {
    const host = new URL(brokerUrl).hostname;
    return LOOPBACK.has(host) ? "" : host;
  } catch {
    return "";
  }
}

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
const countdown = (iso: string, now: number) => {
  const left = Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
};

const DOWN_REASON: Record<string, string> = {
  heartbeat_timeout: "no heartbeat",
  disconnect: "disconnected",
};

/** One load average as the record has it, at most two decimals. */
const load = (n: number | undefined) => (n === undefined ? "—" : String(Number(n.toFixed(2))));

type Removing = { phase: "confirm" } | { phase: "busy" } | { phase: "failed"; error: string };

function MachineCard({
  m,
  now,
  admin,
  onRemoved,
  ops,
}: {
  m: MachinePayload;
  now: number;
  admin: boolean;
  onRemoved: (name: string) => void;
  ops: PeerOps | null;
}) {
  const [removing, setRemoving] = useState<Removing | null>(null);
  const down = m.tunnel === "down";
  const remove = async () => {
    if (!ops) return;
    setRemoving({ phase: "busy" });
    const r = await ops.remove(m.name);
    if (r.ok) {
      setRemoving(null);
      onRemoved(m.name);
    } else {
      setRemoving({ phase: "failed", error: r.error ?? "volleyd refused" });
    }
  };
  return (
    <article className="machine" aria-label={m.name}>
      <div className="m-head">
        <b>{m.name}</b>
      </div>
      <div className="dim">
        {m.os}
        {m.arch ? ` ${m.arch}` : ""} · {plural(m.cores, "core")}
      </div>
      <div className="m-stats">
        <span className={`hb${down ? " hb--stale" : ""}`}>
          <i />
          tunnel {m.tunnel}
        </span>
        <span className="mono">load {load(m.load[0])}</span>
        <span>{plural(m.agents, "agent")}</span>
      </div>
      <div className="s-hint">
        {down
          ? `${DOWN_REASON[m.reason ?? ""] ?? "tunnel down"} · last seen ${ago(m.last_seen, now)} ago`
          : `seen ${ago(m.last_seen, now)} ago`}
      </div>
      {down && (
        <p className="s-hint m-note">
          New agents for it wait until it is back; the ones already running keep going.
        </p>
      )}
      {admin && removing === null && (
        <button
          type="button"
          className="btn m-remove"
          onClick={() => setRemoving({ phase: "confirm" })}
        >
          Remove…
        </button>
      )}
      {admin && removing !== null && (
        <div className="m-confirm">
          <p className="s-hint">
            Remove {m.name}? This revokes its broker account, takes it out of volleyd’s hosts and
            clears its record. Its tunnel stops at its next check; pairing it again takes a new
            code.
          </p>
          {removing.phase === "failed" && (
            <p className="s-error" role="alert">
              {removing.error}
            </p>
          )}
          <div className="ny-actions">
            <button
              type="button"
              className="btn btn--danger"
              disabled={removing.phase === "busy"}
              onClick={() => void remove()}
            >
              {removing.phase === "busy" ? "Removing…" : `Remove ${m.name}`}
            </button>
            <button
              type="button"
              className="btn"
              disabled={removing.phase === "busy"}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/** This machine: the broker and volleyd run here, so it has no tunnel and no record. */
function HubCard({ up }: { up: boolean }) {
  return (
    <article className="machine machine--hub" aria-label="This machine">
      <div className="m-head">
        <b>This machine</b>
        <span className="chip chip--mine">this one</span>
      </div>
      <div className="dim">Runs the broker and volleyd</div>
      <div className="m-stats">
        <span className={`hb${up ? "" : " hb--stale"}`}>
          <i />
          local
        </span>
        <span>{up ? "volleyd running" : "volleyd not running"}</span>
      </div>
    </article>
  );
}

function CopyCommand({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), COPIED_MS);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="m-command recessed">
      <code className="mono">
        {text.split(" ").map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the words of one fixed command
          <Fragment key={i}>
            {i > 0 && " "}
            {w.startsWith("-") ? <span className="m-flag">{w}</span> : w}
          </Fragment>
        ))}
      </code>
      <button type="button" className="btn" onClick={() => void copy()}>
        <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.8} />
        {state === "copied" ? "Copied" : state === "failed" ? "Select it to copy" : "Copy"}
      </button>
    </div>
  );
}

type Pairing =
  | { phase: "off" }
  | { phase: "intro" }
  | { phase: "creating" }
  | { phase: "failed"; error: string }
  | { phase: "waiting"; code: string; expiresAt: string; before: string[] };

/** The Add a machine Stepper: what a code does → the command to run there → joined. */
function AddMachine({
  ops,
  machines,
  now,
  host,
  onClose,
}: {
  ops: PeerOps;
  machines: Record<string, MachinePayload>;
  now: number;
  host: string;
  onClose: () => void;
}) {
  const [s, setS] = useState<Pairing>({ phase: "intro" });
  const [to, setTo] = useState(host);
  const panel = useRef<HTMLDivElement>(null);
  // The panel opens below the cards: bring it into view (jsdom has no scrollIntoView).
  useEffect(() => panel.current?.scrollIntoView?.({ block: "nearest" }), []);
  const joined =
    s.phase === "waiting" ? Object.keys(machines).find((n) => !s.before.includes(n)) : undefined;
  const expired = s.phase === "waiting" && !joined && Date.parse(s.expiresAt) <= now;

  const create = async () => {
    const before = Object.keys(machines);
    setS({ phase: "creating" });
    const r = await ops.invite();
    setS(
      r.ok
        ? { phase: "waiting", code: r.code, expiresAt: r.expiresAt, before }
        : { phase: "failed", error: r.error },
    );
  };

  const step = joined ? 3 : s.phase === "waiting" ? 2 : 1;
  return (
    <div ref={panel} className="pair pair--machine">
      <Stepper
        theme="dark"
        accentColor={MACHINES_TINT}
        indicator="numbers"
        linear
        frame={false}
        width="100%"
        step={step}
        disableStepIndicators
        showFooter={false}
      >
        <Step title="Code" description="One-time">
          <h3>Pair a new machine</h3>
          <p className="dim">
            This creates a one-time pairing code, valid for 10 minutes. Nothing else changes until
            the other machine uses it: then volleyd gives that machine its own broker account and
            adds it to the machines waves can place agents on.
          </p>
          {s.phase === "failed" && (
            <p className="s-error" role="alert">
              No code: {s.error}. Check that volleyd is running on this machine, then try again.
            </p>
          )}
          <div className="ny-actions">
            <button
              type="button"
              className="btn btn--hot"
              disabled={s.phase === "creating"}
              onClick={() => void create()}
            >
              {s.phase === "creating"
                ? "Creating…"
                : s.phase === "failed"
                  ? "Try again"
                  : "Create pairing code"}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </Step>
        <Step title="Join" description="On the other machine">
          <h3>Run this on the other machine</h3>
          <label className="m-to">
            <span className="s-hint">
              This machine’s ssh address, as the other machine reaches it
            </span>
            <input
              className="recessed"
              aria-label="This machine's ssh address"
              placeholder="you@this-machine"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          {s.phase === "waiting" && <CopyCommand text={joinCommand(s.code, to)} />}
          {expired ? (
            <>
              <p className="s-error" role="alert">
                The code expired before a machine used it. Create a new one to keep pairing.
              </p>
              <div className="ny-actions">
                <button type="button" className="btn btn--hot" onClick={() => void create()}>
                  Create a new code
                </button>
                <button type="button" className="btn" onClick={onClose}>
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="dim">
                It checks ssh back to this machine, creates the machine’s account, installs its
                tunnel service, checks the repo is trusted and registers the machine. The code works
                once and expires in{" "}
                <span className="mono">
                  {s.phase === "waiting" ? countdown(s.expiresAt, now) : ""}
                </span>
                .
              </p>
              <div className="waiting">
                <span className="spinner" aria-hidden="true" /> Waiting for the machine to join…
              </div>
              <div className="ny-actions">
                <button type="button" className="btn" onClick={onClose}>
                  Stop waiting
                </button>
              </div>
            </>
          )}
        </Step>
        <Step title="Ready" description="Joined">
          <h3>
            <HugeiconsIcon icon={Tick02Icon} size={15} strokeWidth={1.8} /> {joined} joined
          </h3>
          <p className="dim">
            Its tunnel is up and it reports its health here. New waves can now place agents on{" "}
            {joined}.
          </p>
          <div className="ny-actions">
            <button type="button" className="btn btn--hot" onClick={onClose}>
              Done
            </button>
          </div>
        </Step>
      </Stepper>
    </div>
  );
}

export function Machines(p: MachinesProps) {
  const [adding, setAdding] = useState(false);
  const now = useNow(p.now, adding ? COUNTDOWN_TICK_MS : AGE_TICK_MS);
  const admin = useAdmin(p.ops);
  const [notice, setNotice] = useState<string | null>(null);
  const machines = Object.values(p.machines).sort((a, b) => a.name.localeCompare(b.name));
  const canPair = admin === true && p.ops !== null;

  return (
    <div className="machines-section">
      <p className="dim">
        Machines that can run agents for your waves. Agents on another machine report back through a
        private tunnel.
      </p>
      {notice && <output className="s-hint m-notice">{notice}</output>}
      <div className="machines">
        <HubCard up={p.hubUp} />
        {machines.map((m) => (
          <MachineCard
            key={m.name}
            m={m}
            now={now}
            admin={canPair}
            ops={p.ops}
            onRemoved={(name) => setNotice(`${name} removed: its account was revoked.`)}
          />
        ))}
        {canPair && !adding && (
          <button
            type="button"
            className="machine machine--add"
            onClick={() => {
              setNotice(null);
              setAdding(true);
            }}
          >
            + Add a machine
          </button>
        )}
      </div>
      {machines.length === 0 && (
        <p className="s-hint">
          No other machines yet. Pair one and waves can place agents on it too.
        </p>
      )}
      {canPair && adding && p.ops && (
        <AddMachine
          ops={p.ops}
          machines={p.machines}
          now={now}
          host={p.host ?? ""}
          onClose={() => setAdding(false)}
        />
      )}
      {!canPair && (
        <p className="s-hint m-readonly">
          {admin === null
            ? "Checking whether this Desk may pair machines…"
            : "Read-only: pairing and removing machines takes an admin account."}{" "}
          From a terminal on this machine, <code className="mono">volley peer invite</code> makes a
          pairing code and <code className="mono">volley peer remove &lt;name&gt;</code> unpairs
          one.
        </p>
      )}
    </div>
  );
}
