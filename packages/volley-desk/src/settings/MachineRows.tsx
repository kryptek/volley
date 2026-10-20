/**
 * The rows Settings › Machines shares between its cards, the Repair sheet and
 * the Add-a-machine Stepper: a doctor's checks (✓ / ! / ✗, with the Desk's fix
 * from `machineFixes.ts`) and a copyable terminal command.
 */
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useEffect, useState } from "react";
import type { MachineCheck } from "../store/types";
import { type FixContext, fixFor } from "./machineFixes";

const COPIED_MS = 2000;

const GLYPH = { ok: "✓", warn: "!", block: "✗" } as const;

/** The doctor's checks as rows: ✓ passing, ! a failing warn, ✗ a failing block, with the fix. */
export function CheckRows({
  checks,
  ctx,
  label,
}: {
  checks: readonly MachineCheck[];
  ctx: FixContext;
  label: string;
}) {
  return (
    <ul className="m-checks" aria-label={label}>
      {checks.map((c) => {
        const state = c.ok ? "ok" : c.severity;
        const fix = c.ok ? null : fixFor(c.id, ctx);
        return (
          <li
            key={c.id}
            className={`m-check m-check--${state}`}
            aria-label={`${c.id}: ${c.detail}`}
          >
            <span className="m-glyph" aria-hidden="true">
              {GLYPH[state]}
            </span>
            <span className="m-check-id mono">{c.id}</span>
            <span className="m-check-detail">{c.detail}</span>
            {fix && (
              <div className="m-fix">
                <span className="s-hint">{fix.text}</span>
                {fix.command && <CopyCommand text={fix.command} ready />}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function CopyCommand({ text, ready }: { text: string; ready: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), COPIED_MS);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="m-command recessed">
      <code className="mono">
        {text.split(" ").map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the words of one fixed command
          <Fragment key={i}>
            {i > 0 && " "}
            {w.startsWith("-") ? <span className="m-flag">{w}</span> : w}
          </Fragment>
        ))}
      </code>
      <button type="button" className="btn" disabled={!ready} onClick={() => void copy()}>
        <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.8} />
        {state === "copied" ? "Copied" : state === "failed" ? "Select it to copy" : "Copy"}
      </button>
    </div>
  );
}
