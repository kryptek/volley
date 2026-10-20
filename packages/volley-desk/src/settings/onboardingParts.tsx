/**
 * Pieces Settings › Setup & Security and Broker accounts share, from the
 * prototype `onboarding.tsx`: `Qr` (a real QR code, `lib/qr.ts`, where the
 * prototype drew a stand-in), `CopyText` (a command or secret with a Copy
 * button that falls back to selecting it) and `Once` (a secret shown once, in
 * the dashed token box).
 */
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { encodeQr, qrPath } from "../lib/qr";
import "../styles/onboarding.css";

/** How long "Copied" stays on the button. */
const COPIED_MS = 2000;
/** Light modules around the code, as the standard asks. */
const QUIET = 2;

/** `text` as a scannable QR code (dark on light, whatever the theme). */
export function Qr({ text, size = 132, label }: { text: string; size?: number; label: string }) {
  const qr = useMemo(() => encodeQr(text), [text]);
  const n = qr.size + QUIET * 2;
  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={n} height={n} fill="#f4f6fb" />
      <path d={qrPath(qr, QUIET)} fill="#0b0d16" />
    </svg>
  );
}

/** Select the text of `el` and copy it the old way; false when the browser refuses. */
function selectAndCopy(el: HTMLElement | null): boolean {
  if (el === null) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  try {
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  }
}

/** `text` in monospace with a Copy button; when copying is refused the text is selected instead. */
export function CopyText({ text, label = "Copy" }: { text: string; label?: string }) {
  const [note, setNote] = useState<"Copied" | "Select and copy" | null>(null);
  const code = useRef<HTMLElement>(null);
  useEffect(() => {
    if (note !== "Copied") return;
    const t = setTimeout(() => setNote(null), COPIED_MS);
    return () => clearTimeout(t);
  }, [note]);
  const fallback = () => setNote(selectAndCopy(code.current) ? "Copied" : "Select and copy");
  return (
    <span className="copy-text">
      <code ref={code} className="mono">
        {text}
      </code>
      <button
        type="button"
        className="btn btn--sm"
        aria-label={`${label}: ${text.length > 40 ? "the text" : text}`}
        onClick={() => {
          const clipboard = navigator.clipboard as Clipboard | undefined;
          if (!clipboard?.writeText) return fallback();
          clipboard.writeText(text).then(() => setNote("Copied"), fallback);
        }}
      >
        <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.8} /> {note ?? label}
      </button>
    </span>
  );
}

/** A secret shown once: its label, the value with Copy, an optional QR, and Done. */
export function Once({
  label,
  secret,
  qr,
  children,
  onDone,
}: {
  label: ReactNode;
  secret: string;
  /** What the QR code carries (the secret itself when omitted); `false` for none. */
  qr?: string | false;
  children?: ReactNode;
  onDone?: () => void;
}) {
  return (
    <div className="token">
      <div className="token-main">
        <div className="lbl">{label}</div>
        <CopyText text={secret} />
        {children}
      </div>
      <div className="token-side">
        {qr !== false && <Qr text={qr ?? secret} size={96} label="QR code of the secret" />}
        {onDone && (
          <button type="button" className="btn" onClick={onDone}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
