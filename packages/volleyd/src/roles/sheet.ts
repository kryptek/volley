/**
 * The plan sheet: `role_plan`'s answer (SPEC §4.6.24) as the text a person reads before a move.
 * One renderer, so `volley role move` and the Desk (which imports `volleyd/roles/sheet`) show the
 * same sheet: what runs where, what blocks the move and how to fix it, the commands only a
 * terminal can run, and what changes for the owner afterwards. Pure: the wire shape in, lines out.
 */

/** `role_plan`'s `result` (`planWire` in engine.ts), as it arrives over the wire. */
export interface PlanSheet {
  role: string;
  from: string;
  to: string;
  plan_id: string;
  steps: { id: string; title: string; where: string }[];
  blocked: { why: string; fix?: string }[];
  warnings: string[];
  terminal: { where: string; reason: string; command: string }[];
  after: string[];
}

/** The sheet's lines, without trailing newlines. */
export function renderSheet(p: PlanSheet): string[] {
  const out = [`Move the ${p.role} from ${p.from} to ${p.to} (plan ${p.plan_id})`, ""];
  out.push("Steps:");
  p.steps.forEach((s, i) => out.push(`  ${i + 1}. on ${s.where}: ${s.title}`));
  if (p.blocked.length > 0) {
    out.push("", "Blocked:");
    for (const b of p.blocked) {
      out.push(`  ✗ ${b.why}`);
      if (b.fix !== undefined) out.push(`    fix: ${b.fix}`);
    }
  }
  if (p.warnings.length > 0) {
    out.push("", "Warnings:");
    for (const w of p.warnings) out.push(`  ! ${w}`);
  }
  if (p.terminal.length > 0) {
    out.push("", "Commands to run in a terminal:");
    for (const t of p.terminal) out.push(`  on ${t.where} (${t.reason}):`, `    ${t.command}`);
  }
  if (p.after.length > 0) {
    out.push("", "Afterwards:");
    for (const a of p.after) out.push(`  · ${a}`);
  }
  return out;
}

/** Whether `p` is a `role_plan` result this renderer can show. */
export function isPlanSheet(p: unknown): p is PlanSheet {
  if (typeof p !== "object" || p === null) return false;
  const r = p as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const objects = (v: unknown, keys: string[]) =>
    Array.isArray(v) &&
    v.every(
      (x) =>
        typeof x === "object" &&
        x !== null &&
        keys.every((k) => typeof (x as Record<string, unknown>)[k] === "string"),
    );
  return (
    typeof r.role === "string" &&
    typeof r.from === "string" &&
    typeof r.to === "string" &&
    typeof r.plan_id === "string" &&
    objects(r.steps, ["id", "title", "where"]) &&
    objects(r.blocked, ["why"]) &&
    strings(r.warnings) &&
    objects(r.terminal, ["where", "reason", "command"]) &&
    strings(r.after)
  );
}
