/**
 * Remove… on a Claude account card (SPEC §4.6.11 `claude_account_remove`):
 * which profile goes (a machine picker when the account is on several), the
 * masked e-mail, and what removing does. Confirm sends the op for that one
 * profile; a refusal (an agent, a running wave or Defaults uses it) shows
 * here. The card leaves once volleyd's registry-changed signal brings the new
 * registry, not on the answer. The sheet is the Machines one (`MachineSheet`):
 * focus trap, Escape, full-screen at phone width.
 */
import { useState } from "react";
import { maskEmail } from "../lib/email";
import type { ControlFn } from "./ClaudeAccounts";
import { MachineSheet } from "./MachineSheet";

/** volleyd answers once the directory is gone, which on a paired machine is an ssh round trip. */
export const REMOVE_ACCOUNT_TIMEOUT_MS = 60_000;

/** One profile of the account the sheet can remove. */
export interface RemovableProfile {
  /** The op's `acct`: the usage-record key (`<id>`, or `<id>@<machine>`). */
  acct: string;
  /** How the card names its machine (`this machine`, `box-a`). */
  name: string;
  /** The profile's own label. */
  label: string;
}

export function RemoveAccountSheet({
  account,
  email,
  profiles,
  control,
  onClose,
  onDone,
}: {
  /** The account as its card names it. */
  account: string;
  email: string | null;
  profiles: readonly RemovableProfile[];
  control: ControlFn;
  onClose: () => void;
  /** volleyd removed it: what happened, for the section's notice; the owner closes the sheet. */
  onDone: (notice: string) => void;
}) {
  const [pick, setPick] = useState(profiles[0]?.acct ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = profiles.find((p) => p.acct === pick) ?? profiles[0];
  if (chosen === undefined) return null;

  const remove = async () => {
    setBusy(true);
    setError(null);
    const r = await control(
      "claude_account_remove",
      { acct: chosen.acct },
      `volley claude remove ${chosen.acct}`,
      REMOVE_ACCOUNT_TIMEOUT_MS,
    );
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "volleyd refused");
      return;
    }
    const res = r.result as { dir_removed?: boolean; dir_left?: string } | undefined;
    onDone(
      res?.dir_removed === false
        ? `${account} removed from ${chosen.name}; its profile directory was left in place: ${res.dir_left ?? "not removed"}`
        : `${account} removed from ${chosen.name}.`,
    );
  };

  return (
    <MachineSheet label={`Remove ${account}`} onClose={onClose}>
      {profiles.length > 1 ? (
        <fieldset className="ra-pick">
          <legend className="m-sheet-sub">Remove it from</legend>
          {profiles.map((p) => (
            <label key={p.acct} className="ra-option">
              <input
                type="radio"
                name="remove-account-machine"
                value={p.acct}
                checked={p.acct === chosen.acct}
                disabled={busy}
                onChange={() => setPick(p.acct)}
              />
              <span>{p.name}</span>
              <span className="dim ell">{p.label}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="dim">
          On <b>{chosen.name}</b>
        </p>
      )}
      <h4 className="m-sheet-sub">This will:</h4>
      <ul className="m-plan" aria-label="This will">
        <li>
          remove the profile <b>{chosen.label}</b> on {chosen.name}
          {email ? (
            <>
              {" "}
              (<span className="mono">{maskEmail(email)}</span>)
            </>
          ) : null}
          : its directory there, its usage record and its registry entry
        </li>
        <li>stop its sign-in, if one is waiting</li>
        <li>leave the login signed in with Anthropic: Volley never holds its credential</li>
      </ul>
      <p className="s-hint">
        volleyd refuses while an agent runs under it, a running wave names it or Defaults picks it.
      </p>
      {error && (
        <p className="s-error" role="alert">
          {error}
        </p>
      )}
      <div className="ny-actions">
        <button
          type="button"
          className="btn btn--danger"
          disabled={busy}
          onClick={() => void remove()}
        >
          {busy ? "Removing…" : `Remove from ${chosen.name}`}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </MachineSheet>
  );
}
