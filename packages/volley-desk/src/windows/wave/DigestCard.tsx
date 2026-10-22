/**
 * The morning digest card (SPEC §4.6.16): volleyd's retained `volley/_waves/<wave>/digest`, in
 * the wave window's header area while the wave has ended or one of the decisions it lists as
 * waiting is still open. One headline (volleyd's summary line), then the three sections: what
 * shipped (PR links), what autopilot handled on its own, and what is waiting for the owner
 * (each decision id opens it), then the held decisions and the failures when there are any.
 */
import { plural } from "../../lib/plural";
import type { DigestPayload, WaveView } from "../../store/types";

const ENDED = new Set(["stopped", "complete"]);

/** The card shows for an ended wave, or while a decision the digest lists as waiting is open. */
export function showDigest(wave: WaveView, digest: DigestPayload | undefined): boolean {
  const s = wave.state;
  if (digest === undefined || s === null) return false;
  if (ENDED.has(s.status)) return true;
  return digest.waiting.some((w) => s.open_decisions.includes(w.id));
}

const VERB: Record<DigestPayload["trigger"], string> = {
  wave_complete: "complete",
  release_go: "ready to release",
  escalation: "needs you",
  stopped: "stopped",
};

/** volleyd's `summaryLine` (packages/volleyd/src/autopilot/digest.ts), for the card's headline. */
export function digestHeadline(d: DigestPayload): string {
  const a = d.auto;
  const parts = [`${d.shipped.length} shipped`];
  if (a.flakes_fixed.length > 0) parts.push(`${plural(a.flakes_fixed.length, "flake")} fixed`);
  if (a.conflicts_resolved > 0) parts.push(`${plural(a.conflicts_resolved, "conflict")} resolved`);
  if (a.retries > 0) parts.push(plural(a.retries, "retry", "retries"));
  if (a.decisions_resolved > 0) parts.push(`${plural(a.decisions_resolved, "decision")} answered`);
  if (d.failures.length > 0) parts.push(`${d.failures.length} failed`);
  if (d.waiting.length > 0) {
    const kinds = [...new Set(d.waiting.map((w) => w.kind))].join(", ");
    parts.push(`${d.waiting.length} waiting for you (${kinds})`);
  }
  const held = d.held ?? [];
  if (held.length > 0) parts.push(`${held.length} held`);
  return `${d.wave} ${VERB[d.trigger]}: ${parts.join(", ")}`;
}

export interface DigestCardProps {
  digest: DigestPayload;
  /** Opens a waiting decision where it is answered (the Needs-you surface). */
  onOpenDecision?: ((id: string) => void) | undefined;
}

export function DigestCard({ digest: d, onOpenDecision }: DigestCardProps) {
  const a = d.auto;
  const held = d.held ?? [];
  return (
    <section className="digest-card" aria-label="Morning digest">
      <p className="digest-head">{digestHeadline(d)}</p>
      <h3>Shipped</h3>
      {d.shipped.length === 0 ? (
        <p className="dim">Nothing shipped.</p>
      ) : (
        <ul>
          {d.shipped.map((s) => (
            <li key={s.task}>
              <span className="mono">{s.task}</span>
              {s.title !== undefined && <> {s.title}</>}{" "}
              <a href={s.pr.url} target="_blank" rel="noreferrer">
                PR #{s.pr.number}
              </a>{" "}
              <span className="dim">merged by {s.merged_by}</span>
            </li>
          ))}
        </ul>
      )}
      <h3>Autopilot handled</h3>
      <ul>
        <li>{plural(a.decisions_resolved, "decision")} answered</li>
        <li>{plural(a.merges, "PR")} merged</li>
        <li>{plural(a.conflicts_resolved, "conflict")} resolved</li>
        <li>{plural(a.retries, "retry", "retries")}</li>
        <li>
          {plural(a.flakes_fixed.length, "flake")} fixed
          {a.flakes_fixed.map((f) => (
            <span key={f.test} className="dim">
              {" "}
              · {f.test} by <span className="mono">{f.fixer}</span>
            </span>
          ))}
        </li>
      </ul>
      <h3>Waiting for you</h3>
      {d.waiting.length === 0 ? (
        <p className="dim">Nothing is waiting for you.</p>
      ) : (
        <ul>
          {d.waiting.map((w) => (
            <li key={w.id}>
              {onOpenDecision ? (
                <button
                  type="button"
                  className="digest-id mono"
                  onClick={() => onOpenDecision(w.id)}
                >
                  {w.id}
                </button>
              ) : (
                <span className="mono">{w.id}</span>
              )}{" "}
              <span className="dim">
                {w.kind}
                {w.task !== undefined && ` on ${w.task}`}
                {w.owner_only && " · owner only"}
              </span>
              : {w.question}
            </li>
          ))}
        </ul>
      )}
      {held.length > 0 && (
        <>
          <h3>Held</h3>
          <ul>
            {held.map((h) => (
              <li key={h.id}>
                <span className="mono">{h.id}</span>{" "}
                <span className="dim">
                  {h.kind}
                  {h.task !== undefined && ` on ${h.task}`}
                </span>
                : waiting on {h.label} <span className="dim">since {h.held_since}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.failures.length > 0 && (
        <>
          <h3>Failed</h3>
          <ul>
            {d.failures.map((f) => (
              <li key={f.task}>
                <span className="mono">{f.task}</span>: {f.why}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
