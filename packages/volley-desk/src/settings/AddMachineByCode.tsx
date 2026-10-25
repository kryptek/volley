/**
 * Add a machine by pairing code (SPEC §4.6.14), shared by Settings › Machines (**+ Add a
 * machine**) and Getting started › Your machines: it creates a one-time code at once
 * (`peer_invite`, alive `peer_code_ttl_s`, 10 minutes by default) and opens a Stepper on "Run
 * this on the other machine": the copyable `volley peer join <code> --to <ssh address>` (the
 * address of this machine, which the owner types) and the code's countdown, waiting until a
 * record for a host that was not there before arrives (joined); then its checks and verdict (with
 * Repair…), Claude on it (Check again runs a dry doctor), its readiness and max_agents, then Done.
 */
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import Stepper, { Step } from "../rb/Stepper/Stepper";
import { type PeerOps, joinCommand } from "../store/peerOps";
import type { MachinePayload, ReadinessPayload } from "../store/types";
import { DEFAULT_MAX_AGENTS, ReadinessLine, countdown } from "./MachineCard";
import { CheckRows, CopyCommand } from "./MachineRows";
import { RepairSheet } from "./RepairSheet";
import type { ConfigTransport } from "./configTransport";
import { reposOnMachine } from "./repos";

const MACHINES_TINT = "#34c759";

/** The clock, ticking every `ms`; a fixed `now` (tests) never ticks. */
export function useNow(fixed: number | undefined, ms: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [fixed, ms]);
  return fixed ?? now;
}

type Pairing =
  | { phase: "creating" }
  | { phase: "failed"; error: string }
  | { phase: "waiting"; code: string; expiresAt: string; before: string[]; joined?: string };

/** The Add a machine Stepper: code created → the command to run there → joined. */
export function AddMachineByCode({
  ops,
  machines,
  readiness,
  config,
  signIn,
  now,
  host,
  hubUp,
  onClose,
  onJoined,
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
  /** A machine joined with the code. */
  onJoined?: (name: string) => void;
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
  const joinedNow = useRef(onJoined);
  joinedNow.current = onJoined;
  useEffect(() => {
    if (joined) joinedNow.current?.(joined);
  }, [joined]);
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
  const repos = joined ? reposOnMachine(joined, null, rec, verdict) : [];
  const ctx = { machine: joined ?? "", repo: rec?.repo?.path, repos };
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
              repos={repos}
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
