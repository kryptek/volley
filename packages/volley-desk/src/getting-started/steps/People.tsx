/**
 * Getting started › People: who uses this Desk, and an invite link for someone new.
 *
 * The table is `account_list` (SPEC §4.6.10) cut down to people: You (this Desk's identity) first,
 * then each other account by its label (else its name), with the wizard's role word beside the
 * SPEC's in a muted pill (`roleWords.ts`), its kind and when volleyd last saw it. Service and
 * machine accounts (`volleyd`, `desk`, `coordinator`, peers) are not people and are left out;
 * Settings › Broker accounts still lists everything.
 *
 * **Create invite link** takes a name and a role. Standard and Viewer are a `signin_link` (a
 * one-time sign-in link bound to the name, 10 minutes); a Superuser is an `admin_token` rendered
 * as `<desk>#signin=<token>`, shown once (`signin_link` never grants admin). The link comes with
 * Copy and a QR code; the person's row reads "invite link made" until their account appears (the
 * list is read again meanwhile). A volleyd that does not know the op gets the terminal command.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { lastSeen } from "../../settings/BrokerAccounts";
import { CopyText, Qr } from "../../settings/onboardingParts";
import { type BrokerAccount, isUnknownOp, parseAccounts, signinLink } from "../../store/control";
import { FIXED_IDENTITIES } from "../../store/peerOps";
import type { PersonRole } from "../state";
import type { StepProps } from "../steps";
import { ROLE_WORDS, type RoleWord, wordOfRole } from "./roleWords";

/** How often the accounts are read again while an invite has not been redeemed. */
export const INVITE_POLL_MS = 10_000;

/** A person's account: a role a person holds, and not a service or a machine. */
const isPerson = (a: BrokerAccount) =>
  wordOfRole(a.role) !== null &&
  a.kind !== "service" &&
  a.kind !== "machine" &&
  !FIXED_IDENTITIES.has(a.name);

/** The terminal twin of an invite. */
export const inviteCommand = (role: PersonRole, name: string) =>
  role === "admin"
    ? "volley auth token"
    : `volley auth signin-link --role ${role} --label "${name.replace(/"/g, '\\"')}"`;

type Invite =
  | { k: "idle" }
  | { k: "busy" }
  | { k: "made"; name: string; role: PersonRole; link: string }
  | { k: "failed"; name: string; role: PersonRole; error: string | null };

function RolePill({ of: role }: { of: string }) {
  const word = wordOfRole(role);
  return <span className="gs-role">{word ? `${word.toLowerCase()} · ${role}` : role}</span>;
}

export function People({ ctx, summary, setSummary }: StepProps) {
  const { ops } = ctx;
  const [accounts, setAccounts] = useState<BrokerAccount[] | null>(null);
  const [name, setName] = useState("");
  const [word, setWord] = useState<RoleWord["word"]>("Standard");
  const [invite, setInvite] = useState<Invite>({ k: "idle" });
  /** The invites made here, by name: a row each until the account appears. */
  const [made, setMade] = useState<{ name: string; role: PersonRole }[]>([]);
  const ids = useId();

  const load = useCallback(async () => {
    const r = await ops.request("account_list").catch(() => null);
    if (r?.ok) setAccounts(parseAccounts(r.result));
  }, [ops]);
  useEffect(() => {
    void load();
  }, [load]);

  const people = (accounts ?? []).filter(isPerson);
  const me = people.find((a) => a.name === ctx.identity);
  const others = people.filter((a) => a.name !== ctx.identity);
  const pending = made.filter((m) => !others.some((a) => a.label === m.name));
  // Read the accounts again while an invite is out, so its row turns into the account.
  useEffect(() => {
    if (pending.length === 0) return;
    const t = setInterval(() => void load(), INVITE_POLL_MS);
    return () => clearInterval(t);
  }, [pending.length, load]);

  const role = ROLE_WORDS.find((w) => w.word === word)?.role ?? "steer";
  const who = name.trim();
  const create = async () => {
    setInvite({ k: "busy" });
    const r =
      role === "admin"
        ? await ops.request("admin_token")
        : await ops.request("signin_link", { role, label: who, desk_url: ctx.deskUrl });
    const token = r.secret?.token;
    const base =
      role === "admin" ? ctx.deskUrl : (r.result as { link_base?: unknown } | undefined)?.link_base;
    if (!r.ok || typeof token !== "string" || typeof base !== "string") {
      setInvite({
        k: "failed",
        name: who,
        role,
        error: isUnknownOp(r) ? null : (r.error ?? "volleyd's answer carried no link"),
      });
      return;
    }
    setInvite({ k: "made", name: who, role, link: signinLink(base, token) });
    setMade((m) => [...m.filter((x) => x.name !== who), { name: who, role }]);
    setName("");
    setSummary({ people: [...summary.people.filter((p) => p.name !== who), { name: who, role }] });
  };

  const now = Date.now();
  return (
    <>
      <div className="gs-card">
        <table className="gs-people" aria-label="People">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Kind</th>
              <th scope="col">Last seen</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <b>You</b> <span className="dim mono">{ctx.identity ?? "this Desk"}</span>
              </td>
              <td>
                <RolePill of="admin" />
              </td>
              <td className="dim">{me?.kind ?? "device"}</td>
              <td className="dim">now</td>
            </tr>
            {others.map((a) => (
              <tr key={a.name}>
                <td>{a.label ?? a.name}</td>
                <td>
                  <RolePill of={a.role} />
                </td>
                <td className="dim">{a.kind}</td>
                <td className="dim">{lastSeen(a.last_seen, now)}</td>
              </tr>
            ))}
            {pending.map((m) => (
              <tr key={`invite-${m.name}`} className="gs-people-pending">
                <td>
                  {m.name} <span className="dim">· invite link made</span>
                </td>
                <td>
                  <RolePill of={m.role} />
                </td>
                <td className="dim">—</td>
                <td className="dim">not yet</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="gs-card">
        <h3 className="gs-card-title">Invite someone</h3>
        <div className="gs-invite">
          <label className="repo-field gs-grow">
            <span className="s-hint">Name</span>
            <input
              className="recessed"
              aria-label="Name"
              placeholder="Person A"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className="gs-roles">
            <legend className="s-hint">Role</legend>
            {ROLE_WORDS.map((w) => (
              <label key={w.word} className="gs-role-choice">
                <input
                  type="radio"
                  name={`${ids}-role`}
                  checked={word === w.word}
                  onChange={() => setWord(w.word)}
                />
                <span>
                  <b>{w.word}</b> <span className="dim">{w.what}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
        <div className="ny-actions">
          <button
            type="button"
            className="btn btn--hot"
            disabled={who === "" || invite.k === "busy"}
            onClick={() => void create()}
          >
            {invite.k === "busy" ? "Creating…" : "Create invite link"}
          </button>
        </div>
        {invite.k === "made" && (
          <div className="token gs-invite-link">
            <div className="token-main">
              <div className="lbl">{`${invite.name}'s invite link`}</div>
              <CopyText text={invite.link} />
              <p className="s-hint">
                The link signs them in once on any device, phone included, and then expires.
              </p>
              {invite.role === "admin" && (
                <p className="s-hint">
                  It is shown once and signs one browser in as admin: copy it now.
                </p>
              )}
            </div>
            <div className="token-side">
              <Qr text={invite.link} size={112} label={`QR code of ${invite.name}'s invite link`} />
            </div>
          </div>
        )}
        {invite.k === "failed" && (
          <div className="gs-invite-failed" role="alert">
            {invite.error && <p className="s-error">{invite.error}</p>}
            <p className="dim">
              {invite.error
                ? "Or make it from a terminal on the supervisor's machine:"
                : "This volleyd cannot make invite links from the Desk. From a terminal on the supervisor's machine:"}
            </p>
            <CopyText text={inviteCommand(invite.role, invite.name)} />
          </div>
        )}
      </div>
    </>
  );
}
