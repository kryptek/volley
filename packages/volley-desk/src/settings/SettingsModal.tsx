/**
 * The settings modal (port of the prototype `SettingsModal`), opened from a
 * wave window's gear glyph. Rows come from the config schema (`schemaRows`):
 * "Global" shows the retained `_config`, "This wave" the wave's
 * `effective_config`. A change sends one config_set (`configTransport`) and
 * the row shows the ack: applied with the new version, or the rejected paths
 * with their reasons. A slider sends once the user lets go: key presses and
 * drags within `SLIDER_COMMIT_MS` of each other coalesce into one config_set
 * carrying the settled value.
 *
 * Writes need broker credentials: without a transport the modal sends nothing;
 * a global row still takes a new value as a draft and offers the exact
 * `volleyd config set` line that sets it to copy (nothing to copy until the
 * value differs from the current one). The wave
 * scope is read-only too — volleyd applies config_set to the global config,
 * and per-wave values come from the wave file's `config:` block.
 */
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../a11y/keys";
import { PrimaryAction } from "../look/PrimaryAction";
import ElasticSlider from "../rb/ElasticSlider/ElasticSlider";
import RubberSegment from "../rb/RubberSegment/RubberSegment";
import type { ConfigPayload, Tunables, WaveView } from "../store/types";
import { Clawd } from "../windows/wave/Clawd";
import { accentFor } from "../windows/wave/accent";
import { type ConfigAck, type ConfigTransport, copyCommand } from "./configTransport";
import {
  CONFIG_SCHEMA,
  SECTIONS,
  type SchemaRow,
  patchFor,
  schemaRows,
  valueAt,
} from "./schemaRows";
import "../styles/settings.css";

export interface SettingsModalProps {
  wave: WaveView;
  /** The retained `volley/_waves/_config` payload. */
  config: ConfigPayload | null;
  /** `null` = no broker credentials: read-only with copyable commands. */
  transport: ConfigTransport | null;
  onClose: () => void;
}

type Scope = "wave" | "global";
type RowState = { state: "sending" } | ({ state: "done" } & ConfigAck);

/** Slider commits this close together send one config_set, with the last value. */
export const SLIDER_COMMIT_MS = 400;
const COPY_RESET_MS = 1500;
/** Units written right after the value, as the prototype does ("3×"). */
const UNSPACED_UNITS = new Set(["×"]);

function display(value: unknown, unit: string): string {
  if (value === undefined) return "—";
  if (value === null) return "none";
  const gap = unit && !UNSPACED_UNITS.has(unit) ? " " : "";
  return `${String(value)}${gap}${unit}`;
}

function AckLine({ s }: { s: RowState | undefined }) {
  if (!s) return null;
  if (s.state === "sending") return <div className="cfg-ack dim">sending…</div>;
  if (s.applied) {
    return (
      <div className="cfg-ack cfg-ack--ok">
        {s.version !== undefined ? `applied · v${s.version}` : "applied"}
      </div>
    );
  }
  const why = [...s.rejected.map((r) => `${r.path}: ${r.reason}`), ...(s.error ? [s.error] : [])];
  // Only a rejected[] is a refusal; with no answer the outcome is unknown.
  const outcome =
    s.rejected.length > 0 || !s.error ? "rejected" : s.unanswered ? "no answer" : "failed";
  return (
    <div className="cfg-ack cfg-ack--bad" role="alert">
      {outcome} · {why.join(" · ") || "no reason given"}
    </div>
  );
}

/**
 * Selects the command's text and asks for a legacy copy: the fallback where the
 * async Clipboard API is missing (plain http, outside a secure context) or refused.
 */
function selectAndCopy(code: RefObject<HTMLElement | null>): boolean {
  const selection = window.getSelection();
  if (!code.current || !selection) return false;
  selection.selectAllChildren(code.current);
  try {
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  }
}

function CopyLine({ command }: { command: string }) {
  const [note, setNote] = useState<"Copied" | "Select and copy" | null>(null);
  const code = useRef<HTMLElement>(null);
  useEffect(() => {
    if (note !== "Copied") return;
    const t = setTimeout(() => setNote(null), COPY_RESET_MS);
    return () => clearTimeout(t);
  }, [note]);
  const fallback = () => setNote(selectAndCopy(code) ? "Copied" : "Select and copy");
  return (
    <div className="cfg-copy">
      <code ref={code}>{command}</code>
      <button
        type="button"
        className="btn btn--sm"
        aria-label="Copy command"
        onClick={() => {
          const clipboard = navigator.clipboard as Clipboard | undefined;
          if (!clipboard?.writeText) return fallback();
          clipboard.writeText(command).then(() => setNote("Copied"), fallback);
        }}
      >
        {note ?? "Copy"}
      </button>
    </div>
  );
}

function TextControl(p: {
  row: SchemaRow;
  value: unknown;
  disabled: boolean;
  onCommit: (v: string | null) => void;
}) {
  const current = typeof p.value === "string" ? p.value : "";
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const nullable = p.row.control.kind === "text" && p.row.control.nullable;
  const commit = () => {
    if (draft === current) return;
    p.onCommit(draft === "" && nullable ? null : draft);
  };
  return (
    <input
      className="cfg-text recessed mono"
      aria-label={p.row.label}
      value={draft}
      disabled={p.disabled}
      placeholder={nullable ? "none" : ""}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          // Drop the edit; the modal stays open.
          e.stopPropagation();
          setDraft(current);
        }
      }}
    />
  );
}

export function SettingsModal({ wave, config, transport, onClose }: SettingsModalProps) {
  const [scope, setScope] = useState<Scope>("wave");
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [acks, setAcks] = useState<Record<string, RowState>>({});
  const dialog = useRef<HTMLDivElement>(null);
  /** Numbers each user change; `latest` holds the newest per path. */
  const seq = useRef(0);
  /** The user's latest change per path: an answer to any other one is not shown. */
  const latest = useRef<Record<string, number>>({});
  /** The request in flight per path. */
  const inFlight = useRef<Record<string, { value: unknown; n: number }>>({});
  /** Slider changes waiting out `SLIDER_COMMIT_MS`, per path. */
  const queued = useRef<Record<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>>(
    {},
  );
  /** Paths whose slider is moving and not let go yet. */
  const editing = useRef(new Set<string>());
  const accent = accentFor(wave.id);
  const values: Tunables | null =
    scope === "global" ? config : (wave.state?.effective_config ?? null);
  const writable = transport !== null && scope === "global";
  /** No transport: a global row drafts a value for its copyable command instead of sending. */
  const draftOnly = transport === null && scope === "global";
  const rows = schemaRows(CONFIG_SCHEMA, values);

  const dropDraft = (path: string) => setDrafts(({ [path]: _, ...rest }) => rest);
  const unqueue = (path: string) => {
    const q = queued.current[path];
    if (q) clearTimeout(q.timer);
    delete queued.current[path];
    return q;
  };
  /** Send what is queued now rather than lose it (scope switch, close). */
  const flushQueued = () => {
    for (const path of Object.keys(queued.current)) unqueue(path)?.run();
  };

  useFocusTrap(dialog);
  // Focus moves into the dialog so Escape works at once; it goes back on close.
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // A change the user let go of is still sent when the modal closes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: flush on unmount only
  useEffect(() => () => flushQueued(), []);

  // A scope switch shows other values: queued changes go out, every draft goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on scope change only
  useEffect(() => {
    flushQueued();
    editing.current.clear();
    setDrafts({});
  }, [scope]);

  // New shown values drop a draft that they now match, or, for a row that is not
  // moving or waiting on an answer, one whose own value changed. Other rows' drafts stay.
  const shownValues = useRef(values);
  const valueKey = JSON.stringify(values);
  // biome-ignore lint/correctness/useExhaustiveDependencies: diff when the shown values change
  useEffect(() => {
    const before = shownValues.current;
    shownValues.current = values;
    setDrafts((d) => {
      const keep = Object.entries(d).filter(([path, draft]) => {
        const now = valueAt(values, path);
        if (Object.is(draft, now)) return false;
        const busy =
          editing.current.has(path) || path in queued.current || path in inFlight.current;
        return busy || Object.is(valueAt(before, path), now);
      });
      return keep.length === Object.keys(d).length ? d : Object.fromEntries(keep);
    });
  }, [valueKey]);

  const send = (path: string, value: unknown, n: number) => {
    if (!transport) return;
    inFlight.current[path] = { value, n };
    setAcks((a) => ({ ...a, [path]: { state: "sending" } }));
    void transport
      .send(patchFor(path, value), { text: `config_set ${path}=${JSON.stringify(value)}` })
      .then((ack) => {
        if (inFlight.current[path]?.n === n) delete inFlight.current[path];
        if (latest.current[path] !== n) return;
        setAcks((a) => ({ ...a, [path]: { state: "done", ...ack } }));
        // Refused: back to the current value. Unanswered: the retained config settles it.
        if (!ack.applied && !ack.unanswered) dropDraft(path);
      });
  };

  /** The user let go of a value: send it now, or after `delay` unless another follows. */
  const commit = (row: SchemaRow, value: unknown, delay: number) => {
    if (draftOnly) {
      editing.current.delete(row.path);
      if (Object.is(value, valueAt(values, row.path))) dropDraft(row.path);
      else setDrafts((d) => ({ ...d, [row.path]: value }));
      return;
    }
    if (!transport || !writable) return;
    const path = row.path;
    editing.current.delete(path);
    unqueue(path);
    const flying = inFlight.current[path];
    // Compare with what is in flight, not the retained value: a revert must still go out.
    if (Object.is(value, flying ? flying.value : valueAt(values, path))) {
      if (flying) latest.current[path] = flying.n;
      else dropDraft(path);
      return;
    }
    setDrafts((d) => ({ ...d, [path]: value }));
    seq.current += 1;
    const n = seq.current;
    latest.current[path] = n;
    if (delay <= 0) return send(path, value, n);
    const run = () => send(path, value, n);
    queued.current[path] = {
      run,
      timer: setTimeout(() => {
        delete queued.current[path];
        run();
      }, delay),
    };
  };

  const renderRow = (row: SchemaRow) => {
    const current = valueAt(values, row.path);
    const shown = Object.hasOwn(drafts, row.path) ? drafts[row.path] : current;
    const c = row.control;
    return (
      <div className="cfg-row" key={row.path}>
        <div className="cfg-lbl">
          <span>{row.label}</span>
          <span className="mono">{display(shown, row.unit)}</span>
        </div>
        {c.kind === "slider" ? (
          <ElasticSlider
            value={typeof shown === "number" ? shown : c.min}
            startingValue={c.min}
            maxValue={c.max}
            isStepped
            stepSize={c.step}
            valuePosition="none"
            leftIcon={null}
            rightIcon={null}
            rangeColor={accent}
            trackColor="rgba(255,255,255,.12)"
            disabled={!(writable || draftOnly) || current === undefined}
            onChange={(v) => {
              editing.current.add(row.path);
              setDrafts((d) => ({ ...d, [row.path]: v }));
            }}
            onChangeEnd={(v) => commit(row, v, SLIDER_COMMIT_MS)}
            ariaLabel={row.label}
          />
        ) : (
          <TextControl
            row={row}
            value={shown}
            disabled={!(writable || draftOnly) || current === undefined}
            onCommit={(v) => commit(row, v, 0)}
          />
        )}
        <div className="cfg-hint">{row.hint}</div>
        {writable ? (
          <AckLine s={acks[row.path]} />
        ) : (
          draftOnly &&
          current !== undefined &&
          (Object.hasOwn(drafts, row.path) && !Object.is(shown, current) ? (
            <CopyLine command={copyCommand(row.path, shown)} />
          ) : (
            <div className="cfg-hint">Pick a new value to copy its command.</div>
          ))
        )}
      </div>
    );
  };

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="modal"
        // biome-ignore lint/a11y/useSemanticElements: the prototype's modal markup and CSS (scrim + div)
        role="dialog"
        aria-modal="true"
        aria-label="Wave settings"
        tabIndex={-1}
        style={{ "--acc": accent } as CSSProperties}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Claimed, so the Desk's window-level Escape doesn't close the next dialog down too.
          e.preventDefault();
          onClose();
        }}
      >
        {/* A div, not <header>: outside sectioning content a header is a second banner landmark. */}
        <div className="modal-head">
          <Clawd /> <span className="t-name">Settings</span>
          <RubberSegment
            className="scope-seg"
            aria-label="Scope"
            size="sm"
            equalSlots={false}
            items={[
              { value: "wave", label: `This wave (${wave.id})` },
              { value: "global", label: "Global" },
            ]}
            value={scope}
            onChange={(v: string) => setScope(v as Scope)}
            trackColor="rgba(4, 5, 10, 0.85)"
            thumbColor={`color-mix(in srgb, ${accent} 24%, rgba(255, 255, 255, 0.08))`}
            textColor="#e8ecf4"
            activeTextColor="#ffffff"
          />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} />
          </button>
        </div>
        {scope === "wave" ? (
          <p className="modal-note">
            This wave's effective config. Per-wave values come from the wave file's{" "}
            <code>config:</code> block; <code>volleyd config set</code> changes the global config.
          </p>
        ) : (
          !transport && (
            <p className="modal-note">
              Read-only: the Desk has no broker credentials. Pick a new value, then copy its command
              and run it in a terminal.
            </p>
          )
        )}
        <div className="modal-body">
          {values === null && (
            <p className="dim">
              {scope === "global"
                ? "No config from volleyd yet."
                : "No effective config for this wave yet."}
            </p>
          )}
          {SECTIONS.map((section) => {
            const inSection = rows.filter((r) => r.section === section);
            if (values === null || (section !== "Leases" && inSection.length === 0)) return null;
            return (
              <section key={section}>
                <h3>{section}</h3>
                {inSection.length === 0 ? (
                  <div className="cfg-hint">No lease pools configured.</div>
                ) : (
                  inSection.map(renderRow)
                )}
              </section>
            );
          })}
        </div>
        <footer className="modal-foot">
          <span className="dim">
            Saved through <code>volleyd config set</code> · applies at the next admission tick ·
            never preempts running work
          </span>
          <PrimaryAction onClick={onClose}>Done</PrimaryAction>
        </footer>
      </div>
    </div>
  );
}
