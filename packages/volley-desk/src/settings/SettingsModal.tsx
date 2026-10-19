/**
 * A wave's settings (port of the prototype `SettingsModal`), opened from the
 * wave window's gear glyph: the wave's `effective_config` as D5's schema rows
 * (`ConfigRows`, wave scope), read-only — volleyd applies config_set to the
 * global config, and per-wave values come from the wave file's `config:`
 * block. "Global settings…" opens Settings › Supervisor, where the global
 * config is edited. Built like a Desk window (D10): `win-depth` and a `win-edge`.
 * Above the rows, the wave's Claude account: the accounts its agents run under
 * (from the usage records) and, while the wave has an open `account_limit`
 * decision, a picker that answers it with the chosen account (volleyd moves a
 * wave only through that answer).
 */
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../a11y/keys";
import { PrimaryAction } from "../look/PrimaryAction";
import { type AccountInfo, moveAnswer, openLimitDecisions, resolveFields } from "../store/claude";
import type { WaveView } from "../store/types";
import { Clawd } from "../windows/wave/Clawd";
import { accentFor } from "../windows/wave/accent";
import type { ControlFn } from "./ClaudeAccounts";
import { ConfigRows } from "./ConfigRows";
import "../styles/settings.css";

export interface SettingsModalProps {
  wave: WaveView;
  onClose: () => void;
  /** Opens Settings › Supervisor (the global config) in place of this modal. */
  onOpenGlobal: () => void;
  /** The Claude accounts (usage records + registry), for the wave's account. */
  accounts?: readonly AccountInfo[];
  /** volleyd's control channel; `null` = read-only. */
  control?: ControlFn | null;
}

/** The wave's Claude account and, while an `account_limit` decision is open, the move picker. */
function WaveAccount({
  wave,
  accounts,
  control,
}: {
  wave: WaveView;
  accounts: readonly AccountInfo[];
  control: ControlFn | null;
}) {
  const [note, setNote] = useState<string | null>(null);
  const on = accounts.filter((a) => a.waves.includes(wave.id));
  const d = openLimitDecisions({ [wave.id]: wave })[0];
  const targets = d ? accounts.filter((a) => a.id !== d.acct && !a.id.includes("@")) : [];
  const move = async (acct: string) => {
    if (!d || !control) return;
    setNote(null);
    const r = await control("resolve", resolveFields(d, moveAnswer(wave.id, acct)));
    setNote(r.ok ? null : (r.error ?? "volleyd refused the move"));
  };
  return (
    <div className="modal-acct">
      <span className="s-hint">Claude account</span>
      <span className="mono">
        {on.length ? on.map((a) => a.label).join(", ") : "set by the wave file, else the default"}
      </span>
      {d && control && targets.length > 0 ? (
        <select
          aria-label={`Move wave ${wave.id} to a Claude account`}
          value=""
          onChange={(e) => void move(e.target.value)}
        >
          <option value="">Move new agents to…</option>
          {targets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.fiveHour ? `${a.label} · ${Math.round(a.fiveHour.pct)}%` : a.label}
            </option>
          ))}
        </select>
      ) : (
        <span className="s-hint">volleyd offers a move when the account nears its limit</span>
      )}
      {note && (
        <span className="s-error" role="alert">
          {note}
        </span>
      )}
    </div>
  );
}

export function SettingsModal({
  wave,
  onClose,
  onOpenGlobal,
  accounts = [],
  control = null,
}: SettingsModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const accent = accentFor(wave.id);

  useFocusTrap(dialog);
  // Focus moves into the dialog so Escape works at once; it goes back on close.
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="modal win-depth"
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
          <Clawd /> <span className="t-name">Settings · {wave.id}</span>
          <button type="button" className="btn btn--sm modal-global" onClick={onOpenGlobal}>
            Global settings…
          </button>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} />
          </button>
        </div>
        <p className="modal-note">
          This wave's effective config. Per-wave values come from the wave file's{" "}
          <code>config:</code> block; the global config lives in Settings › Supervisor.
        </p>
        <WaveAccount wave={wave} accounts={accounts} control={control} />
        <div className="modal-body">
          <ConfigRows
            scope="wave"
            values={wave.state?.effective_config ?? null}
            transport={null}
            accent={accent}
          />
        </div>
        <footer className="modal-foot">
          <span className="dim">
            Read-only here · <code>volleyd config set</code> changes the global config
          </span>
          <PrimaryAction onClick={onClose}>Done</PrimaryAction>
        </footer>
        <span className="win-edge" aria-hidden="true" />
      </div>
    </div>
  );
}
