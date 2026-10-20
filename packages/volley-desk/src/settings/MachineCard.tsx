/**
 * One paired machine's card in Settings › Machines (SPEC §4.6.14): its name,
 * os and cores, the tunnel with its heartbeat dot, load, agents and when it
 * was last heard from, and, for an admin, **Remove…** behind a confirm.
 * `CopyCommand` is the copyable terminal line the Stepper and the card share.
 */
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useEffect, useState } from "react";
import { plural } from "../lib/plural";
import type { PeerOps } from "../store/peerOps";
import type { MachinePayload } from "../store/types";

const COPIED_MS = 2000;

/** `20s`, `5m`, `3h`, `2d`: how long ago `iso` was. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "a while";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

const DOWN_REASON: Record<string, string> = {
  heartbeat_timeout: "no heartbeat",
  disconnect: "disconnected",
};

/** One load average as the record has it, at most two decimals. */
const load = (n: number | undefined) => (n === undefined ? "—" : String(Number(n.toFixed(2))));

type Removing = { phase: "confirm" } | { phase: "busy" } | { phase: "failed"; error: string };

export function MachineCard({
  m,
  now,
  admin,
  onRemoved,
  ops,
}: {
  m: MachinePayload;
  now: number;
  admin: boolean;
  onRemoved: (name: string) => void;
  ops: PeerOps | null;
}) {
  const [removing, setRemoving] = useState<Removing | null>(null);
  const down = m.tunnel === "down";
  const remove = async () => {
    if (!ops) return;
    setRemoving({ phase: "busy" });
    const r = await ops.remove(m.name);
    if (r.ok) {
      setRemoving(null);
      onRemoved(m.name);
    } else {
      setRemoving({ phase: "failed", error: r.error ?? "volleyd refused" });
    }
  };
  return (
    <article className="machine" aria-label={m.name}>
      <div className="m-head">
        <b>{m.name}</b>
      </div>
      <div className="dim">
        {m.os}
        {m.arch ? ` ${m.arch}` : ""} · {plural(m.cores, "core")}
      </div>
      <div className="m-stats">
        <span className={`hb${down ? " hb--stale" : ""}`}>
          <i />
          tunnel {m.tunnel}
        </span>
        <span className="mono">load {load(m.load[0])}</span>
        <span>{plural(m.agents, "agent")}</span>
      </div>
      <div className="s-hint">
        {down
          ? `${DOWN_REASON[m.reason ?? ""] ?? "tunnel down"} · last seen ${ago(m.last_seen, now)} ago`
          : `seen ${ago(m.last_seen, now)} ago`}
      </div>
      {down && (
        <p className="s-hint m-note">
          New agents for it wait until it is back; the ones already running keep going.
        </p>
      )}
      {admin && removing === null && (
        <button
          type="button"
          className="btn m-remove"
          onClick={() => setRemoving({ phase: "confirm" })}
        >
          Remove…
        </button>
      )}
      {admin && removing !== null && (
        <div className="m-confirm">
          <p className="s-hint">
            Remove {m.name}? This revokes its broker account, takes it out of volleyd’s hosts and
            clears its record. Its tunnel stops at its next check; pairing it again takes a new
            code.
          </p>
          {removing.phase === "failed" && (
            <p className="s-error" role="alert">
              {removing.error}
            </p>
          )}
          <div className="ny-actions">
            <button
              type="button"
              className="btn btn--danger"
              disabled={removing.phase === "busy"}
              onClick={() => void remove()}
            >
              {removing.phase === "busy" ? "Removing…" : `Remove ${m.name}`}
            </button>
            <button
              type="button"
              className="btn"
              disabled={removing.phase === "busy"}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export function CopyCommand({ text, ready }: { text: string; ready: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), COPIED_MS);
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
    <div className="m-command recessed">
      <code className="mono">
        {text.split(" ").map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the words of one fixed command
          <Fragment key={i}>
            {i > 0 && " "}
            {w.startsWith("-") ? <span className="m-flag">{w}</span> : w}
          </Fragment>
        ))}
      </code>
      <button type="button" className="btn" disabled={!ready} onClick={() => void copy()}>
        <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.8} />
        {state === "copied" ? "Copied" : state === "failed" ? "Select it to copy" : "Copy"}
      </button>
    </div>
  );
}
