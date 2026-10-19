/**
 * A wave's settings (port of the prototype `SettingsModal`), opened from the
 * wave window's gear glyph: the wave's `effective_config` as D5's schema rows
 * (`ConfigRows`, wave scope), read-only — volleyd applies config_set to the
 * global config, and per-wave values come from the wave file's `config:`
 * block. "Global settings…" opens Settings › Supervisor, where the global
 * config is edited. Built like a Desk window (D10): `win-depth` and a `win-edge`.
 */
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CSSProperties, useEffect, useRef } from "react";
import { useFocusTrap } from "../a11y/keys";
import { PrimaryAction } from "../look/PrimaryAction";
import type { WaveView } from "../store/types";
import { Clawd } from "../windows/wave/Clawd";
import { accentFor } from "../windows/wave/accent";
import { ConfigRows } from "./ConfigRows";
import "../styles/settings.css";

export interface SettingsModalProps {
  wave: WaveView;
  onClose: () => void;
  /** Opens Settings › Supervisor (the global config) in place of this modal. */
  onOpenGlobal: () => void;
}

export function SettingsModal({ wave, onClose, onOpenGlobal }: SettingsModalProps) {
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
