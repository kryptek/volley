/**
 * The settings modal (port of the prototype `SettingsModal`), opened from a
 * wave window's gear glyph. Rows come from the config schema (`schemaRows`):
 * "Global" shows the retained `_config`, "This wave" the wave's
 * `effective_config`. A change sends one config_set (`configTransport`) and
 * the row shows the ack: applied with the new version, or the rejected paths
 * with their reasons.
 *
 * Writes need broker credentials: without a transport the modal is read-only
 * and each row offers its exact `volleyd config set` line to copy. The wave
 * scope is read-only too — volleyd applies config_set to the global config,
 * and per-wave values come from the wave file's `config:` block.
 */
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import ElasticSlider from "../rb/ElasticSlider/ElasticSlider";
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

const COPY_RESET_MS = 1500;

function display(value: unknown, unit: string): string {
  if (value === undefined) return "—";
  if (value === null) return "none";
  return `${String(value)}${unit ? ` ${unit}` : ""}`;
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
  return (
    <div className="cfg-ack cfg-ack--bad" role="alert">
      rejected · {why.join(" · ") || "no reason given"}
    </div>
  );
}

function CopyLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPY_RESET_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="cfg-copy">
      <code>{command}</code>
      <button
        type="button"
        className="btn btn--sm"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy"}
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
      className="cfg-text mono"
      aria-label={p.row.label}
      value={draft}
      disabled={p.disabled}
      placeholder={nullable ? "none" : ""}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

export function SettingsModal({ wave, config, transport, onClose }: SettingsModalProps) {
  const [scope, setScope] = useState<Scope>("wave");
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [acks, setAcks] = useState<Record<string, RowState>>({});
  /** Latest request per path: an answer to an older one is ignored. */
  const latest = useRef<Record<string, number>>({});
  const accent = accentFor(wave.id);
  const values: Tunables | null =
    scope === "global" ? config : (wave.state?.effective_config ?? null);
  const writable = transport !== null && scope === "global";
  const rows = schemaRows(CONFIG_SCHEMA, values);

  // A new value for a path (the retained config caught up, or the scope changed) drops its draft.
  const valueKey = JSON.stringify(values);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the shown values change
  useEffect(() => setDrafts({}), [valueKey, scope]);

  const send = (row: SchemaRow, value: unknown) => {
    if (!transport || !writable) return;
    if (value === valueAt(values, row.path)) return;
    setDrafts((d) => ({ ...d, [row.path]: value }));
    setAcks((a) => ({ ...a, [row.path]: { state: "sending" } }));
    const n = (latest.current[row.path] ?? 0) + 1;
    latest.current[row.path] = n;
    void transport
      .send(patchFor(row.path, value), { text: `config_set ${row.path}=${JSON.stringify(value)}` })
      .then((ack) => {
        if (latest.current[row.path] !== n) return;
        setAcks((a) => ({ ...a, [row.path]: { state: "done", ...ack } }));
        if (!ack.applied) {
          setDrafts(({ [row.path]: _, ...rest }) => rest);
        }
      });
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
            fillContentColor="currentColor"
            disabled={!writable || current === undefined}
            onChange={(v) => setDrafts((d) => ({ ...d, [row.path]: v }))}
            onChangeEnd={(v) => send(row, v)}
            ariaLabel={row.label}
          />
        ) : (
          <TextControl
            row={row}
            value={shown}
            disabled={!writable || current === undefined}
            onCommit={(v) => send(row, v)}
          />
        )}
        <div className="cfg-hint">{row.hint}</div>
        {writable ? (
          <AckLine s={acks[row.path]} />
        ) : (
          scope === "global" &&
          current !== undefined && <CopyLine command={copyCommand(row.path, current)} />
        )}
      </div>
    );
  };

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        // biome-ignore lint/a11y/useSemanticElements: the prototype's modal markup and CSS (scrim + div)
        role="dialog"
        aria-modal="true"
        aria-label="Wave settings"
        style={{ "--acc": accent } as CSSProperties}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className="modal-head">
          <Clawd /> <span className="t-name">Settings</span>
          <div className="seg" role="radiogroup" aria-label="Scope">
            <button
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: the prototype's segmented control
              role="radio"
              aria-checked={scope === "wave"}
              onClick={() => setScope("wave")}
            >
              This wave ({wave.id})
            </button>
            <button
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: the prototype's segmented control
              role="radio"
              aria-checked={scope === "global"}
              onClick={() => setScope("global")}
            >
              Global
            </button>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} />
          </button>
        </header>
        {scope === "wave" ? (
          <p className="modal-note">
            This wave's effective config. Per-wave values come from the wave file's{" "}
            <code>config:</code> block; <code>volleyd config set</code> changes the global config.
          </p>
        ) : (
          !transport && (
            <p className="modal-note">
              Read-only: the Desk has no broker credentials. Copy a command to change a value.
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
          <button type="button" className="btn btn--hot" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
