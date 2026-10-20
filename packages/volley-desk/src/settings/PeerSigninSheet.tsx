/**
 * Signing a paired machine in to Claude from the Desk (SPEC §4.6.11): **Sign
 * in on <machine>** on its card (and in Add a machine's step 4) opens this
 * sheet, which sends `claude_signin { acct: "primary@<name>" }`. volleyd
 * starts Claude Code's own `claude auth login` on that machine and forwards
 * its localhost callback to this computer for the length of the sign-in, so
 * **Open sign-in** works from a browser here. From a phone, the disclosure
 * gives the printed (manual-code) URL to open there and the command that
 * reaches the sign-in terminal on the machine, where the code is typed: never
 * into Volley, which has no field for one anywhere in this sheet. Done shows
 * the plan, refreshes the machine's doctor rows (`peer_doctor { fix: false }`)
 * and turns the card's line green.
 */
import { useEffect, useRef, useState } from "react";
import type { PeerOps } from "../store/peerOps";
import type { ClaudeSignin } from "../store/types";
import { ADD_ACCOUNT_TIMEOUT_MS, type ControlFn } from "./ClaudeAccounts";
import { CopyCommand } from "./MachineRows";
import { MachineSheet } from "./MachineSheet";

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
      const res = (r.result ?? {}) as Record<string, unknown>;
      const pick = (k: keyof Started) =>
        typeof res[k] === "string" ? { [k]: res[k] as string } : {};
      setStart({
        k: "started",
        r: { ...pick("url"), ...pick("flow"), ...pick("attach"), ...pick("manual_url") },
      });
    });
  }, []);

  // The store's entry when the sheet opened (unless still waiting) is an earlier sign-in's end.
  const earlier = useRef(signin?.state === "waiting" ? undefined : signin);
  const live = start.k === "started" && signin !== earlier.current ? signin : undefined;
  const r = start.k === "started" ? start.r : {};
  const url = live?.url ?? r.url;
  const flow = live?.flow ?? r.flow;
  const attach = live?.attach ?? r.attach;
  const manualUrl = live?.manual_url ?? r.manual_url;
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
        <>
          <p className="dim">
            Sign in with the Claude account {machine}’s agents should use, on Anthropic’s own page.
            {flow === "browser_callback"
              ? ` It hands the sign-in straight back to Claude Code on ${machine} through this computer, so open it in a browser on this computer.`
              : " The page then shows a code: type it into the sign-in terminal below."}
          </p>
          <div className="ny-actions">
            <a className="btn btn--blue" href={url} target="_blank" rel="noreferrer">
              Open sign-in ↗
            </a>
          </div>
          {(flow !== "browser_callback" || manualUrl) && attach && (
            <PhoneSteps
              machine={machine}
              manualUrl={flow === "browser_callback" ? manualUrl : undefined}
              attach={attach}
              open={flow !== "browser_callback"}
            />
          )}
          <div className="waiting">
            <span className="spinner" aria-hidden="true" /> Waiting for the sign-in to finish…
          </div>
        </>
      )}
      <div className="ny-actions">
        <button type="button" className={done ? "btn btn--hot" : "btn"} onClick={onClose}>
          {done ? "Done" : "Close"}
        </button>
      </div>
    </MachineSheet>
  );
}

/**
 * From a phone (or any device that cannot open the forwarded URL): the
 * printed URL opened there, and the code typed into the machine's sign-in
 * terminal. Open at once for a sign-in that has no forwarded URL.
 */
function PhoneSteps({
  machine,
  manualUrl,
  attach,
  open,
}: {
  machine: string;
  manualUrl: string | undefined;
  attach: string;
  open: boolean;
}) {
  return (
    <details className="m-phone" open={open}>
      <summary>{open ? "Type the code on the machine" : "From a phone instead"}</summary>
      <ol className="m-steps">
        {manualUrl && (
          <li>
            <a href={manualUrl} target="_blank" rel="noreferrer">
              Open on the phone ↗
            </a>{" "}
            and sign in there.
          </li>
        )}
        <li>
          On any terminal that reaches {machine}, run this to attach to its sign-in:
          <CopyCommand text={attach} ready />
        </li>
        <li>
          Type the code the page shows <b>into that terminal, never into Volley</b>.
        </li>
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
