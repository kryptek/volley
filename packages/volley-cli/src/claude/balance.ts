import { maskEmail } from "volley-mcp/mask";
import { untilLabel } from "volleyd/claude/usage";
import type { UsageRecord } from "./groups";

/**
 * `volley claude balance`: volleyd's `claude_balance` answer (SPEC §4.6.11) as a table, one block
 * per machine, its candidates in volleyd's rank order with their figures, the window that binds
 * each (its room left and when it resets, or `over cap`) and agents, and an arrow on the account each model family (or `--model`) would start on next. The figures
 * are volleyd's; the e-mail and the Fable window come from the account's retained usage record
 * (a ranking without a model carries no family window). Pure.
 */

/** One candidate as volleyd ranked it (`Ranked` in its usage module). */
export interface BalanceCandidate {
  account: string;
  headroom: number | null;
  five_hour_pct: number | null;
  weekly_pct: number | null;
  model_weekly_pct?: number;
  agents: number;
  /** The rank rule's fields; absent from a volleyd that predates them. */
  score?: number | null;
  binding?: "five_hour" | "weekly" | "model_weekly" | null;
  eligible?: boolean;
  binding_left?: number | null;
  binding_resets_at?: string | null;
  /** Agents counted against it, and its binding window's projection with them (SPEC §4.6.12). */
  in_flight?: number;
  projected_pct?: number | null;
}

export interface BalanceAnswer {
  model?: string;
  machines: {
    name: string;
    candidates: BalanceCandidate[];
    /** The pick per model family, or `model` when one was asked for; `null`: no candidate. */
    picks: Record<string, string | null>;
  }[];
}

const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
const LOCAL_MACHINE = "local";
const where = (machine: string) => (machine === LOCAL_MACHINE ? "this machine" : machine);

/** The picks keys whose next spawn the answer puts on `account` (`model`: the asked model). */
function picksOf(answer: BalanceAnswer | null, account: string): string[] {
  const keys = new Set<string>();
  for (const m of answer?.machines ?? [])
    for (const [k, v] of Object.entries(m.picks ?? {})) if (v === account) keys.add(k);
  return [...keys];
}

/** Whether any model family's next spawn runs under `account`: `volley claude list`'s marker. */
export const isNextPick = (answer: BalanceAnswer | null, account: string) =>
  picksOf(answer, account).length > 0;

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n)}%`);

const WINDOW_LABEL = { five_hour: "5h", weekly: "7d", model_weekly: "model" } as const;

/** ` (12% after 3 in flight)` when agents in flight move the binding window's projection. */
function inFlight(c: BalanceCandidate, used: boolean): string {
  const p = c.projected_pct;
  if (!c.in_flight || p == null || (c.binding_left != null && p === 100 - c.binding_left))
    return "";
  return ` (${pct(used ? p : 100 - p)} after ${c.in_flight} in flight)`;
}

/**
 * `5h 18% left in 52m`, with `(12% after 3 in flight)` when agents in flight move it; `over cap`;
 * `headroom N` from a volleyd that predates the rank rule.
 */
function bindingFigure(c: BalanceCandidate, family: string | undefined, now: number): string {
  if (c.eligible === false) return `over cap${inFlight(c, true)}`;
  if (c.binding == null || c.binding_left == null)
    return `headroom ${c.headroom === null ? "—" : Math.round(c.headroom)}`;
  const label =
    c.binding === "model_weekly" && family !== undefined
      ? `${family.charAt(0).toUpperCase()}${family.slice(1)}`
      : WINDOW_LABEL[c.binding];
  return `${label} ${pct(c.binding_left)} left in ${untilLabel(c.binding_resets_at ?? null, now)}${inFlight(c, false)}`;
}

/** Columns padded to the widest cell of each, joined by two spaces. */
function table(rows: string[][]): string[] {
  const widths = rows.reduce<number[]>(
    (w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)),
    [],
  );
  return rows.map((r) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

export function printBalance(
  answer: BalanceAnswer,
  records: readonly UsageRecord[],
  { showEmail, now = Date.now() }: { showEmail: boolean; now?: number },
): string {
  const byAccount = new Map(records.map((r) => [r.account, r]));
  const family = FAMILIES.find((f) => answer.model?.includes(f));
  let out = "";
  for (const m of answer.machines) {
    out += `${where(m.name)}\n`;
    const rows = m.candidates.map((c) => {
      const rec = byAccount.get(c.account);
      const fable = family === "fable" ? c.model_weekly_pct : rec?.model_weekly?.fable?.pct;
      const none = c.headroom === null && c.five_hour_pct === null && c.weekly_pct === null;
      const picks = picksOf({ machines: [m] }, c.account).map((k) =>
        k === "model" ? (answer.model ?? k) : k,
      );
      return {
        account: c.account,
        email: rec?.email ? (showEmail ? rec.email : maskEmail(rec.email)) : "",
        figures: none
          ? null
          : [
              `5h ${pct(c.five_hour_pct)}`,
              `7d ${pct(c.weekly_pct)}`,
              `Fable ${pct(fable)}`,
              bindingFigure(c, family, now),
            ],
        // Beside `no usage yet` too: an account with running agents and no reading is not idle.
        agents: `${c.agents} agent${c.agents === 1 ? "" : "s"}`,
        arrow: picks.length ? `← ${picks.join(", ")}` : "",
      };
    });
    // "no usage yet" spans the figure columns, so the arrows still line up.
    const known = table(rows.flatMap((r) => (r.figures ? [r.figures] : [])));
    let k = 0;
    const figures = rows.map((r) => (r.figures ? (known[k++] ?? "") : "no usage yet"));
    const width = Math.max(0, ...figures.map((f) => f.length));
    const emails = rows.some((r) => r.email !== "");
    const lines = table(
      rows.map((r, i) => [
        r.account,
        ...(emails ? [r.email] : []),
        (figures[i] ?? "").padEnd(width),
        r.agents,
        r.arrow,
      ]),
    );
    if (m.candidates.length === 0) out += "  no signed-in accounts\n";
    for (const l of lines) out += `  ${l}\n`;
  }
  return out;
}
