/**
 * Pure views over the Desk's Claude account slices (SPEC §4.6.11–12): the
 * account list the Settings section, the agent window's picker and the wave
 * modal share, the open `account_limit` decisions, and the formatting of a
 * window's reset. Accounts come from two places: the supervisor's retained
 * usage records (`volley/_system/claude-accounts/+`, only accounts that have
 * reported usage) and, when the Desk can ask, the registry (`claude_accounts`
 * control op: profiles that have not reported yet, with their machine).
 */
import type { ClaudeAccountPayload, DecisionPayload, UsageWindow, WaveView } from "./types";

/** volleyd's own machine (`LOCAL_MACHINE` in its profiles). */
export const LOCAL_MACHINE = "local";

/** A registry row from the `claude_accounts` control op (only the fields the Desk shows). */
export interface RegistryAccount {
  id: string;
  label: string;
  machine: string;
  plan?: string;
  signed_in_at?: string;
  signin?: { state: string; url?: string };
}

/** One Claude account as the Desk shows it. */
export interface AccountInfo {
  id: string;
  label: string;
  /** `local` (volleyd's machine) or a remote host. */
  machine: string;
  plan: string | null;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  agents: string[];
  waves: string[];
}

/**
 * How a picker or a suggestion labels an account that has not reported usage (a newly signed-in
 * profile): available, never a reason to leave it out (SPEC §4.6.12).
 */
export const NO_USAGE_YET = "no usage yet";

/** An account that reported weekly usage but no 5-hour window: "no usage yet" would be untrue. */
export const NO_FIVE_HOUR_YET = "no 5-hour usage yet";

/** `34%`, or why there is no 5-hour percentage: what a picker or a suggestion shows. */
export function fiveHourLabel(fivePct: number | null, weeklyPct: number | null): string {
  if (fivePct !== null) return `${Math.round(fivePct)}%`;
  return weeklyPct !== null ? NO_FIVE_HOUR_YET : NO_USAGE_YET;
}

/** What the agent window's picker lists. */
export interface AccountChoice {
  id: string;
  label: string;
  /** The 5-hour window's pct, or `null` until the account reports usage. */
  fivePct: number | null;
  /** The weekly window's pct, or `null` until the account reports it. */
  weeklyPct: number | null;
}

/** `primary@gpu-box` → `gpu-box`: a remote host's own login. */
function hostOf(account: string): string {
  const at = account.indexOf("@");
  return at < 0 ? LOCAL_MACHINE : account.slice(at + 1);
}

/** The usage records merged over the registry rows: records first, then registry-only accounts. */
export function accountList(
  records: Record<string, ClaudeAccountPayload> | undefined,
  registry: readonly RegistryAccount[] = [],
): AccountInfo[] {
  const reg = new Map(registry.map((r) => [r.id, r]));
  const out: AccountInfo[] = Object.values(records ?? {}).map((r) => {
    const row = reg.get(r.account);
    return {
      id: r.account,
      label: r.label ?? row?.label ?? r.account,
      machine: row?.machine ?? hostOf(r.account),
      plan: r.plan ?? row?.plan ?? null,
      fiveHour: r.five_hour,
      weekly: r.weekly,
      agents: r.agents,
      waves: r.waves,
    };
  });
  for (const row of registry) {
    if (records?.[row.id]) continue;
    out.push({
      id: row.id,
      label: row.label,
      machine: row.machine,
      plan: row.plan ?? null,
      fiveHour: null,
      weekly: null,
      agents: [],
      waves: [],
    });
  }
  return out;
}

export function accountChoices(accounts: readonly AccountInfo[]): AccountChoice[] {
  return accounts.map((a) => ({
    id: a.id,
    label: a.label,
    fivePct: a.fiveHour?.pct ?? null,
    weeklyPct: a.weekly?.pct ?? null,
  }));
}

/** Every unresolved `account_limit` decision, oldest first. */
export function openLimitDecisions(waves: Record<string, WaveView>): DecisionPayload[] {
  return Object.values(waves)
    .flatMap((w) => Object.values(w.decisions))
    .filter((d) => d.kind === "account_limit" && !d.resolved && typeof d.acct === "string")
    .sort((a, b) => a.opened_at.localeCompare(b.opened_at));
}

/** volleyd's answer that moves a wave (`moveAnswer` in its usage module). */
export const moveAnswer = (wave: string, to: string) => `move wave ${wave} to ${to}`;

/** The decision's "not now" option (volleyd always offers it). */
export function notNowAnswer(d: DecisionPayload): string {
  return d.options?.find((o) => /^not now$/i.test(o)) ?? "not now";
}

/** The `resolve` control fields that answer `d`. */
export function resolveFields(d: DecisionPayload, answer: string) {
  return { wave: d.wave, decision_id: d.decision_id, answer };
}

/** `4h 4m`, `38m`, `2d 18h`; `null` when the reset is unknown or has passed. */
export function resetsIn(resetsAt: string | null | undefined, now: number): string | null {
  const t = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (Number.isNaN(t) || t <= now) return null;
  const m = Math.floor((t - now) / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
