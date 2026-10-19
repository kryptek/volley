/**
 * Settings › Broker accounts, ported from the prototype `AccountsBody`: who
 * can connect to the broker and what they may do, managed through volleyd's
 * account ops (SPEC §4.6.10), never by the Desk writing a login itself. The
 * table lists `account_list` (name, role chip, where, last seen) and an
 * Agents row (every machine; the Desk's live agent count): agent logins are
 * minted by the supervisor per spawn and removed when the agent retires, so
 * there is nothing to manage. **New account**
 * picks a kind (Desk → can steer, Coordinator → can steer, Viewer → watch
 * only) and a name (the agent-id grammar: the name is the login and the
 * sender id), then `account_create`; **Rotate** is `account_rotate`; either
 * shows the new password once, with a QR code and Copy, sealed to this
 * browser on the way. **Revoke…** asks first, then `account_revoke`. Your
 * own account has no actions (volleyd refuses to rotate it over the control
 * channel, and revoking it would lock this browser out).
 *
 * A browser that is not an admin cannot list accounts (only an admin may send
 * account ops), so it sees only its own row and the Agents row, and how to
 * become an admin.
 */
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type AuthOps, type BrokerAccount, parseAccounts } from "../store/control";
import { Once } from "./onboardingParts";
import { Seg } from "./primitives";

/** The agent-id grammar (SPEC §2.2): an account's name is its login and its sender id. */
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

type NewKind = "desk" | "coordinator" | "viewer";

const KINDS: Record<NewKind, { label: string; role: string; kind: string; name: string }> = {
  desk: { label: "Desk (can steer)", role: "steer", kind: "device", name: "desk-ipad" },
  coordinator: { label: "Coordinator", role: "steer", kind: "service", name: "coordinator-laptop" },
  viewer: { label: "Viewer (watch only)", role: "watch", kind: "device", name: "viewer-tv" },
};

const ROLE_CHIP: Record<string, { text: string; tone: string }> = {
  admin: { text: "admin", tone: "admin" },
  steer: { text: "can steer", tone: "steer" },
  watch: { text: "can watch", tone: "agent" },
  supervisor: { text: "supervisor", tone: "sup" },
  peer: { text: "runs agents", tone: "peer" },
};

const KIND_WORD: Record<string, string> = {
  device: "a device",
  human: "a person",
  machine: "a machine",
  service: "a service",
};

function RoleChip({ role }: { role: string }) {
  const chip = ROLE_CHIP[role] ?? { text: role, tone: "agent" };
  return <span className={`role role--${chip.tone}`}>{chip.text}</span>;
}

/** `now`, `4s ago`, `2m ago`, `3h ago`, `5d ago`; `never` without a time. */
export function lastSeen(iso: string | undefined, now: number): string {
  const t = iso === undefined ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 2) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

type List =
  | { state: "loading" }
  | { state: "ready"; accounts: BrokerAccount[] }
  | { state: "failed"; error: string };

export interface BrokerAccountsProps {
  /** The admin channel; `null` when the Desk cannot send admin ops. */
  ops: AuthOps | null;
  admin: boolean;
  identity: string | null;
  /** The session's role, when known (a non-admin's own row). */
  role?: string | null;
  /** Agents with a live status on the broker now (the Agents row's "N live"); null when unknown. */
  liveAgents?: number | null;
  /** Clock override (tests). */
  now?: number;
}

export function BrokerAccounts(p: BrokerAccountsProps) {
  const now = p.now ?? Date.now();
  const canManage = p.admin && p.ops !== null;
  const [list, setList] = useState<List>({ state: "loading" });
  const [secret, setSecret] = useState<{ name: string; password: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { ops } = p;

  const load = useCallback(async () => {
    if (ops === null) return;
    const r = await ops.request("account_list");
    const accounts = r.ok ? parseAccounts(r.result) : null;
    setList(
      accounts === null
        ? { state: "failed", error: r.error ?? "volleyd's account list could not be read" }
        : { state: "ready", accounts },
    );
  }, [ops]);

  useEffect(() => {
    if (canManage) void load();
  }, [canManage, load]);

  const act = async (
    name: string,
    op: "account_rotate" | "account_revoke",
    ok: (r: { password?: string }) => void,
  ) => {
    if (ops === null) return;
    setBusy(name);
    setError(null);
    setNotice(null);
    const r = await ops.request(op, { name });
    setBusy(null);
    setConfirm(null);
    if (!r.ok) {
      setError(
        `${r.error ?? "volleyd refused"}${r.unanswered ? ": volleyd may still have done it, so check the list again" : ""}`,
      );
      return;
    }
    const pw = r.secret?.password;
    ok(typeof pw === "string" ? { password: pw } : {});
    void load();
  };

  if (!canManage) {
    return (
      <div className="s-embed">
        <p className="dim">
          Who can connect to your broker and what they may do. Only an admin can list and manage
          accounts: sign in as admin in Settings › Setup &amp; Security (a one-time token from{" "}
          <span className="mono">volley auth token</span>).
        </p>
        <table className="acct-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Where</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {p.identity !== null && (
              <tr>
                <td className="mono">{p.identity}</td>
                <td>{p.role ? <RoleChip role={p.role} /> : <span className="dim">—</span>}</td>
                <td className="dim">this browser</td>
                <td className="dim mono">now</td>
              </tr>
            )}
            <AgentsRow cols={4} live={p.liveAgents ?? null} />
          </tbody>
        </table>
        <p className="dim">Agents: {AGENTS_NOTE}</p>
      </div>
    );
  }

  return (
    <div className="s-embed">
      <p className="dim">
        Who can connect to your broker and what they may do. volleyd makes every change; a password
        is shown once, here, and only this browser can read it on the way.
      </p>
      {list.state === "loading" && (
        <div className="waiting">
          <span className="spinner" aria-hidden /> Asking volleyd for the accounts…
        </div>
      )}
      {list.state === "failed" && (
        <div className="s-error" role="alert">
          {list.error}. Check that volleyd is running (`volleyd status`).{" "}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setList({ state: "loading" });
              void load();
            }}
          >
            Try again
          </button>
        </div>
      )}
      {list.state === "ready" && (
        <table className="acct-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Where</th>
              <th>Last seen</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.accounts.map((a) => (
              <tr key={a.name}>
                <td>
                  <span className="mono">{a.name}</span>
                  {a.name === p.identity && <span className="dim"> · you</span>}
                </td>
                <td>
                  <RoleChip role={a.role} />
                </td>
                <td className="dim">{a.label ?? KIND_WORD[a.kind] ?? a.kind}</td>
                <td className="dim mono">{lastSeen(a.last_seen, now)}</td>
                <td>
                  {a.name !== p.identity && (
                    <div className="row-actions">
                      {confirm === a.name ? (
                        <>
                          <span className="confirm-line">It stops connecting at once.</span>
                          <button
                            type="button"
                            className="btn btn--danger"
                            disabled={busy === a.name}
                            onClick={() =>
                              void act(a.name, "account_revoke", () =>
                                setNotice(`${a.name} can no longer connect`),
                              )
                            }
                          >
                            Revoke
                          </button>
                          <button type="button" className="btn" onClick={() => setConfirm(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn"
                            disabled={busy === a.name}
                            onClick={() =>
                              void act(a.name, "account_rotate", ({ password }) => {
                                if (password !== undefined) setSecret({ name: a.name, password });
                              })
                            }
                          >
                            Rotate
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={busy === a.name}
                            onClick={() => setConfirm(a.name)}
                          >
                            Revoke…
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            <AgentsRow cols={5} live={p.liveAgents ?? null} />
          </tbody>
        </table>
      )}
      {error !== null && (
        <p className="s-error" role="alert">
          {error}
        </p>
      )}
      {notice !== null && <output className="s-note">{notice}</output>}
      {secret !== null && (
        <Once
          label={`Password for ${secret.name} (shown once)`}
          secret={secret.password}
          onDone={() => setSecret(null)}
        >
          <p className="dim">
            Sign in with username <span className="mono">{secret.name}</span>. It is not shown
            again; Rotate makes a new one.
          </p>
        </Once>
      )}
      {creating ? (
        <NewAccount
          ops={ops as AuthOps}
          taken={list.state === "ready" ? list.accounts.map((a) => a.name) : []}
          onCancel={() => setCreating(false)}
          onCreated={(name, password) => {
            setCreating(false);
            setSecret({ name, password });
            void load();
          }}
        />
      ) : (
        <div>
          <button type="button" className="btn btn--hot" onClick={() => setCreating(true)}>
            New account
          </button>
        </div>
      )}
    </div>
  );
}

const AGENTS_NOTE =
  "Created by the supervisor for each agent and removed when it retires. Nothing to manage.";

/** The prototype's Agents row: where they run, how many are live, and the note in the actions column. */
function AgentsRow({ cols, live }: { cols: 4 | 5; live: number | null }) {
  return (
    <tr className="agents-row">
      <td>Agents</td>
      <td>
        <span className="role role--agent">own topics only</span>
      </td>
      <td className="dim">every machine</td>
      <td className="dim mono">{live === null ? "—" : `${live} live`}</td>
      {cols === 5 ? <td className="dim agents-note">{AGENTS_NOTE}</td> : null}
    </tr>
  );
}

function NewAccount({
  ops,
  taken,
  onCancel,
  onCreated,
}: {
  ops: AuthOps;
  taken: string[];
  onCancel: () => void;
  onCreated: (name: string, password: string) => void;
}) {
  const [kind, setKind] = useState<NewKind>("desk");
  const [name, setName] = useState(KINDS.desk.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!AGENT_ID.test(n)) {
      setError("Use lowercase letters, digits, _ and - (it is the login name), e.g. desk-ipad.");
      return;
    }
    if (taken.includes(n)) {
      setError(`${n} already exists: pick another name, or Rotate it for a new password.`);
      return;
    }
    const k = KINDS[kind];
    setBusy(true);
    setError(null);
    const r = await ops.request("account_create", { name: n, role: k.role, kind: k.kind });
    setBusy(false);
    const pw = r.secret?.password;
    if (!r.ok || typeof pw !== "string") {
      setError(r.error ?? "volleyd's answer carried no password");
      return;
    }
    onCreated(n, pw);
  };
  return (
    <form className="create" aria-label="New account" onSubmit={(e) => void submit(e)}>
      <Seg
        label="Kind"
        options={(Object.keys(KINDS) as NewKind[]).map((k) => [k, KINDS[k].label] as const)}
        value={kind}
        onPick={(k) => {
          setKind(k);
          setName(KINDS[k].name);
        }}
      />
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {error !== null && (
        <p className="s-error" role="alert">
          {error}
        </p>
      )}
      <div className="wiz-actions wiz-actions--inline">
        <button type="submit" className="btn btn--hot" disabled={busy}>
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
