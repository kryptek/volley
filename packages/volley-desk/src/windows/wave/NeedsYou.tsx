/**
 * The Needs-you banners in the wave window, ported from the prototype
 * `WaveWindow`: a coordinator awaiting input shows its question, `Open in
 * Claude` (the session URL from the coordinator hooks) and a button that copies
 * `cmux select-workspace --workspace <ref>`; a wave with no coordinator shows
 * how long it has been gone and the copyable `volleyd claim <wave>` command
 * (plus D4's claim button in the `claim` slot when the Desk can write). `AttentionLine` is the
 * agent window's `Needs you · …` / `Coordinator handling · …` line.
 */
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import type { Attn, EffectiveCoordinator } from "../../attention";
import "../../styles/attention.css";

const Icon = ({ i, s }: { i: typeof Alert02Icon; s: number }) => (
  <HugeiconsIcon icon={i} size={s} strokeWidth={1.8} />
);

/** The first `n` non-empty lines of a question (the hooks already send 1–2). */
export function firstLines(text: string, n = 2): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(0, n)
    .join("\n");
}

type CopyState = "idle" | "copied" | "failed";

/** How long "Copied" / "Copy failed" stays up (the prototype's toast is transient too). */
export const COPY_RESET_MS = 2000;

/** A button that copies `text`; when the clipboard refuses, it says so and the text stays selectable. */
function CopyButton({ text, label }: { text: string; label: ReactNode }) {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), COPY_RESET_MS);
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
    <>
      <button type="button" className="btn" onClick={() => void copy()} title={`Copy: ${text}`}>
        {label} <Icon i={Copy01Icon} s={12} />
        {state === "copied" && <span className="ny-copied">Copied</span>}
      </button>
      {state === "failed" && (
        <output className="ny-fallback">
          Copy failed: select the command <code className="mono">{text}</code>
        </output>
      )}
    </>
  );
}

export interface NeedsYouProps {
  wave: string;
  coordinator: EffectiveCoordinator;
  /** Unresolved decisions on the wave. */
  openDecisions: number;
  now: number;
  /** The no-coordinator banner's claim button (D4); absent when the Desk is read-only. */
  claim?: ReactNode;
}

export function NeedsYou({ wave, coordinator: c, openDecisions, now, claim }: NeedsYouProps) {
  if (c.state === "awaiting_input") {
    const q = firstLines(c.question ?? c.text ?? "");
    const cmd = c.workspace ? `cmux select-workspace --workspace ${c.workspace}` : null;
    return (
      // biome-ignore lint/a11y/useSemanticElements: a banner live region (as in the prototype), not a form <output>
      <div className="needs-you" role="status">
        <div className="ny-head">
          <Icon i={Alert02Icon} s={14} /> Needs you: the coordinator is waiting for your answer
        </div>
        {q && <p className="ny-q">“{q}”</p>}
        {(c.sessionUrl || cmd) && (
          <div className="ny-actions">
            {c.sessionUrl && (
              <a className="btn btn--hot" href={c.sessionUrl} target="_blank" rel="noreferrer">
                Open in Claude <Icon i={ArrowUpRight01Icon} s={13} />
              </a>
            )}
            {cmd && (
              <CopyButton
                text={cmd}
                label={
                  <>
                    <Icon i={TerminalIcon} s={13} /> Terminal: {c.workspace}
                  </>
                }
              />
            )}
          </div>
        )}
      </div>
    );
  }
  if (c.state === "gone") {
    const away =
      c.lastSeen === undefined
        ? ""
        : ` for ${Math.max(0, Math.round((now - c.lastSeen) / 60_000))} min`;
    const who = c.id ? `Coordinator ${c.id} is gone.` : "This wave has no owner.";
    const parked =
      openDecisions > 0
        ? ` ${openDecisions} decision${openDecisions === 1 ? " is" : "s are"} parked.`
        : "";
    const cmd = `volleyd claim ${wave}`;
    return (
      // biome-ignore lint/a11y/useSemanticElements: a banner live region (as in the prototype), not a form <output>
      <div className="needs-you" role="status">
        <div className="ny-head">
          <Icon i={Alert02Icon} s={14} /> Needs you: no coordinator{away}
        </div>
        <p className="ny-q">
          {who}
          {parked} Claim this wave from a Claude session to take it over.
        </p>
        <div className="ny-actions">
          {claim}
          <CopyButton
            text={cmd}
            label={
              <>
                <Icon i={TerminalIcon} s={13} /> <span className="mono">{cmd}</span>
              </>
            }
          />
        </div>
      </div>
    );
  }
  return null;
}

const TIER_LABEL = { you: "Needs you", coordinator: "Coordinator handling" } as const;

/** The agent window's attention line; nothing for `info` and `none`. */
export function AttentionLine({ attn }: { attn: Attn }) {
  if (attn.tier !== "you" && attn.tier !== "coordinator") return null;
  return (
    <div className={`attn-line attn-${attn.tier}`}>
      {TIER_LABEL[attn.tier]} · {attn.reason ?? ""}
    </div>
  );
}
