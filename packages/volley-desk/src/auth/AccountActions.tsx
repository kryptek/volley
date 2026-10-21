/**
 * The controls a signed-in session changes its own sign-in with (`useAccount`):
 * Sign out and Switch account… on Settings' account card and in the Dock's
 * account menu, and the "Switch to an admin account" link every read-only
 * notice ends with. Outside a signed-in gate (demo, previews) they render
 * nothing; a Desk signed in by the build's `VITE_VOLLEY_BROKER_*` says so
 * instead of offering them.
 */
import { useEffect, useRef } from "react";
import { useAccount } from "./SignInGate";

/** Up to two letters for an account avatar. */
export const initials = (name: string) =>
  (name.match(/[a-z0-9]+/gi) ?? [name])
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase() || "?";

/** What the session is signed in by when it cannot sign out (the account card, the Dock menu). */
export const BY_ENVIRONMENT = "Signed in by environment (VITE_VOLLEY_BROKER_*)";

/** Sign out and Switch account…; `onDone` runs after either (the Dock closes its menu). */
export function AccountButtons({ onDone }: { onDone?: () => void }) {
  const account = useAccount();
  if (account === null) return null;
  if (account.byEnvironment) return <div className="s-hint account-env">{BY_ENVIRONMENT}</div>;
  return (
    <div className="account-actions">
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => {
          onDone?.();
          account.switchAccount();
        }}
      >
        Switch account…
      </button>
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => {
          onDone?.();
          account.signOut();
        }}
      >
        Sign out
      </button>
    </div>
  );
}

/** The link a read-only notice ends with: opens the token entry. */
export function SwitchToAdmin() {
  const account = useAccount();
  if (account === null || account.byEnvironment) return null;
  return (
    <button type="button" className="s-link" onClick={() => account.switchAccount()}>
      Switch to an admin account
    </button>
  );
}

/**
 * The Dock's account menu, opened from its avatar: who is signed in, and the
 * account buttons. Escape, a click outside and either button close it.
 */
export function AccountMenu({
  identity,
  role,
  onClose,
}: {
  identity: string | null;
  role: string;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  // A ref, not an effect dependency: a new callback must not move focus again.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    menu.current?.focus();
    const outside = (e: PointerEvent) => {
      const target = e.target as Element | null;
      // The avatar toggles the menu itself.
      if (target?.closest(".dock-account-menu, .dock-item--account")) return;
      close.current();
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, []);
  return (
    <div
      ref={menu}
      className="dock-account-menu win-depth"
      // biome-ignore lint/a11y/useSemanticElements: a popover over the dock, as the Desk's sheets
      role="dialog"
      aria-label="Account"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="ms-account">
        <div className="avatar" aria-hidden="true">
          {identity ? initials(identity) : "?"}
        </div>
        <div className="min0">
          <div className="ms-name">{identity ?? "Not signed in"}</div>
          <div className="s-hint">{role}</div>
        </div>
      </div>
      <AccountButtons onDone={onClose} />
    </div>
  );
}
