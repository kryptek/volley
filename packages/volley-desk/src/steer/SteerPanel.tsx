/**
 * The steering panel (D4), ported from the prototype `SteerPanel`: quick-action
 * pills, the React Bits `PromptBar` with the four commands (`/stop`
 * `/wrap-up` `/pause` `/status`) and a Mailbox vs Urgent "model" selector,
 * and the three delivery steps of the last message (`ackState.ts`).
 *
 * Without broker credentials (`onSend: null`) the panel is read-only: pills
 * fill a text field and the panel offers to copy the equivalent
 * `volleyd steer <wave> <task> "…"` line instead of publishing.
 *
 * `ClaimButton` is the no-coordinator banner's claim, sent as a `volleyd
 * claim` daemon control request (it renders only when the Desk can write).
 */
import { Cancel01Icon, Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { PrimaryAction } from "../look/PrimaryAction";
import PromptBar from "../rb/PromptBar/PromptBar";
import "../styles/steer.css";
import { type AckState, ackLabels, ackStep } from "./ackState";
import { STEER_COMMANDS, type SteerTransport, copySteerCommand } from "./transport";

const AGENT_QUICK = [
  "Post a progress update now",
  "Wrap up and publish done",
  "Stop and publish blocked",
  "Keep the rename out of this PR",
];
const COORDINATOR_QUICK = [
  "Merge T2 now",
  "Hold T2 for T3",
  "Pause this wave",
  "Give me a status summary",
];
const MODELS = [
  { key: "mailbox", name: "Mailbox", tag: "next tool call" },
  { key: "urgent", name: "Urgent", tag: "interrupts" },
];

export interface SteerPanelProps {
  /** Display name: `T2 · implementer`, or the wave id for its coordinator. */
  target: string;
  coordinator: boolean;
  /** Publish `text` (urgent: also interrupt); `null` without broker credentials (read-only). */
  onSend: ((text: string, urgent: boolean) => void) | null;
  /** The last message sent from this panel and its delivery state. */
  last?:
    | {
        text: string;
        state: AckState;
        error?: string | undefined;
        /** Sent urgent: the daemon was asked to interrupt first. */
        urgent?: boolean | undefined;
        /** The interrupt's outcome, once known. */
        interrupt?: { interrupted: boolean; reason?: string | undefined } | undefined;
      }
    | null
    | undefined;
  /** Where the read-only copy command steers; none for coordinators or agents without a task. */
  copy?: { wave: string; task: string; role?: string | undefined } | null | undefined;
  /** Read-only for another reason than missing credentials (nobody to message). */
  readOnlyReason?: string | undefined;
  onClose: () => void;
}

const Icon = ({ i, s = 15 }: { i: typeof Cancel01Icon; s?: number }) => (
  <HugeiconsIcon icon={i} size={s} strokeWidth={1.8} />
);

export function SteerPanel({
  target,
  coordinator,
  onSend,
  last,
  copy,
  readOnlyReason,
  onClose,
}: SteerPanelProps) {
  const quick = coordinator ? COORDINATOR_QUICK : AGENT_QUICK;
  const [draft, setDraft] = useState("");
  return (
    // biome-ignore lint/a11y/useSemanticElements: an inline panel inside the window (as in the prototype), not a modal <dialog>
    <div className="steer" role="dialog" aria-label={`Message ${target}`}>
      <div className="steer-head">
        <span>{coordinator ? `Message the coordinator of ${target}` : `Steer ${target}`}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon i={Cancel01Icon} />
        </button>
      </div>
      <div className="steer-quick">
        {quick.map((q) => (
          <button
            type="button"
            key={q}
            className="pill"
            onClick={() => (onSend ? onSend(q, false) : setDraft(q))}
          >
            {q}
          </button>
        ))}
      </div>
      {onSend ? (
        <div className="steer-input recessed">
          <PromptBar
            placeholder={
              coordinator
                ? "Answer or instruct the coordinator…"
                : "Type a steering message…  ( / for commands )"
            }
            sources={[]}
            commands={[...STEER_COMMANDS]}
            models={MODELS}
            defaultModel="mailbox"
            efforts={[]}
            background="rgba(10,12,20,.92)"
            color="#e8ecf4"
            menuBackground="#12141f"
            sparkColor="#6ee7f9"
            onSend={(t, detail) => {
              if (t.trim()) onSend(t.trim(), detail.model?.key === "urgent");
            }}
          />
        </div>
      ) : (
        <ReadOnly draft={draft} setDraft={setDraft} copy={copy ?? null} reason={readOnlyReason} />
      )}
      {last && <Delivery last={last} coordinator={coordinator} />}
    </div>
  );
}

function Delivery({
  last,
  coordinator,
}: {
  last: NonNullable<SteerPanelProps["last"]>;
  coordinator: boolean;
}) {
  const lit = ackStep(last.state);
  return (
    <>
      <ol className="ack" aria-label="Delivery">
        {ackLabels(coordinator).map((label, i) => (
          <li
            key={label}
            className={i < lit ? "on" : i === 0 && last.state === "sending" ? "pending" : ""}
          >
            {label}
          </li>
        ))}
        <span className="ack-txt">“{last.text}”</span>
      </ol>
      {last.state === "failed" && (
        <div className="ack-err" role="alert">
          Not sent: {last.error ?? "the broker refused the message"}
        </div>
      )}
      {last.urgent && last.state !== "failed" && (
        <div className="ack-note">{interruptNote(last.interrupt)}</div>
      )}
    </>
  );
}

function interruptNote(i: NonNullable<SteerPanelProps["last"]>["interrupt"]): string {
  if (!i) return "Interrupting (Escape)…";
  if (i.interrupted) return "Interrupted (Escape), then delivered";
  return `Delivered (not interrupted${i.reason ? `: ${i.reason}` : ""})`;
}

type CopyState = "idle" | "copied" | "failed";

function ReadOnly({
  draft,
  setDraft,
  copy,
  reason,
}: {
  draft: string;
  setDraft: (s: string) => void;
  copy: { wave: string; task: string; role?: string | undefined } | null;
  reason: string | undefined;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const cmd = copy ? copySteerCommand(copy.wave, copy.task, draft.trim() || "…", copy.role) : null;
  const doCopy = async () => {
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="steer-ro">
      <p className="steer-ro-note">
        {reason ?? (
          <>
            Read-only: this Desk is not signed in to the broker (anonymous, or its credentials have
            not connected). Sign in with broker credentials to steer from here
            {cmd ? ", or copy the command and run it in a terminal." : "."}
          </>
        )}
      </p>
      {copy && (
        <>
          <input
            className="steer-ro-input recessed"
            aria-label="Steering text"
            placeholder="Type a steering message…"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setState("idle");
            }}
          />
          <div className="steer-ro-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void doCopy()}
              disabled={draft.trim() === ""}
            >
              <span className="mono">{`Copy "volleyd steer ${copy.wave} ${copy.task} \\"…\\"${copy.role ? ` --role ${copy.role}` : ""}"`}</span>
              <Icon i={Copy01Icon} s={12} />
            </button>
            {state === "copied" && <span className="steer-ro-copied">Copied</span>}
          </div>
          {state === "failed" && cmd && (
            <output className="steer-ro-fallback">
              Copy failed: select the command <code className="mono">{cmd}</code>
            </output>
          )}
        </>
      )}
    </div>
  );
}

type ClaimState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done"; text: string; ok: boolean };

/** "Claim this wave": a `volleyd claim <wave>` control request; nothing without a writer. */
export function ClaimButton({
  wave,
  transport,
}: { wave: string; transport: SteerTransport | null }) {
  const [state, setState] = useState<ClaimState>({ kind: "idle" });
  if (!transport) return null;
  const claim = async () => {
    setState({ kind: "sending" });
    const r = await transport.control("claim", { wave }, `volleyd claim ${wave}`);
    const owner = (r.result as { owner?: unknown } | undefined)?.owner;
    setState(
      r.ok
        ? {
            kind: "done",
            ok: true,
            text: `Claimed: ${typeof owner === "string" ? owner : transport.identity} now owns ${wave}`,
          }
        : {
            kind: "done",
            ok: false,
            text: `${r.unsent ? "Claim not sent" : "Claim refused"}: ${r.error ?? "no reason given"}`,
          },
    );
  };
  return (
    <>
      <PrimaryAction hot disabled={state.kind === "sending"} onClick={() => void claim()}>
        Claim this wave
      </PrimaryAction>
      {state.kind === "sending" && <span className="steer-ro-copied">Claiming…</span>}
      {state.kind === "done" &&
        (state.ok ? (
          <span className="steer-ro-copied">{state.text}</span>
        ) : (
          <span className="ack-err" role="alert">
            {state.text}
          </span>
        ))}
    </>
  );
}
