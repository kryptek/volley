/**
 * The Settings window, ported from the prototype `settings.tsx`: a macOS
 * System Settings–style dialog. The sidebar has the traffic dots, a search
 * over the section labels and keywords (`matchSections`), the signed-in
 * broker account and the sections in three groups with coloured icon tiles;
 * the main pane shows the picked section (General, Sound, Appearance, Supervisor,
 * Claude accounts & usage, Broker accounts, Machines, Setup & Security,
 * About). Escape, the close button and a scrim click close it (Escape in a search box with a
 * query clears the query instead); focus moves in on open (and Tab stays
 * inside) and goes back to the opener on close. It is built like a Desk
 * window (D10): the `win-depth` lift and gradient body, and a `win-edge`.
 */
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../a11y/keys";
import type { Look } from "../look/useLook";
import type { NotifyOptions, SetNotify } from "../notify/use-notify-settings";
import { SOUND0 } from "../sounds/settings";
import { usePanelSound } from "../sounds/usePanelSound";
import type { AuthOps } from "../store/control";
import type { AdminStatus } from "../store/peerOps";
import type { ConfigPayload, LeasePoolPayload } from "../store/types";
import { About } from "./About";
import { Appearance } from "./Appearance";
import { BrokerAccounts } from "./BrokerAccounts";
import { ClaudeAccounts, type ClaudeAccountsProps } from "./ClaudeAccounts";
import { General } from "./General";
import { Machines, type MachinesProps } from "./Machines";
import { Setup, useAdminRole } from "./Setup";
import { Sound, type SoundSectionProps } from "./Sound";
import { Supervisor } from "./Supervisor";
import type { ConfigTransport } from "./configTransport";
import { clearOnEscape } from "./primitives";
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
  setNotify: SetNotify;
  /** Whether this browser has WebGL (`useWebGL`). */
  webgl: boolean;
  /** The Desk's broker identity; `null` when anonymous. */
  identity: string | null;
  demo: boolean;
  /** The retained `volley/_waves/_config` payload. */
  config: ConfigPayload | null;
  /** `null` = no broker credentials: the Supervisor rows are read-only. */
  transport: ConfigTransport | null;
  /** The retained lease pools (Settings › Supervisor's lease card). */
  leases?: Record<string, LeasePoolPayload>;
  onArrange: () => void;
  /** Settings › General › Reset layout: clear every window pin (C12). */
  onResetLayout?: () => void;
  onClose: () => void;
  /** The section shown first; General by default. */
  initial?: SectionKey;
  /** Settings › Claude accounts & usage: the store's slices and volleyd's control channel. */
  claude?: Pick<ClaudeAccountsProps, "accounts" | "signins" | "waves" | "control" | "onRegistry">;
  /** Settings › Sound: the sound settings and the sound manager's theme loading and audition. */
  sound?: SoundSectionProps;
  /** Settings › Machines: the machine records and the pairing ops. */
  machines?: MachinesProps;
  /** Settings › Broker accounts and Setup & Security: volleyd's admin channel and where the Desk is. */
  onboarding?: {
    /** `null` when the Desk cannot send admin ops (anonymous, demo). */
    ops: AuthOps | null;
    brokerUrl: string | null;
    /** This Desk's URL without a fragment (what a sign-in link opens). */
    deskUrl: string;
    onPreviewSignIn?: () => void;
    /** Agents with a live status now (Broker accounts' Agents row). */
    liveAgents?: number;
    /** Setup & Security › Open setup…: Settings closes and the wizard opens in its own modal. */
    onOpenSetup?: (repair: boolean) => void;
  };
}

/** Settings › Sound with nothing behind it (a caller that passes no `sound`). */
const SOUND_OFF: SoundSectionProps = {
  sound: SOUND0,
  setSound: () => {},
  loadTheme: async () => {},
  audition: () => {},
  disposeAudition: () => {},
  canVibrate: false,
};

/** The account row's second line for an admin session (a redeemed admin token). */
const ADMIN_ROLE = "Admin · manages accounts and setup";

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
  // An open window follows a new section it is given (and each machine chip click, on Machines).
  const { initial } = p;
  const focusMachine = p.machines?.focus;
  const focusSeq = p.machines?.focusSeq;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new chip click re-opens Machines
  useEffect(() => {
    if (initial) setSec(initial);
  }, [initial, focusMachine, focusSeq]);
  const [q, setQ] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const shown = matchSections(q);
  const cur = sectionDef(sec);
  const ops = p.onboarding?.ops ?? null;
  // Asked only once an admin-only section is open: a non-admin's ask is never answered.
  const { admin: authAdmin, role } = useAdminRole(
    ops,
    p.identity,
    sec === "accounts" || sec === "setup",
  );
  // Machines checks the same account with its pairing ops: an admin there is one here too.
  const [peerAdmin, setPeerAdmin] = useState<AdminStatus | null>(null);
  const admin = authAdmin || peerAdmin === "admin";

  useFocusTrap(dialog);
  usePanelSound();
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
        className="mac-settings win-depth"
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
          <label className="ms-search recessed">
            <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={1.8} />
            <input
              type="search"
              placeholder="Search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => clearOnEscape(e, q, setQ)}
              aria-label="Search settings"
            />
          </label>
          {/* biome-ignore lint/a11y/useSemanticElements: a labelled block of text, not a form fieldset */}
          <div className="ms-account" role="group" aria-label="Signed-in account">
            <div
              className="avatar"
              aria-hidden="true"
              title={`${p.identity ?? "Not signed in"} · ${admin ? ADMIN_ROLE : accountRole(p.identity, p.demo)}`}
            >
              {p.identity ? initials(p.identity) : "?"}
            </div>
            <div className="min0">
              <div className="ms-name">{p.identity ?? "Not signed in"}</div>
              <div className="s-hint">{admin ? ADMIN_ROLE : accountRole(p.identity, p.demo)}</div>
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
                {...(p.onResetLayout ? { onResetLayout: p.onResetLayout } : {})}
                onOpenSound={() => setSec("sound")}
              />
            )}
            {sec === "sound" && <Sound {...(p.sound ?? SOUND_OFF)} />}
            {sec === "appearance" && (
              <Appearance look={p.look} setLook={p.setLook} webgl={p.webgl} />
            )}
            {sec === "supervisor" && (
              <Supervisor config={p.config} transport={p.transport} leases={p.leases ?? {}} />
            )}
            {sec === "claude" && (
              <ClaudeAccounts
                accounts={p.claude?.accounts ?? {}}
                signins={p.claude?.signins ?? {}}
                waves={p.claude?.waves ?? {}}
                control={p.claude?.control ?? null}
                {...(p.claude?.onRegistry ? { onRegistry: p.claude.onRegistry } : {})}
                config={p.config}
                configTransport={p.transport}
              />
            )}
            {sec === "accounts" && (
              <BrokerAccounts
                ops={ops}
                admin={admin}
                identity={p.identity}
                role={role}
                liveAgents={p.onboarding?.liveAgents ?? null}
              />
            )}
            {sec === "machines" && (
              <Machines
                {...(p.machines ?? { machines: {}, hubUp: false, ops: null })}
                onAdmin={setPeerAdmin}
              />
            )}
            {sec === "setup" && (
              <Setup
                ops={ops}
                admin={admin}
                identity={p.identity}
                brokerUrl={p.onboarding?.brokerUrl ?? null}
                deskUrl={p.onboarding?.deskUrl ?? ""}
                {...(p.onboarding?.onPreviewSignIn
                  ? { onPreviewSignIn: p.onboarding.onPreviewSignIn }
                  : {})}
                {...(p.onboarding?.onOpenSetup ? { onOpenSetup: p.onboarding.onOpenSetup } : {})}
              />
            )}
            {sec === "about" && <About />}
            {cur.placeholder && (
              <div className="ms-placeholder">
                <Tile s={cur} size={16} />
                <p>Coming with Onboarding.</p>
              </div>
            )}
          </div>
        </div>
        <span className="win-edge" aria-hidden="true" />
      </div>
    </div>
  );
}
