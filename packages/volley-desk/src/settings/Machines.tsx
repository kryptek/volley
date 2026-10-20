/**
 * Settings › Machines, ported from the prototype `MachinesBody` (SPEC
 * §4.6.14–15): the machines that can run agents for the waves. The
 * supervisor's own machine comes first as "this one" (its record is the one
 * named by `_config` `fleet.local_name`; until it has one, a placeholder card
 * with its agents), then one `MachineCard` per paired machine's retained
 * record under `volley/_system/machines/#`, with volleyd's readiness verdict
 * from `<name>/readiness` (stale while volleyd is not live) and, for an
 * admin, the cap editor. Only configured hosts are machines: every account
 * may publish its own record.
 *
 * An admin Desk can pair and unpair. **+ Add a machine** creates a pairing
 * code at once (`peer_invite`) and opens a Stepper on "Run this on the other
 * machine": the copyable `volley peer join <code> --to <ssh address>` (the
 * address of this machine, which the owner types) and the code's countdown,
 * waiting until a record for a host that was not there before arrives
 * (joined); then step 3 its checks and verdict (with Repair…), step 4 Claude
 * on it (Check again runs a dry doctor), step 5 its readiness and max_agents,
 * then Done. **Remove…** asks first, then sends `peer_remove`,
 * which revokes the machine's account and clears its record. Any other
 * session (not signed in, not an admin, demo, a browser that cannot make a
 * reply key at all) is read-only and is shown the terminal commands instead.
 * A plain-http LAN page can pair: its reply key comes from `lib/rsa.ts`.
 */
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { plural } from "../lib/plural";
import Stepper, { Step } from "../rb/Stepper/Stepper";
import { type AdminStatus, type PeerOps, joinCommand, pairingSupported } from "../store/peerOps";
import type {
  ClaudeAccountPayload,
  MachinePayload,
  ReadinessPayload,
  WaveStatePayload,
} from "../store/types";
import { DEFAULT_MAX_AGENTS, MachineCard, ReadinessLine, countdown } from "./MachineCard";
import { CheckRows, CopyCommand } from "./MachineRows";
import { RepairSheet } from "./RepairSheet";
import type { ConfigTransport } from "./configTransport";
import "../styles/machines.css";

const MACHINES_TINT = "#34c759";
/** How often the clock ticks: every second while a code counts down, else for the "seen" ages. */
const COUNTDOWN_TICK_MS = 1000;
const AGE_TICK_MS = 15_000;

export interface MachinesProps {
  /** Machine records, by name (`volley/_system/machines/#`); only `hosts` (and `localName`) are shown. */
  machines: Record<string, MachinePayload>;
  /** The configured hosts (`_waves/_config` `hosts`): the names that are machines; none by default. */
  hosts?: readonly string[];
  /** Whether volleyd, on this machine, is live: this machine's dot. */
  hubUp: boolean;
  /** This machine's live agents. */
  hubAgents?: number;
  /** `null` = no op channel (not signed in, demo): read-only. */
  ops: PeerOps | null;
  /** Clock override (tests); otherwise the section ticks. */
  now?: number;
  /** This machine's host as the Desk reaches it, for the ssh address's placeholder. */
  host?: string;
  /** Told what the admin check found (Settings' account row shows an admin as one). */
  onAdmin?: (admin: AdminStatus) => void;
  /** volleyd's readiness verdicts, by machine name (`volley/_system/machines/<name>/readiness`). */
  readiness?: Record<string, ReadinessPayload>;
  /** The supervisor's own machine name (`_config` `fleet.local_name`): its record is "this one". */
  localName?: string | null | undefined;
  /** volleyd's config channel, for the cap editors; `null` = read-only. */
  configTransport?: ConfigTransport | null;
  /** The Claude account records, for each machine's usage meter. */
  accounts?: Record<string, ClaudeAccountPayload>;
  /** Each machine's live agents (`agentsOnMachines`), listed by Remove. */
  agentsOn?: Record<string, string[]>;
  /** The remote Claude sign-in's button for a machine, when the Desk has one. */
  signIn?: (machine: string) => ReactNode;
  /** A machine to scroll into view on open (the agent window's machine chip). */
  focus?: string | undefined;
  /** Bumped on every chip click, so a second click on the same machine scrolls to it again. */
  focusSeq?: number | undefined;
}

const FINISHED: ReadonlySet<string> = new Set(["done", "cancelled"]);

/**
 * Each machine's agents, from the waves' unfinished tasks: a task's machine is its `host`, else
 * its placement's (the supervisor's own machine, under its local name). `live` narrows them to
 * the agents still running (the store's statuses).
 */
export function agentsOnMachines(
  states: readonly WaveStatePayload[],
  live: (agentId: string) => boolean = () => true,
): Record<string, string[]> {
  const on: Record<string, string[]> = {};
  for (const s of states) {
    for (const t of s.tasks) {
      const host = t.host ?? t.placement?.host;
      if (!host || FINISHED.has(t.stage)) continue;
      const ids = Object.values(t.agents).filter((a): a is string => !!a && live(a));
      if (ids.length) on[host] = [...(on[host] ?? []), ...ids];
    }
  }
  return on;
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

/**
 * Whether `ops` may pair: what is already known at once, else `null` until
 * volleyd answers. Asked again when volleyd comes up, since no answer is kept.
 */
function useAdmin(ops: PeerOps | null, hubUp: boolean): AdminStatus | null {
  const [admin, setAdmin] = useState<AdminStatus | null>(() => (ops ? ops.known() : "not-admin"));
  useEffect(() => {
    if (!ops) {
      setAdmin("not-admin");
      return;
    }
    const known = ops.known();
    if (known) {
      setAdmin(known);
      return;
    }
    let live = true;
    setAdmin((a) => (a === "no-answer" && !hubUp ? a : null));
    void ops.admin().then((a) => {
      if (live) setAdmin(a);
    });
    return () => {
      live = false;
    };
  }, [ops, hubUp]);
  return admin;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The ssh address's hint: the host the Desk reaches the broker on, which the
 * other machine can likely reach too; "" for a loopback address (the Desk
 * runs on this machine) or no broker. Only a hint: the ssh user is unknown
 * here, and a TLS proxy's host may not take ssh at all.
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

/** This machine: the broker and volleyd run here, so it has no tunnel and no record. */
function HubCard({ up, agents }: { up: boolean; agents: number }) {
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
        <span>{plural(agents, "agent")}</span>
      </div>
      <div className="s-hint">{up ? "volleyd running" : "volleyd not running"}</div>
    </article>
  );
}

type Pairing =
  | { phase: "creating" }
  | { phase: "failed"; error: string }
  | { phase: "waiting"; code: string; expiresAt: string; before: string[]; joined?: string };

/** The Add a machine Stepper: code created → the command to run there → joined. */
function AddMachine({
  ops,
  machines,
  readiness,
  config,
  signIn,
  now,
  host,
  hubUp,
  onClose,
}: {
  ops: PeerOps;
  machines: Record<string, MachinePayload>;
  readiness: Record<string, ReadinessPayload>;
  config: ConfigTransport | null;
  signIn: ((machine: string) => ReactNode) | undefined;
  now: number;
  host: string;
  hubUp: boolean;
  onClose: () => void;
}) {
  const [s, setS] = useState<Pairing>({ phase: "creating" });
  /** After the join: 0 Checks, 1 Claude on <machine>, 2 Ready. */
  const [after, setAfter] = useState(0);
  const [repairing, setRepairing] = useState(false);
  const [checking, setChecking] = useState<"idle" | "busy" | { error: string }>("idle");
  const [cap, setCap] = useState<string | null>(null);
  /** Done's cap change: sending, or why volleyd refused it (the step stays open). */
  const [saving, setSaving] = useState<"idle" | "busy" | { error: string }>("idle");
  const [to, setTo] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  // The panel opens below the cards: bring it into view (jsdom has no scrollIntoView).
  useEffect(() => panel.current?.scrollIntoView?.({ block: "nearest" }), []);
  // Latched once seen: the record going away again must not step back to a spent code.
  const newcomer =
    s.phase === "waiting" ? Object.keys(machines).find((n) => !s.before.includes(n)) : undefined;
  useEffect(() => {
    if (newcomer)
      setS((p) => (p.phase === "waiting" && !p.joined ? { ...p, joined: newcomer } : p));
  }, [newcomer]);
  const joined = s.phase === "waiting" ? (s.joined ?? newcomer) : undefined;
  const expired = s.phase === "waiting" && !joined && Date.parse(s.expiresAt) <= now;

  const machinesNow = useRef(machines);
  machinesNow.current = machines;
  const create = useCallback(async () => {
    const before = Object.keys(machinesNow.current);
    setS({ phase: "creating" });
    const r = await ops.invite();
    setS(
      r.ok
        ? { phase: "waiting", code: r.code, expiresAt: r.expiresAt, before }
        : { phase: "failed", error: r.error },
    );
  }, [ops]);
  // + Add a machine is the intent: the code is created at once, as in the prototype.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void create();
  }, [create]);

  const step = joined ? 3 + after : s.phase === "waiting" ? 2 : 1;
  const rec = joined ? machines[joined] : undefined;
  const verdict = joined ? readiness[joined] : undefined;
  const ctx = { machine: joined ?? "", repo: rec?.repo?.path };
  const currentCap = verdict?.max_agents ?? DEFAULT_MAX_AGENTS;
  const capValue = Number(cap ?? currentCap);
  const capValid = Number.isInteger(capValue) && capValue >= 1 && capValue <= 100;
  // Check again: a dry doctor run makes the machine publish a fresh record, and volleyd a verdict.
  const checkAgain = async () => {
    if (!joined) return;
    setChecking("busy");
    const a = await ops.doctor(joined, { fix: false });
    setChecking(a.ok ? "idle" : { error: a.error });
  };
  const done = async () => {
    if (joined && config && capValid && capValue !== currentCap) {
      setSaving("busy");
      const ack = await config.send(
        { hosts: { [joined]: { max_agents: capValue } } },
        { text: `set ${joined} max_agents to ${capValue}` },
      );
      if (!ack.applied) {
        setSaving({ error: ack.rejected[0]?.reason ?? ack.error ?? "volleyd refused" });
        return;
      }
    }
    onClose();
  };
  const next = (
    <div className="ny-actions">
      <button type="button" className="btn btn--hot" onClick={() => setAfter((n) => n + 1)}>
        Next
      </button>
    </div>
  );
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
        <Step title="Code" description={s.phase === "waiting" ? "Created" : "One-time"}>
          {s.phase === "failed" ? (
            <>
              <p className="s-error" role="alert">
                No code: {s.error}. Check that volleyd is running on this machine, then try again.
              </p>
              <div className="ny-actions">
                <button type="button" className="btn btn--hot" onClick={() => void create()}>
                  Try again
                </button>
                <button type="button" className="btn" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="dim">
                <span className="spinner" aria-hidden="true" /> Creating a one-time pairing code…
              </p>
              <div className="ny-actions">
                <button type="button" className="btn" disabled onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </Step>
        <Step title="Join" description="On the other machine">
          <h3>Run this on the other machine</h3>
          {!expired && (
            <>
              <label className="m-to">
                <span className="s-hint">
                  This machine’s ssh address (user@host), as the other machine reaches it
                </span>
                <input
                  className="recessed"
                  aria-label="This machine's ssh address"
                  placeholder={`you@${host || "hub-hostname"}`}
                  required
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              {s.phase === "waiting" && (
                <CopyCommand text={joinCommand(s.code, to)} ready={to.trim() !== ""} />
              )}
              {to.trim() === "" && (
                <p className="s-hint">
                  Enter this machine’s ssh address first: usually you@ its hostname, as{" "}
                  <code className="mono">volley peer invite</code> prints it.
                </p>
              )}
            </>
          )}
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
        <Step title="Checks" description="Joined">
          <h3>
            <HugeiconsIcon icon={Tick02Icon} size={15} strokeWidth={1.8} /> {joined} joined
          </h3>
          {rec?.checks?.length ? (
            <CheckRows checks={rec.checks} ctx={ctx} label={`Checks on ${joined}`} />
          ) : (
            <p className="dim">
              <span className="spinner" aria-hidden="true" /> Waiting for its first doctor report…
            </p>
          )}
          {rec && <ReadinessLine m={rec} r={verdict} now={now} hubUp={hubUp} />}
          <div className="ny-actions">
            {rec?.checks?.some((c) => !c.ok) && (
              <button type="button" className="btn" onClick={() => setRepairing(true)}>
                Repair…
              </button>
            )}
            <button type="button" className="btn btn--hot" onClick={() => setAfter(1)}>
              Next
            </button>
          </div>
          {repairing && joined && (
            <RepairSheet
              machine={joined}
              ops={ops}
              repo={rec?.repo?.path}
              onClose={() => setRepairing(false)}
            />
          )}
        </Step>
        <Step title="Claude" description={joined ? `On ${joined}` : "Sign in"}>
          <h3>Claude on {joined}</h3>
          {rec?.auth?.claude === "signed_in" ? (
            <p className="dim">Claude Code is signed in on {joined}.</p>
          ) : (
            (joined && signIn?.(joined)) || (
              <ol className="m-steps">
                <li>
                  On {joined}, run claude there and sign in (<code className="mono">/login</code>)
                  with the account its agents should use.
                </li>
                <li>Run claude once in the wave repo and accept the trust dialog.</li>
                <li>Check again here.</li>
              </ol>
            )
          )}
          {rec?.auth?.claude === "signed_in" && rec.auth.trust !== "ok" && (
            <p className="s-hint">
              Then run claude once in the wave repo on {joined} and accept the trust dialog.
            </p>
          )}
          {typeof checking === "object" && (
            <p className="s-error" role="alert">
              {checking.error}
            </p>
          )}
          <div className="ny-actions">
            <button
              type="button"
              className="btn"
              disabled={checking === "busy"}
              onClick={() => void checkAgain()}
            >
              {checking === "busy" ? "Checking…" : "Check again"}
            </button>
          </div>
          {next}
        </Step>
        <Step title="Ready" description="Placement">
          <h3>{verdict?.ready ? `${joined} is ready for agents` : `${joined} is not ready yet`}</h3>
          {verdict && !verdict.ready && (
            <ul className="m-reasons">
              {verdict.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          <p className="dim">
            Waves with <code className="mono">placement: auto</code> (or a task with{" "}
            <code className="mono">host: auto</code>) can place agents on {joined} while it is
            ready; every other task runs where its wave file says.
          </p>
          {config && (
            <label className="m-cap">
              <span className="s-hint">Max agents</span>
              <input
                className="recessed mono"
                type="number"
                min={1}
                max={100}
                aria-label={`Max agents on ${joined}`}
                value={cap ?? String(currentCap)}
                onChange={(e) => {
                  setCap(e.target.value);
                  setSaving("idle");
                }}
              />
            </label>
          )}
          {typeof saving === "object" && (
            <p className="s-error" role="alert">
              max_agents was not set: {saving.error}
            </p>
          )}
          <div className="ny-actions">
            <button
              type="button"
              className="btn btn--hot"
              disabled={!capValid || saving === "busy"}
              onClick={() => void done()}
            >
              Done
            </button>
          </div>
        </Step>
      </Stepper>
    </div>
  );
}

/** Why this session cannot pair, said before the terminal commands. */
function readOnlyReason(secure: boolean, admin: AdminStatus | null): string {
  if (!secure) {
    return "Read-only here: this browser cannot make the key that keeps the pairing code private.";
  }
  if (admin === null) return "Checking whether this Desk may pair machines…";
  if (admin === "no-answer") {
    return "volleyd did not answer, so this Desk cannot tell whether it may pair machines: pairing needs volleyd running on this machine.";
  }
  return "Read-only: pairing and removing machines takes an admin account. To pair from here, sign in to the Desk with an admin account.";
}

export function Machines(p: MachinesProps) {
  const [adding, setAdding] = useState(false);
  /** Re-pairing codes counting down on cards. */
  const [counting, setCounting] = useState(0);
  const onCountdown = useCallback((on: boolean) => setCounting((n) => n + (on ? 1 : -1)), []);
  const now = useNow(p.now, adding || counting > 0 ? COUNTDOWN_TICK_MS : AGE_TICK_MS);
  // A browser that cannot make a reply key at all (not even lib/rsa's): read-only.
  const secure = pairingSupported();
  const admin = useAdmin(secure ? p.ops : null, p.hubUp);
  const { onAdmin } = p;
  useEffect(() => {
    if (admin !== null) onAdmin?.(admin);
  }, [admin, onAdmin]);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const { focus, focusSeq, localName } = p;
  // On open (and on every chip click): the focused machine's card (this machine's is the hub card
  // until it has a record).
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new focusSeq is a new chip click
  useEffect(() => {
    if (!focus) return;
    const cards = [...(list.current?.querySelectorAll("article.machine") ?? [])];
    const label = (el: Element) => el.getAttribute("aria-label");
    const el =
      cards.find((c) => label(c) === focus) ??
      (focus === localName ? cards.find((c) => c.classList.contains("machine--hub")) : undefined);
    el?.scrollIntoView({ block: "nearest" });
  }, [focus, focusSeq, localName]);
  const shown = useMemo(() => {
    const hosts = new Set(p.hosts ?? []);
    return Object.fromEntries(Object.entries(p.machines).filter(([n]) => hosts.has(n)));
  }, [p.machines, p.hosts]);
  const machines = Object.values(shown).sort((a, b) => a.name.localeCompare(b.name));
  const canPair = secure && admin === "admin" && p.ops !== null;
  // volleyd's own record, published as itself under its local name (never a configured host).
  const own = p.localName ? p.machines[p.localName] : undefined;
  const card = (m: MachinePayload, self = false) => (
    <MachineCard
      key={m.name}
      m={m}
      r={p.readiness?.[m.name]}
      now={now}
      hubUp={p.hubUp}
      self={self}
      admin={canPair}
      ops={p.ops}
      config={p.configTransport}
      accounts={p.accounts}
      agents={p.agentsOn?.[m.name]}
      host={p.host}
      onRemoved={setNotice}
      signIn={self ? undefined : p.signIn?.(m.name)}
      onCountdown={onCountdown}
    />
  );

  return (
    <div className="machines-section">
      <p className="dim">
        Machines that can run agents for your waves. Agents on another machine report back through a
        private tunnel.
      </p>
      {notice && <output className="s-hint m-notice">{notice}</output>}
      <div className="machines" ref={list}>
        {own ? card(own, true) : <HubCard up={p.hubUp} agents={p.hubAgents ?? 0} />}
        {machines.map((m) => card(m))}
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
          machines={shown}
          readiness={p.readiness ?? {}}
          config={p.configTransport ?? null}
          signIn={p.signIn}
          now={now}
          host={p.host ?? ""}
          hubUp={p.hubUp}
          onClose={() => setAdding(false)}
        />
      )}
      {!canPair && (
        <p className="s-hint m-readonly">
          {readOnlyReason(secure, admin)} From a terminal on this machine,{" "}
          <code className="mono">volley peer invite</code> makes a pairing code and{" "}
          <code className="mono">volley peer remove &lt;name&gt;</code> unpairs one.
        </p>
      )}
    </div>
  );
}
