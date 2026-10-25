/**
 * Settings › Setup & Security, ported from the prototype `settings.tsx`
 * (`setup`). **Broker**: the broker the Desk talks to and, for an admin, what
 * `setup_plan` found: whether accounts are required (what the listeners do
 * with an anonymous client, from the detect step's probes; pending Security
 * changes are shown apart), each listener, when setup last ran. **Admin**
 * (admins only): Issue new token (`admin_token`: the one-time admin token comes
 * back sealed to this browser and is shown once; a volleyd that prints it in
 * its own terminal instead says so, and one without the op gets the `volley
 * auth token` command), New desk password (`desk_password`, after asking: the
 * shared `desk` login, which no file keeps, gets a new password sealed to this
 * browser and shown once), Preview the sign-in screen, and Run setup again (the
 * wizard in its own modal, `SetupWizard`, as `volley setup --repair`). A
 * browser that is not an admin sees how to become one: a one-time admin
 * token from `volley auth token`, pasted here or opened as `#signin=<token>`.
 * The Desk never writes a broker password; admin comes only from a token.
 */
import { type FormEvent, useEffect, useState } from "react";
import { useAccount } from "../auth/SignInGate";
import type { Progress } from "../getting-started/state";
import {
  type AuthOps,
  type SetupPlan,
  accountsRequired,
  isUnknownOp,
  listenerProbes,
  parseSetupPlan,
  parseToken,
  readSessionRole,
  rememberRole,
} from "../store/control";
import { CopyText, Once } from "./onboardingParts";
import { Group, Row } from "./primitives";

/** The fixed identities `volley auth init` makes: none of them is an admin account. */
const FIXED = new Set(["desk", "coordinator", "volleyd"]);
/** How long the admin check waits: a non-admin's request is dropped by the broker, never answered. */
export const ADMIN_PROBE_MS = 4000;

/**
 * Whether this browser's account is an admin. The stored role answers at once
 * (a redeemed token records it); otherwise, once `ask` is true, one
 * `account_list` decides: volleyd answers only an admin, and the broker drops
 * a non-admin's request (`ADMIN_PROBE_MS`). A yes is remembered with the
 * stored sign-in. volleyd checks the role again on every op either way.
 */
export function useAdminRole(
  ops: AuthOps | null,
  identity: string | null,
  ask: boolean,
): { admin: boolean; role: string | null } {
  // The stored role is read each render: `identity` arrives after the first one on a live Desk.
  const [probedRole, setRole] = useState<string | null>(null);
  const role = probedRole ?? readSessionRole(identity);
  const [probed, setProbed] = useState(false);
  useEffect(() => {
    if (!ask || probed || role !== null || ops === null || identity === null) return;
    if (FIXED.has(identity)) return;
    setProbed(true);
    void ops.request("account_list", {}, { timeoutMs: ADMIN_PROBE_MS }).then((r) => {
      if (!r.ok) return;
      rememberRole(identity, "admin");
      setRole("admin");
    });
  }, [ask, probed, role, ops, identity]);
  return { admin: ops !== null && role === "admin", role };
}

export interface SetupProps {
  /** The admin channel; `null` when the Desk cannot send admin ops. */
  ops: AuthOps | null;
  /** Whether this browser's account is an admin (the stored role, or a successful `account_list`). */
  admin: boolean;
  identity: string | null;
  brokerUrl: string | null;
  /** This Desk's URL without a fragment. */
  deskUrl: string;
  /** Shows the sign-in screen as a new browser or phone sees it. */
  onPreviewSignIn?: () => void;
  /** Sign in with a pasted admin token; default: reopen this Desk with `#signin=<token>`. */
  onUseToken?: (token: string) => void;
  /** Opens the setup wizard in its own modal (Settings closes meanwhile); `repair` for Run setup again. */
  onOpenSetup?: (repair: boolean) => void;
  /** Getting started: finished or skipped and when; `null` while it is neither. */
  gettingStarted?: Progress["done"] | null;
  /** Opens Getting started at the step it reached (Settings closes meanwhile). */
  onOpenGettingStarted?: () => void;
}

type PlanState =
  | { state: "none" }
  | { state: "loading" }
  | { state: "ready"; plan: SetupPlan }
  | { state: "unsupported" }
  | { state: "failed"; error: string };

type Issue =
  | { state: "idle" }
  | { state: "busy" }
  /** volleyd sealed the token to this browser: shown once, here. */
  | { state: "issued"; token: string; expiresAt: string | null }
  /** volleyd printed it in its own terminal (an older volleyd). */
  | { state: "printed"; expiresAt: string | null }
  | { state: "unsupported" }
  | { state: "failed"; error: string };

type DeskPassword =
  | { state: "idle" }
  /** Asking first: the new password signs out whatever uses the old one. */
  | { state: "confirm" }
  | { state: "busy" }
  | { state: "issued"; password: string }
  | { state: "unsupported" }
  | { state: "failed"; error: string };

function reopenWithToken(deskUrl: string) {
  return (token: string) => {
    window.location.assign(`${deskUrl}#signin=${token}`);
    // Only the fragment changed, so the page would not load again by itself.
    window.location.reload();
  };
}

/** Getting started's row: Not yet · Finished <date> · Skipped <date>. */
function gettingStartedState(done: Progress["done"] | null | undefined): string {
  if (!done) return "Not yet";
  const d = new Date(done.at);
  const date = Number.isNaN(d.getTime())
    ? ""
    : ` ${d.toLocaleDateString(undefined, { dateStyle: "medium" })}`;
  return `${done.kind === "finished" ? "Finished" : "Skipped"}${date}`;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function Setup(p: SetupProps) {
  const account = useAccount();
  const [plan, setPlan] = useState<PlanState>({ state: "none" });
  const [issue, setIssue] = useState<Issue>({ state: "idle" });
  const [desk, setDesk] = useState<DeskPassword>({ state: "idle" });
  const { ops, admin } = p;

  // The broker's state comes from setup's own planners; only an admin may ask.
  useEffect(() => {
    if (!admin || ops === null) return;
    let live = true;
    setPlan({ state: "loading" });
    void ops.request("setup_plan").then((r) => {
      if (!live) return;
      if (isUnknownOp(r)) return setPlan({ state: "unsupported" });
      const parsed = r.ok ? parseSetupPlan(r.result) : null;
      setPlan(
        parsed === null
          ? { state: "failed", error: r.error ?? "volleyd's plan could not be read" }
          : { state: "ready", plan: parsed },
      );
    });
    return () => {
      live = false;
    };
  }, [admin, ops]);

  const issueToken = async () => {
    if (ops === null) return;
    setIssue({ state: "busy" });
    const r = await ops.request("admin_token");
    if (isUnknownOp(r)) return setIssue({ state: "unsupported" });
    if (!r.ok) return setIssue({ state: "failed", error: r.error ?? "volleyd refused" });
    const exp = (r.result as { expires_at?: unknown } | undefined)?.expires_at;
    const expiresAt = typeof exp === "string" ? exp : null;
    const token = r.secret?.token;
    setIssue(
      typeof token === "string"
        ? { state: "issued", token, expiresAt }
        : { state: "printed", expiresAt },
    );
  };

  const issueDeskPassword = async () => {
    if (ops === null) return;
    setDesk({ state: "busy" });
    const r = await ops.request("desk_password");
    if (isUnknownOp(r)) return setDesk({ state: "unsupported" });
    const password = r.secret?.password;
    if (!r.ok || typeof password !== "string") {
      return setDesk({ state: "failed", error: r.error ?? "volleyd sent no password" });
    }
    setDesk({ state: "issued", password });
  };

  const ready = plan.state === "ready" ? plan.plan : null;
  const security = ready?.steps.find((s) => s.step === "security");
  const listeners = ready === null ? [] : listenerProbes(ready);
  const required = ready === null ? null : accountsRequired(ready);
  const pending = security?.changes.length ?? 0;

  return (
    <>
      <Group
        title="Broker"
        foot={
          !admin
            ? "Only an admin sees the broker's setup. Sign in as admin below."
            : plan.state === "unsupported"
              ? "This volleyd cannot report its setup to the Desk yet: run `volley setup` in a terminal for the full check."
              : plan.state === "failed"
                ? `${plan.error}. Check that volleyd is running (\`volleyd status\`).`
                : undefined
        }
      >
        <Row label="Connected to" hint="The broker this Desk signs in to">
          <span className="mono s-hint">{p.brokerUrl ?? "—"}</span>
        </Row>
        <Row label="Accounts required" hint="Only Volley identities can connect">
          {required === null ? (
            <span className="s-hint">{plan.state === "loading" ? "Checking…" : "—"}</span>
          ) : required ? (
            <span className="pill-ok">On</span>
          ) : (
            <span className="pill-warn">Off</span>
          )}
        </Row>
        {listeners.length > 0 && (
          <Row label="Listening" hint="What each listener does with a client that has no account">
            <span className="mono s-hint listeners">
              {listeners.map((l) => (
                <span key={l.port}>
                  {l.port}:{" "}
                  {l.anonymous === "refused"
                    ? "refuses anonymous clients"
                    : l.anonymous === "accepted"
                      ? "accepts anonymous clients"
                      : "not listening"}
                </span>
              ))}
            </span>
          </Row>
        )}
        {pending > 0 && (
          <Row label="Security" hint="Changes setup would make to the broker config">
            <span className="pill-warn">{pending} pending</span>
          </Row>
        )}
        {ready?.last_setup !== undefined && (
          <Row label="Last setup">
            <span className="s-hint">{when(ready.last_setup)} · backups kept</span>
          </Row>
        )}
      </Group>
      {admin && ops !== null ? (
        <Group title="Admin">
          {p.onOpenGettingStarted && (
            <Row
              label="Getting started"
              hint="The first-launch walk-through: this computer, machines, repos, people, access"
            >
              <span className="s-hint">{gettingStartedState(p.gettingStarted)}</span>
              <button type="button" className="btn" onClick={p.onOpenGettingStarted}>
                Open…
              </button>
            </Row>
          )}
          <Row
            label="One-time admin token"
            hint="Used once to sign in as admin on a new browser; shown here once"
          >
            <button
              type="button"
              className="btn"
              disabled={issue.state === "busy"}
              onClick={() => void issueToken()}
            >
              {issue.state === "busy" ? "Asking volleyd…" : "Issue new token"}
            </button>
          </Row>
          {issue.state === "issued" && (
            <div className="s-note">
              <Once label="One-time admin token (shown once)" secret={issue.token} qr={false}>
                <p className="dim">
                  Signs one browser in as admin, once
                  {issue.expiresAt !== null ? `, until ${when(issue.expiresAt)}` : ""}: open the
                  Desk there with <span className="mono">#signin=&lt;token&gt;</span> or paste it in
                  Settings › Setup &amp; Security.
                </p>
              </Once>
            </div>
          )}
          {issue.state === "printed" && (
            <output className="s-note">
              A new token was printed in the terminal running volleyd
              {issue.expiresAt !== null ? ` (valid until ${when(issue.expiresAt)})` : ""}.
            </output>
          )}
          {issue.state === "unsupported" && (
            <div className="s-note">
              This volleyd cannot issue tokens from the Desk. Run this in a terminal on the
              supervisor's machine: <CopyText text="volley auth token" />
            </div>
          )}
          {issue.state === "failed" && (
            <p className="s-error" role="alert">
              {issue.error}. Try again, or run `volley auth token` in a terminal.
            </p>
          )}
          <Row
            label="Desk login password"
            hint="The shared desk login (volley dash, a Desk signed in without a token); shown here once"
          >
            <button
              type="button"
              className="btn"
              disabled={desk.state === "busy" || desk.state === "confirm"}
              onClick={() => setDesk({ state: "confirm" })}
            >
              {desk.state === "busy" ? "Asking volleyd…" : "New desk password"}
            </button>
          </Row>
          {desk.state === "confirm" && (
            <div className="s-note">
              <p>
                A new password signs out whatever signs in as desk now: each of those signs in again
                with the new one.
              </p>
              <div className="wiz-actions wiz-actions--inline">
                <button type="button" className="btn" onClick={() => setDesk({ state: "idle" })}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--blue"
                  onClick={() => void issueDeskPassword()}
                >
                  Issue it
                </button>
              </div>
            </div>
          )}
          {desk.state === "issued" && (
            <div className="s-note">
              <Once label="desk login password (shown once)" secret={desk.password} qr={false}>
                <p className="dim">
                  Username <span className="mono">desk</span>. No file keeps it: copy it now. Lost,
                  it can only be replaced, here.
                </p>
              </Once>
            </div>
          )}
          {desk.state === "unsupported" && (
            <p className="s-note">
              This volleyd cannot issue the desk password from the Desk. Sign devices in with a
              one-time token or a sign-in link instead.
            </p>
          )}
          {desk.state === "failed" && (
            <p className="s-error" role="alert">
              {desk.error}. Try again.
            </p>
          )}
          {p.onPreviewSignIn && (
            <Row label="Sign-in screen" hint="What a new browser or phone sees first">
              <button type="button" className="btn" onClick={p.onPreviewSignIn}>
                Preview
              </button>
            </Row>
          )}
          <Row
            label="Run setup again"
            hint="Repairs services and accounts; asks before changing anything"
          >
            <button
              type="button"
              className="btn btn--blue"
              disabled={p.onOpenSetup === undefined}
              onClick={() => p.onOpenSetup?.(true)}
            >
              Open setup…
            </button>
          </Row>
        </Group>
      ) : (
        <BecomeAdmin
          identity={p.identity}
          onUseToken={
            p.onUseToken ??
            // In place through the Switch account entry; a page reload with the link otherwise.
            (account !== null && !account.byEnvironment
              ? account.switchAccount
              : reopenWithToken(p.deskUrl))
          }
          {...(p.onPreviewSignIn ? { onPreviewSignIn: p.onPreviewSignIn } : {})}
        />
      )}
    </>
  );
}

/** A non-admin browser: how to become an admin (a one-time admin token), and the preview. */
function BecomeAdmin({
  identity,
  onUseToken,
  onPreviewSignIn,
}: {
  identity: string | null;
  onUseToken: (token: string) => void;
  onPreviewSignIn?: () => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = token.trim();
    if (parseToken(t)?.kind !== "admin") {
      setError("That is not an admin token: it looks like vly_admin_<id>_<secret>.");
      return;
    }
    setError(null);
    onUseToken(t);
  };
  return (
    <Group
      title="Admin"
      foot={`${identity === null ? "This browser is not signed in" : `Signed in as ${identity}`}, which is not an admin. Setup and account changes need an admin.`}
    >
      <div className="s-pad become-admin">
        <p className="s-hint">
          Run this in a terminal on the supervisor's machine; it prints a one-time admin token
          (valid 10 minutes, single use):
        </p>
        <CopyText text="volley auth token" />
        <form className="token-form" onSubmit={submit}>
          <label className="field">
            <span>Admin token</span>
            <input
              value={token}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="vly_admin_…"
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn--blue">
            Sign in with token
          </button>
        </form>
        {error !== null && (
          <p className="s-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {onPreviewSignIn && (
        <Row label="Sign-in screen" hint="What a new browser or phone sees first">
          <button type="button" className="btn" onClick={onPreviewSignIn}>
            Preview
          </button>
        </Row>
      )}
    </Group>
  );
}
