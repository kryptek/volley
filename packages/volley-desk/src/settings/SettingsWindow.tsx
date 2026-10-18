/**
 * The Settings window, ported from the prototype `settings.tsx`: a macOS
 * System Settings–style dialog. The sidebar has the traffic dots, a search
 * over the section labels and keywords (`matchSections`), the signed-in
 * broker account and the sections in three groups with coloured icon tiles;
 * the main pane shows the picked section (General, Appearance, Supervisor,
 * About; the Onboarding sections are placeholders for now). Escape, the
 * close button and a scrim click close it; focus moves in on open (and Tab
 * stays inside) and goes back to the opener on close.
 */
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../a11y/keys";
import type { Look } from "../look/useLook";
import type { NotifyOptions } from "../notify/use-notify-settings";
import type { ConfigPayload } from "../store/types";
import { About } from "./About";
import { Appearance } from "./Appearance";
import { General } from "./General";
import { Supervisor } from "./Supervisor";
import type { ConfigTransport } from "./configTransport";
import {
  SECTION_GROUPS,
  type SectionDef,
  type SectionKey,
  accountRole,
  matchSections,
  sectionDef,
} from "./sections";
import "../styles/settings.css";

export interface SettingsWindowProps {
  look: Look;
  setLook: (change: Partial<Look>) => void;
  notify: NotifyOptions;
  setNotify: (next: NotifyOptions) => void;
  /** Whether this browser has WebGL (`useWebGL`). */
  webgl: boolean;
  /** The Desk's broker identity; `null` when anonymous. */
  identity: string | null;
  demo: boolean;
  /** The retained `volley/_waves/_config` payload. */
  config: ConfigPayload | null;
  /** `null` = no broker credentials: the Supervisor rows are read-only. */
  transport: ConfigTransport | null;
  onArrange: () => void;
  onClose: () => void;
  /** The section shown first; General by default. */
  initial?: SectionKey;
}

const Tile = ({ s, size }: { s: SectionDef; size: number }) => (
  <span className={`tile${size > 13 ? " tile--lg" : ""}`} style={{ background: s.tint }}>
    <HugeiconsIcon icon={s.icon} size={size} strokeWidth={1.8} />
  </span>
);

/** Up to two letters for the account avatar. */
const initials = (name: string) =>
  (name.match(/[a-z0-9]+/gi) ?? [name])
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase() || "?";

export function SettingsWindow(p: SettingsWindowProps) {
  const [sec, setSec] = useState<SectionKey>(p.initial ?? "general");
  const [q, setQ] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const shown = matchSections(q);
  const cur = sectionDef(sec);

  useFocusTrap(dialog);
  // Focus moves into the window so Escape works at once; it goes back on close.
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div
        ref={dialog}
        className="mac-settings"
        // biome-ignore lint/a11y/useSemanticElements: the prototype's modal markup and CSS (scrim + div)
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Claimed, so the Desk's window-level Escape doesn't close the next dialog down too.
          e.preventDefault();
          p.onClose();
        }}
      >
        <div className="ms-side">
          <div className="ms-traffic" aria-hidden="true">
            <i className="r" />
            <i className="y" />
            <i className="g" />
          </div>
          <label className="ms-search">
            <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={1.8} />
            <input
              type="search"
              placeholder="Search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search settings"
            />
          </label>
          {/* biome-ignore lint/a11y/useSemanticElements: a labelled block of text, not a form fieldset */}
          <div className="ms-account" role="group" aria-label="Signed-in account">
            <div className="avatar" aria-hidden="true">
              {p.identity ? initials(p.identity) : "?"}
            </div>
            <div className="min0">
              <div className="ms-name">{p.identity ?? "Not signed in"}</div>
              <div className="s-hint">{accountRole(p.identity, p.demo)}</div>
            </div>
          </div>
          <nav aria-label="Settings sections">
            {SECTION_GROUPS.map((g) => {
              const items = shown.filter((s) => s.group === g);
              return items.length ? (
                <ul key={g} className="ms-list">
                  {items.map((s) => (
                    <li key={s.key}>
                      <button
                        type="button"
                        className={sec === s.key ? "on" : ""}
                        onClick={() => setSec(s.key)}
                        aria-current={sec === s.key ? "page" : undefined}
                      >
                        <Tile s={s} size={13} />
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null;
            })}
            {shown.length === 0 && (
              <p className="s-hint ms-none">No settings match “{q.trim()}”.</p>
            )}
          </nav>
        </div>
        <div className="ms-main">
          <div className="ms-head">
            <Tile s={cur} size={16} />
            <h2>{cur.label}</h2>
            <button
              type="button"
              className="icon-btn ms-close"
              onClick={p.onClose}
              aria-label="Close settings"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} />
            </button>
          </div>
          <div className="ms-body">
            {sec === "general" && (
              <General
                look={p.look}
                setLook={p.setLook}
                notify={p.notify}
                setNotify={p.setNotify}
                onArrange={p.onArrange}
              />
            )}
            {sec === "appearance" && (
              <Appearance look={p.look} setLook={p.setLook} webgl={p.webgl} />
            )}
            {sec === "supervisor" && <Supervisor config={p.config} transport={p.transport} />}
            {sec === "about" && <About />}
            {cur.placeholder && (
              <div className="ms-placeholder">
                <Tile s={cur} size={16} />
                <p>Coming with Onboarding.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
