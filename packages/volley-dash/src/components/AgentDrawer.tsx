/**
 * AgentDrawer — per-agent detail sheet, anchored to the right side. Phase 2
 * mounts/unmounts the panel synchronously (no slide animation — that lands
 * in Phase 3). Built on raw HTML rather than shadcn's Dialog because the
 * design calls for a right-anchored sheet inside the dashboard grid (top: 48px,
 * right: 0, bottom: 0), and Dialog's centred-modal defaults fight that.
 *
 * Six body sections per handoff §"Screen 3 — Per-agent detail drawer":
 *   1. identity        — definition list (110/1fr) over topic/ns/parent/spawn/seen/caps
 *   2. retained status envelope — OKLCH-coloured JSON via `highlightJson`
 *   3. recent progress · N      — last 8 progress events for this agent
 *   4. mailbox · N              — same shape, type tag in `--st-blocked` amber
 *   5. result                   — done-coloured code block when result events present
 *   6. subscriptions            — the 4 standard MQTT subscriptions, fg-3 grey
 *
 * Dismissal: Esc (handled by Dashboard), scrim click, × button — all funnel
 * through the `onClose` callback.
 */
import { X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { highlightJson } from "../lib/highlight-json";
import { STATUS_META } from "../lib/lifecycle-meta";
import { relTime } from "../lib/rel-time";
import type { Agent, FeedEvent } from "../types";

export interface AgentDrawerProps {
  agent?: Agent | null | undefined;
  events?: FeedEvent[] | undefined;
  now?: number | undefined;
  onClose?: (() => void) | undefined;
}

const PLACEHOLDER_AGENT: Agent = {
  id: "—",
  ns: "default",
  status: "registered",
  parent: null,
  caps: [],
  msg: "",
  pct: null,
  spawnedAt: 0,
  lastSeen: 0,
};

export function AgentDrawer({
  agent,
  events = [],
  now = Date.now(),
  onClose = () => {},
}: AgentDrawerProps = {}): JSX.Element {
  const a = agent ?? PLACEHOLDER_AGENT;
  const isPlaceholder = !agent;
  const meta = STATUS_META[a.status];
  const cssVars = { "--c-st": meta.color } as React.CSSProperties;
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `drawer-title-${a.id}`;

  // Move focus into the drawer on mount and restore to the previously focused
  // element on unmount. Keyboard-only users get a proper dialog experience.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      prev?.focus?.();
    };
  }, []);

  const agentEvents = useMemo(() => events.filter((e) => e.agent === a.id), [events, a.id]);
  const progressEvents = useMemo(
    () => agentEvents.filter((e) => e.ch === "progress").slice(0, 8),
    [agentEvents],
  );
  const mailEvents = useMemo(
    () => agentEvents.filter((e) => e.ch === "mailbox").slice(0, 8),
    [agentEvents],
  );
  const resultEvents = useMemo(
    () => agentEvents.filter((e) => e.ch === "result").slice(0, 3),
    [agentEvents],
  );

  const envelope = {
    state: a.status,
    ts: a.lastSeen > 0 ? new Date(a.lastSeen).toISOString() : null,
    msg: a.msg,
    progress: a.pct,
    parent: a.parent,
    capabilities: a.caps,
  };

  const subscriptions =
    `SUB  volley/${a.ns}/${a.id}/status     QoS=1  retain\n` +
    `SUB  volley/${a.ns}/${a.id}/progress   QoS=0\n` +
    `SUB  volley/${a.ns}/${a.id}/mailbox    QoS=1\n` +
    `SUB  volley/${a.ns}/${a.id}/result     QoS=1  retain`;

  return (
    <>
      <button
        type="button"
        className="vd-drawer-scrim"
        onClick={onClose}
        aria-label="Close agent drawer"
        tabIndex={-1}
      />
      <aside
        data-testid="agent-drawer"
        className="vd-drawer"
        style={cssVars}
        // biome-ignore lint/a11y/useSemanticElements: native <dialog> imposes modal/positioning behaviour that conflicts with the right-anchored sheet layout (top:48px, right:0) used here.
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="vd-drawer-hd">
          <span data-testid="status-dot" data-status={a.status} className="vd-status-dot" />
          <span id={titleId} className="vd-aid">
            {a.id}
          </span>
          <span className="vd-status-label">{meta.label}</span>
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="drawer-close"
            className="vd-close"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="vd-icon" />
          </button>
        </div>

        <div className="vd-drawer-body">
          <section data-testid="drawer-section-identity" className="vd-dr-section">
            <h4>identity</h4>
            <dl className="vd-kv">
              <dt>topic</dt>
              <dd>
                <span className="vd-v">
                  volley/{a.ns}/{a.id}/+
                </span>
              </dd>
              <dt>namespace</dt>
              <dd>
                <span className="vd-v">{a.ns}</span>
              </dd>
              <dt>parent</dt>
              <dd>
                {a.parent !== null ? (
                  a.parent
                ) : (
                  <span style={{ color: "var(--fg-4)" }}>none (root)</span>
                )}
              </dd>
              <dt>spawned</dt>
              <dd>{a.spawnedAt > 0 ? relTime(a.spawnedAt, now) : "—"}</dd>
              <dt>last seen</dt>
              <dd>{a.lastSeen > 0 ? relTime(a.lastSeen, now) : "—"}</dd>
              <dt>capabilities</dt>
              <dd>
                {a.caps.length > 0 ? (
                  <div className="vd-tags" style={{ marginTop: 2 }}>
                    {a.caps.map((c) => (
                      <span key={c} className="vd-tag">
                        {c}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: "var(--fg-4)" }}>none</span>
                )}
              </dd>
            </dl>
          </section>

          {!isPlaceholder && (
            <section data-testid="drawer-section-envelope" className="vd-dr-section">
              <h4>retained status envelope</h4>
              <pre className="vd-envelope">{highlightJson(envelope)}</pre>
            </section>
          )}

          {!isPlaceholder && progressEvents.length > 0 && (
            <section data-testid="drawer-section-progress" className="vd-dr-section">
              <h4>recent progress · {progressEvents.length}</h4>
              <div className="vd-progress-list">
                {progressEvents.map((e) => (
                  <div key={e.id} className="vd-progress-line">
                    <span className="vd-t">{relTime(e.ts, now)}</span>
                    <span className="vd-m">{e.msg}</span>
                    <span className="vd-type">{e.type}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!isPlaceholder && mailEvents.length > 0 && (
            <section data-testid="drawer-section-mailbox" className="vd-dr-section">
              <h4>mailbox · {mailEvents.length}</h4>
              <div className="vd-progress-list">
                {mailEvents.map((e) => (
                  <div key={e.id} className="vd-progress-line">
                    <span className="vd-t">{relTime(e.ts, now)}</span>
                    <span className="vd-m">{e.msg}</span>
                    <span className="vd-type" style={{ color: "var(--st-blocked)" }}>
                      {e.type}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {!isPlaceholder && resultEvents.length > 0 && (
            <section data-testid="drawer-section-result" className="vd-dr-section">
              <h4>result</h4>
              <pre className="vd-envelope" style={{ color: "var(--st-done)" }}>
                {resultEvents.map((e) => e.msg).join("\n")}
              </pre>
            </section>
          )}

          {!isPlaceholder && (
            <section data-testid="drawer-section-subscriptions" className="vd-dr-section">
              <h4>subscriptions</h4>
              <pre className="vd-envelope" style={{ color: "var(--fg-3)" }}>
                {subscriptions}
              </pre>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
