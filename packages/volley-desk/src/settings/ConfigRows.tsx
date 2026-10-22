/**
 * The volleyd config rows (D5), shared by Settings › Supervisor (the global
 * config) and a wave's settings (its effective config). Rows come from the
 * config schema (`schemaRows`), grouped by section. In the global scope a
 * change sends one config_set (`configTransport`) and the row shows the ack:
 * applied with the new version, or the rejected paths with their reasons. A
 * slider sends once the user lets go: key presses and drags within
 * `SLIDER_COMMIT_MS` of each other coalesce into one config_set carrying the
 * settled value; a change still queued when the rows unmount is sent then.
 *
 * Writes need broker credentials: without a transport nothing is sent; a
 * global row still takes a new value as a draft and offers the exact
 * `volleyd config set` line that sets it to copy (nothing to copy until the
 * value differs from the current one). The wave scope is read-only —
 * volleyd applies config_set to the global config, and per-wave values come
 * from the wave file's `config:` block.
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import ElasticSlider from "../rb/ElasticSlider/ElasticSlider";
import type { Tunables } from "../store/types";
import { type ConfigAck, type ConfigTransport, copyCommand } from "./configTransport";
import { Group, Toggle } from "./primitives";
import {
  CONFIG_SCHEMA,
  SECTIONS,
  type SchemaRow,
  type Section,
  patchFor,
  schemaRows,
  valueAt,
} from "./schemaRows";
import "../styles/settings.css";

export type ConfigScope = "wave" | "global";
/** A config row's request: in flight, or volleyd's answer. */
export type RowState = { state: "sending" } | ({ state: "done" } & ConfigAck);

/** Slider commits this close together send one config_set, with the last value. */
export const SLIDER_COMMIT_MS = 400;
const COPY_RESET_MS = 1500;
/** Units written right after the value, as the prototype does ("3×"). */
const UNSPACED_UNITS = new Set(["×"]);

/** Equal values: the same scalar, or lists with the same items in the same order. */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
}

function display(value: unknown, unit: string): string {
  if (value === undefined) return "—";
  if (value === null) return "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return `${value.length} selected`;
  const gap = unit && !UNSPACED_UNITS.has(unit) ? " " : "";
  return `${String(value)}${gap}${unit}`;
}

/** What volleyd answered a row's config_set: applied, rejected, failed or no answer. */
export function AckLine({ s }: { s: RowState | undefined }) {
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
          // Drop the edit; the dialog stays open.
          e.stopPropagation();
          setDraft(current);
        }
      }}
    />
  );
}

/** A list of enum values as one checkbox per option; a change sends the whole new list. */
function MultiControl(p: {
  row: SchemaRow;
  options: readonly string[];
  value: unknown;
  disabled: boolean;
  onCommit: (v: string[]) => void;
}) {
  const chosen = Array.isArray(p.value)
    ? p.value.filter((v): v is string => typeof v === "string")
    : [];
  return (
    <fieldset className="cfg-multi" aria-label={p.row.label} disabled={p.disabled}>
      {p.options.map((o) => (
        <label key={o} className="cfg-multi-opt mono">
          <input
            type="checkbox"
            checked={chosen.includes(o)}
            onChange={(e) =>
              p.onCommit(e.target.checked ? [...chosen, o] : chosen.filter((x) => x !== o))
            }
          />
          {o}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * A list of free strings as one comma-separated field; a commit sends the whole new list. A list
 * over the schema's bounds (`maxItems`, an item's `maxLength`) is not sent: the field stays as typed
 * and says why.
 */
function ListControl(p: {
  row: SchemaRow;
  value: unknown;
  disabled: boolean;
  maxItems?: number;
  maxLength?: number;
  onCommit: (v: string[]) => void;
}) {
  const items = Array.isArray(p.value)
    ? p.value.filter((v): v is string => typeof v === "string")
    : [];
  const current = items.join(", ");
  const [draft, setDraft] = useState(current);
  const [invalid, setInvalid] = useState<string | null>(null);
  useEffect(() => setDraft(current), [current]);
  const commit = () => {
    const next = [...new Set(draft.split(",").map((v) => v.trim()))].filter((v) => v !== "");
    const { maxItems, maxLength } = p;
    const over =
      maxItems !== undefined && next.length > maxItems
        ? `at most ${maxItems} names`
        : maxLength !== undefined && next.some((v) => v.length > maxLength)
          ? `a name is at most ${maxLength} characters`
          : null;
    setInvalid(over);
    if (over !== null || next.join(", ") === current) return;
    p.onCommit(next);
  };
  return (
    <input
      className="cfg-text recessed mono"
      aria-label={p.row.label}
      aria-invalid={invalid !== null}
      title={invalid ?? undefined}
      value={draft}
      disabled={p.disabled}
      placeholder="none"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          // Drop the edit; the dialog stays open.
          e.stopPropagation();
          setDraft(current);
          setInvalid(null);
        }
      }}
    />
  );
}

export interface ConfigRowsProps {
  scope: ConfigScope;
  /** The values shown: the retained `_config` (global) or the wave's `effective_config`. */
  values: Tunables | null;
  /** `null` = no broker credentials: read-only with copyable commands. */
  transport: ConfigTransport | null;
  /** The slider colour. */
  accent: string;
  /** Under the section groups (the global scope's save note). */
  foot?: string;
  /** A row to scroll into view and focus on open, by its path (`fleet.local_agents`). */
  focus?: string | undefined;
  /** Bumped on every request, so the same row is brought back again. */
  focusSeq?: number | undefined;
  /** Only these sections' groups (Settings › Autopilot's own); all of them by default. */
  sections?: readonly Section[];
}

export function ConfigRows({
  scope,
  values,
  transport,
  accent,
  foot,
  focus,
  focusSeq,
  sections = SECTIONS,
}: ConfigRowsProps) {
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [acks, setAcks] = useState<Record<string, RowState>>({});
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
  const writable = transport !== null && scope === "global";
  const root = useRef<HTMLDivElement>(null);
  // A deep link into a row (a machine card's chip): scroll to it and focus its control.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new focusSeq is a new request
  useEffect(() => {
    if (!focus) return;
    const rowEl = [
      ...(root.current?.querySelectorAll<HTMLElement>(".cfg-row[data-path]") ?? []),
    ].find((el) => el.dataset.path === focus);
    if (!rowEl) return;
    rowEl.scrollIntoView({ block: "center" });
    rowEl.querySelector<HTMLElement>("select, input, button, [role='slider'], [tabindex]")?.focus();
  }, [focus, focusSeq]);
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

  // A change the user let go of is still sent when the rows go away (dialog closed).
  // biome-ignore lint/correctness/useExhaustiveDependencies: flush on unmount only
  useEffect(
    () => () => {
      for (const path of Object.keys(queued.current)) unqueue(path)?.run();
    },
    [],
  );

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
        if (same(draft, now)) return false;
        const busy =
          editing.current.has(path) || path in queued.current || path in inFlight.current;
        return busy || same(valueAt(before, path), now);
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
      if (same(value, valueAt(values, row.path) ?? row.default)) dropDraft(row.path);
      else setDrafts((d) => ({ ...d, [row.path]: value }));
      return;
    }
    if (!transport || !writable) return;
    const path = row.path;
    editing.current.delete(path);
    unqueue(path);
    const flying = inFlight.current[path];
    // Compare with what is in flight, not the retained value: a revert must still go out.
    if (same(value, flying ? flying.value : (valueAt(values, path) ?? row.default))) {
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
    const current = valueAt(values, row.path) ?? row.default;
    const shown = Object.hasOwn(drafts, row.path) ? drafts[row.path] : current;
    const c = row.control;
    return (
      <div className="cfg-row" key={row.path} data-path={row.path}>
        <div className="cfg-lbl">
          <span>{row.label}</span>
          <span className="mono">{display(shown, row.unit)}</span>
        </div>
        {c.kind === "toggle" ? (
          <Toggle
            on={shown === true}
            label={row.label}
            disabled={!(writable || draftOnly) || current === undefined}
            onChange={(v) => commit(row, v, 0)}
          />
        ) : c.kind === "choice" ? (
          <select
            className="cfg-text recessed mono"
            aria-label={row.label}
            value={typeof shown === "string" ? shown : ""}
            disabled={!(writable || draftOnly) || current === undefined}
            onChange={(e) => commit(row, e.target.value, 0)}
          >
            {typeof shown !== "string" && <option value="">—</option>}
            {c.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : c.kind === "multi" ? (
          <MultiControl
            row={row}
            options={c.options}
            value={shown}
            disabled={!(writable || draftOnly) || current === undefined}
            onCommit={(v) => commit(row, v, 0)}
          />
        ) : c.kind === "list" ? (
          <ListControl
            row={row}
            value={shown}
            {...(c.maxItems !== undefined ? { maxItems: c.maxItems } : {})}
            {...(c.maxLength !== undefined ? { maxLength: c.maxLength } : {})}
            disabled={!(writable || draftOnly) || current === undefined}
            onCommit={(v) => commit(row, v, 0)}
          />
        ) : c.kind === "slider" ? (
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
          (Object.hasOwn(drafts, row.path) && !same(shown, current) ? (
            <CopyLine command={copyCommand(row.path, shown)} />
          ) : (
            <div className="cfg-hint">Pick a new value to copy its command.</div>
          ))
        )}
      </div>
    );
  };

  if (values === null) {
    return (
      <p className="dim">
        {scope === "global"
          ? "No config from volleyd yet."
          : "No effective config for this wave yet."}
      </p>
    );
  }
  const groups = sections.flatMap((section) => {
    const inSection = rows.filter((r) => r.section === section);
    if (section !== "Leases" && inSection.length === 0) return [];
    return [[section, inSection] as const];
  });
  return (
    <div className="cfg-rows" ref={root}>
      {groups.map(([section, inSection], i) => (
        <Group key={section} title={section} {...(foot && i === groups.length - 1 ? { foot } : {})}>
          {inSection.length === 0 ? (
            <div className="cfg-row cfg-hint">No lease pools configured.</div>
          ) : (
            inSection.map(renderRow)
          )}
        </Group>
      ))}
    </div>
  );
}
