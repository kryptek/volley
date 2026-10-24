/**
 * Signing a paired machine in to Claude from the Desk (SPEC §4.6.11): **Sign
 * in on <machine>** on its card (and in Add a machine's step 4) opens this
 * sheet, which sends `claude_signin { acct: "primary@<name>" }`. volleyd
 * starts Claude Code's own `claude auth login` on that machine. `SigninLink`
 * shows Anthropic's code-page link (with its QR code), which works from any
 * device, and one box for the code that page shows, or for the address a
 * browser ended up on: Submit sends `claude_signin_entry`, and volleyd types
 * the code into the sign-in waiting on that machine (or completes the address
 * there). Done shows the plan, refreshes the machine's doctor rows
 * (`peer_doctor { fix: false }`) and turns the card's line green.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { maskEmail } from "../lib/email";
import { encodeQr } from "../lib/qr";
import type { PeerOps } from "../store/peerOps";
import type { ClaudeSignin } from "../store/types";
import { ADD_ACCOUNT_TIMEOUT_MS, type ControlFn } from "./ClaudeAccounts";
import { CopyCommand } from "./MachineRows";
import { MachineSheet } from "./MachineSheet";
import { Qr } from "./onboardingParts";
import "../styles/signin.css";

/** A paired machine's own Claude login (volleyd's `primary@<name>`). */
export const peerAccount = (machine: string) => `primary@${machine}`;

/** `max` → `Max`: the plan as Claude Code names it, for a label. */
const planLabel = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

/** What volleyd's `claude_signin` answer carries (the same fields as its URL event). */
interface Started {
  url?: string;
  flow?: string;
  attach?: string;
  manual_url?: string;
  callback_url?: string;
}

/** The URL fields of a `claude_signin` / `claude_account_add` answer (as its URL event). */
export function startedFields(result: unknown): Started {
  const res = (result ?? {}) as Record<string, unknown>;
  const out: Started = {};
  for (const k of ["url", "flow", "attach", "manual_url", "callback_url"] as const)
    if (typeof res[k] === "string") out[k] = res[k] as string;
  return out;
}

type Start = { k: "starting" } | { k: "started"; r: Started } | { k: "refused"; error: string };

export function PeerSigninSheet({
  machine,
  signin,
  control,
  ops,
  onClose,
}: {
  machine: string;
  /** The live sign-in events for `primary@<machine>` (the store's `signins`). */
  signin: ClaudeSignin | undefined;
  control: ControlFn;
  /** The admin channel, for the doctor refresh once signed in; `null`: none. */
  ops: PeerOps | null;
  onClose: () => void;
}) {
  const acct = peerAccount(machine);
  // A sign-in already waiting (another tab started it) is shown, not replaced.
  const [start, setStart] = useState<Start>(() =>
    signin?.state === "waiting" ? { k: "started", r: {} } : { k: "starting" },
  );
  const started = useRef(start.k === "started");
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening the sheet starts it, once
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void control(
      "claude_signin",
      { acct },
      `volley claude signin ${acct}`,
      ADD_ACCOUNT_TIMEOUT_MS,
    ).then((r) => {
      if (!r.ok) {
        setStart({ k: "refused", error: r.error ?? "volleyd did not start the sign-in" });
        return;
      }
      setStart({ k: "started", r: startedFields(r.result) });
    });
  }, []);

  // The store's entry when the sheet opened (unless still waiting) is an earlier sign-in's end.
  const earlier = useRef(signin?.state === "waiting" ? undefined : signin);
  const live = start.k === "started" && signin !== earlier.current ? signin : undefined;
  const r = start.k === "started" ? start.r : {};
  const url = live?.url ?? r.url;
  const attach = live?.attach ?? r.attach;
  const manualUrl = live?.manual_url ?? r.manual_url;
  const callbackUrl = live ? live.callback_url : r.callback_url;
  const done = live?.state === "done";
  const failed =
    start.k === "refused" ? start.error : live?.state === "failed" ? live.reason : null;

  // Signed in: the machine's doctor runs at once, so its `claude` row flips now.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!done || refreshed.current || !ops) return;
    refreshed.current = true;
    void ops.doctor(machine, { fix: false });
  }, [done, ops, machine]);

  return (
    <MachineSheet label={`Sign in on ${machine}`} onClose={onClose}>
      {failed !== null && failed !== undefined ? (
        <p className="s-error" role="alert">
          The sign-in did not finish: {failed}
        </p>
      ) : done ? (
        <p className="m-ready m-ready--ok">
          Signed in{live?.plan ? ` · ${planLabel(live.plan)}` : ""}
        </p>
      ) : !url ? (
        <p className="dim">
          <span className="spinner" aria-hidden="true" /> Starting the sign-in on {machine}…
        </p>
      ) : (
        <SigninLink
          acct={acct}
          machine={machine}
          url={url}
          attach={attach}
          manualUrl={manualUrl}
          callbackUrl={callbackUrl}
          control={control}
        />
      )}
      <div className="ny-actions">
        <button type="button" className={done ? "btn btn--hot" : "btn"} onClick={onClose}>
          {done ? "Done" : "Close"}
        </button>
      </div>
    </MachineSheet>
  );
}

/** What became of the code or address the owner submitted. */
type Entry =
  | { k: "idle" }
  | { k: "sending" }
  | { k: "signed_in"; email?: string }
  | { k: "refused"; error: string };

/**
 * A sign-in once volleyd has its URL, from whatever device the owner is on:
 * **Open Anthropic sign-in ↗** (the code-page link, which works anywhere) with
 * its QR code for a phone, and one box for the code that page shows or the
 * address a browser ended up on. Submit sends `claude_signin_entry` and empties
 * the box; volleyd types the code into the sign-in waiting on that machine (or
 * completes the address there) and answers when it is done. A refusal shows
 * volleyd's words (never what was pasted) and **Get a fresh link**. **Open here
 * instead** is the callback shortcut, only while volleyd has one; the terminal
 * command sits under **Terminal instead**. Shared by this sheet and Add Claude
 * account (Accounts, and Machines' Sign in on), so every sign-in reads the same.
 */
export function SigninLink({
  acct,
  machine,
  url,
  attach,
  manualUrl,
  callbackUrl,
  control,
  lead = `Sign in with the Claude account ${machine}’s agents should use, on Anthropic’s own page.`,
}: {
  /** volleyd's account id of the sign-in (`primary@<name>`, `<acct>@<name>`, `<acct>`). */
  acct: string;
  machine: string;
  url: string;
  /** The first sentence: what the sign-in is for (the machine's default login by default). */
  lead?: string;
  attach?: string | undefined;
  manualUrl?: string | undefined;
  callbackUrl?: string | undefined;
  control: ControlFn;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [entry, setEntry] = useState<Entry>({ k: "idle" });
  /** A fresh link volleyd answered with, until the store's event catches up. */
  const [fresh, setFresh] = useState<Started | null>(null);
  const link = fresh?.manual_url ?? fresh?.url ?? manualUrl ?? url;
  const shortcut = fresh ? fresh.callback_url : callbackUrl;
  // A newer link from volleyd (its event) replaces the one Get a fresh link answered with.
  const propLink = manualUrl ?? url;
  const seen = useRef(propLink);
  useEffect(() => {
    if (seen.current === propLink) return;
    seen.current = propLink;
    setFresh(null);
  }, [propLink]);

  const submit = async () => {
    const pasted = text.trim();
    if (!pasted || entry.k === "sending") return;
    // The box never keeps what was pasted, whatever volleyd answers.
    setText("");
    setEntry({ k: "sending" });
    const r = await control(
      "claude_signin_entry",
      { acct, entry: pasted },
      `volley claude code ${acct}`,
      ENTRY_TIMEOUT_MS,
    );
    if (r.ok) {
      const email = (r.result as { email?: unknown } | undefined)?.email;
      setEntry({ k: "signed_in", ...(typeof email === "string" ? { email } : {}) });
    } else setEntry({ k: "refused", error: r.error ?? "volleyd did not take it" });
  };
  const again = async () => {
    setEntry({ k: "sending" });
    const r = await control(
      "claude_signin",
      { acct },
      `volley claude signin ${acct}`,
      ADD_ACCOUNT_TIMEOUT_MS,
    );
    if (!r.ok) {
      setEntry({ k: "refused", error: r.error ?? "volleyd did not start the sign-in" });
      return;
    }
    setFresh(startedFields(r.result));
    setEntry({ k: "idle" });
  };

  return (
    <>
      <p className="dim">
        {lead} Open it on any device, this one or your phone; the page then shows a code to paste
        below.
      </p>
      <div className="signin-entry-link">
        <a className="btn btn--blue" href={link} target="_blank" rel="noreferrer">
          Open Anthropic sign-in ↗
        </a>
        <LinkQr text={link} />
      </div>
      {entry.k === "signed_in" ? (
        <p className="m-ready m-ready--ok">
          Signed in{entry.email ? ` as ${maskEmail(entry.email)}` : ""}
        </p>
      ) : (
        <form
          className="signin-entry"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={id}>Paste the code, or the address your browser ended up on</label>
          <div className="signin-entry-row">
            <input
              id={id}
              className="recessed"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn--blue"
              disabled={!text.trim() || entry.k === "sending"}
            >
              Submit
            </button>
          </div>
        </form>
      )}
      {entry.k === "sending" && (
        <p className="dim">
          <span className="spinner" aria-hidden="true" /> Checking with {machine}…
        </p>
      )}
      {entry.k === "refused" && (
        <div className="signin-entry-refused" role="alert">
          <p className="s-error">{entry.error}</p>
          <button type="button" className="btn" onClick={() => void again()}>
            Get a fresh link
          </button>
        </div>
      )}
      {shortcut && entry.k !== "signed_in" && (
        <p className="s-hint">
          <a href={shortcut} target="_blank" rel="noreferrer">
            Open here instead (browser on the supervisor’s machine)
          </a>
        </p>
      )}
      {attach && entry.k !== "signed_in" && <TerminalInstead machine={machine} attach={attach} />}
      {entry.k !== "signed_in" && (
        <div className="waiting">
          <span className="spinner" aria-hidden="true" /> Waiting for the sign-in to finish…
        </div>
      )}
    </>
  );
}

/** volleyd answers a pasted code once the sign-in ends: its 30 s wait, a restart, and margin. */
const ENTRY_TIMEOUT_MS = 90_000;

/** The link as a QR code for a phone; nothing when it is too long to encode. */
function LinkQr({ text }: { text: string }) {
  // `<Qr>` encodes during its own render, out of reach of a try here: check first.
  const fits = useMemo(() => {
    try {
      encodeQr(text);
      return true;
    } catch {
      return false;
    }
  }, [text]);
  return fits ? <Qr text={text} size={132} label="QR code of the sign-in link" /> : null;
}

/** The sign-in terminal on the machine, for a person who would rather type the code there. */
function TerminalInstead({ machine, attach }: { machine: string; attach: string }) {
  return (
    <details className="m-phone">
      <summary>Terminal instead</summary>
      <ol className="m-steps">
        <li>
          On any terminal that reaches {machine}, run this to attach to its sign-in:
          <CopyCommand text={attach} ready />
        </li>
        <li>Paste the code the page shows there, at the prompt.</li>
      </ol>
    </details>
  );
}

/**
 * The card's slot: **Sign in on <machine>** (and its sheet), or, once
 * volleyd says the sign-in is done, the green line with the plan. Nothing
 * when the machine's doctor already reports Claude signed in.
 */
export function PeerSignin({
  machine,
  signin,
  signedIn = false,
  control,
  ops,
}: {
  machine: string;
  signin: ClaudeSignin | undefined;
  /** The machine's record says `auth.claude: signed_in`. */
  signedIn?: boolean;
  control: ControlFn;
  ops: PeerOps | null;
}) {
  const [open, setOpen] = useState(false);
  const done = signin?.state === "done";
  return (
    <>
      {done && !open ? (
        <p className="m-ready m-ready--ok">
          Claude signed in{signin.plan ? ` · ${planLabel(signin.plan)}` : ""}
        </p>
      ) : (
        !signedIn && (
          <div className="m-actions">
            <button type="button" className="btn btn--blue" onClick={() => setOpen(true)}>
              Sign in on {machine}
            </button>
          </div>
        )
      )}
      {open && (
        <PeerSigninSheet
          machine={machine}
          signin={signin}
          control={control}
          ops={ops}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
