/**
 * A blocked repository chip's **Why** (Settings › Repositories' rows and Add repository's
 * progress): the chip shows a short reason (`shortReason`), and this toggle opens every reason in
 * full, wrapped, under it. A tooltip (`title=`) does not exist on a phone; this does.
 */
import { useState } from "react";

export function RepoChipReason({ reasons }: { reasons: readonly string[] }) {
  const [open, setOpen] = useState(false);
  if (reasons.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="btn repo-why"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Why
      </button>
      {open && (
        <div className="repo-chip__why">
          {reasons.map((r, i) => (
            <p key={`${i}:${r}`}>{r}</p>
          ))}
        </div>
      )}
    </>
  );
}
