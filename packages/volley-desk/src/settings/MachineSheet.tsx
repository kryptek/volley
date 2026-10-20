/**
 * The modal sheet Settings › Machines opens over a card (Repair, Remove): a
 * scrim, a labelled `dialog` that traps focus, closes on Escape and gives
 * focus back to its opener. Full-screen at phone width (machines.css).
 */
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useRef } from "react";
import { useFocusTrap } from "../a11y/keys";

export function MachineSheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useFocusTrap(dialog);
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <div className="m-sheet-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="m-sheet"
        // biome-ignore lint/a11y/useSemanticElements: the Desk's modal markup (scrim + div), as SettingsModal
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Claimed, so the Settings window behind it does not close too.
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      >
        <div className="m-sheet-head">
          <b>{label}</b>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
