/**
 * Settings › Autopilot (SPEC §4.6.16–17): every `autopilot.*` tunable as D5's
 * schema-driven rows (`ConfigRows`; `owner_only` is a multi-select of decision
 * kinds), and the policy table volleyd answers itself from, read through the
 * `policy` control op (what `volleyd policy` prints) as a read-only table:
 * kind · condition · answer · budget · rationale, in the order rules are tried.
 *
 * The global scope writes through config_set; a wave's scope (`wave` and its
 * `effective_config` as `values`) is read-only, as every wave row is, and asks
 * for that wave's policy.
 */
import { useEffect, useState } from "react";
import { SwitchToAdmin } from "../auth/AccountActions";
import type { ConfigPayload, Tunables } from "../store/types";
import type { ControlFn } from "./ClaudeAccounts";
import { ConfigRows } from "./ConfigRows";
import type { ConfigTransport } from "./configTransport";
import { Group } from "./primitives";

/** The prototype's macOS accent, as Settings › Supervisor uses. */
const ACCENT = "#0a84ff";
const AUTOPILOT_SECTIONS = ["Autopilot"] as const;

export const POLICY_COLUMNS = ["kind", "condition", "answer", "budget", "rationale"] as const;

/** One row of volleyd's policy table (`policy` op `result.rules[]`). */
export interface PolicyRow {
  policy: string;
  kind: string;
  condition: string;
  answer: string;
  /** `<budget> per <scope>`, or null for a rule with none. */
  budget: string | null;
  max: number | null;
  rationale: string;
}

type PolicyState =
  | { state: "loading" }
  | { state: "done"; rules: PolicyRow[] }
  | { state: "failed"; error: string };

const isRow = (r: unknown): r is PolicyRow =>
  !!r &&
  typeof r === "object" &&
  ["kind", "condition", "answer", "rationale"].every(
    (k) => typeof (r as Record<string, unknown>)[k] === "string",
  );

function usePolicy(control: ControlFn | null, wave: string | undefined): PolicyState | null {
  const [policy, setPolicy] = useState<PolicyState>({ state: "loading" });
  useEffect(() => {
    if (!control) return;
    let live = true;
    setPolicy({ state: "loading" });
    const fields = wave !== undefined ? { wave } : {};
    void control("policy", fields, wave ? `volleyd policy ${wave}` : "volleyd policy").then((r) => {
      if (!live) return;
      const rules = (r.result as { rules?: unknown } | undefined)?.rules;
      if (r.ok && Array.isArray(rules)) setPolicy({ state: "done", rules: rules.filter(isRow) });
      else setPolicy({ state: "failed", error: r.error ?? "volleyd sent no policy table" });
    });
    return () => {
      live = false;
    };
  }, [control, wave]);
  return control ? policy : null;
}

const budgetCell = (r: PolicyRow) =>
  r.budget === null ? "—" : `${r.budget}${r.max !== null ? ` · max ${r.max}` : ""}`;

/** Column widths (%): rationale gets the most room; every cell wraps within its column. */
const POLICY_WIDTHS: Record<(typeof POLICY_COLUMNS)[number], number> = {
  kind: 22,
  condition: 22,
  answer: 14,
  budget: 14,
  rationale: 28,
};

/** A comma-joined kind list may break after each comma (`<wbr>`); its text is unchanged. */
function breakAfterCommas(s: string) {
  const parts = s.split(",");
  return parts.map((p, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string, never reordered
    <span key={i}>
      {p}
      {i < parts.length - 1 && (
        <>
          ,<wbr />
        </>
      )}
    </span>
  ));
}

/**
 * The table fits the pane at the Settings window's default size (fixed columns,
 * wrapping cells) and scrolls inside `.policy-scroll` if the pane is narrower;
 * at phone width CSS swaps it for `.policy-stack`, one block per rule.
 */
export function PolicyTable({ rules }: { rules: readonly PolicyRow[] }) {
  return (
    <>
      <div className="policy-scroll">
        <PolicyGrid rules={rules} />
      </div>
      <div className="policy-stack">
        {rules.map((r) => (
          <section key={r.policy} className="policy-rule" title={r.policy}>
            <h4 className="policy-rule-kind mono policy-wrap">{breakAfterCommas(r.kind)}</h4>
            <dl>
              <dt>condition</dt>
              <dd className="policy-wrap">{r.condition}</dd>
              <dt>answer</dt>
              <dd className="mono policy-wrap">{r.answer}</dd>
              <dt>budget</dt>
              <dd className="mono dim policy-wrap">{budgetCell(r)}</dd>
              <dt>rationale</dt>
              <dd className="policy-wrap">{r.rationale}</dd>
            </dl>
          </section>
        ))}
      </div>
    </>
  );
}

function PolicyGrid({ rules }: { rules: readonly PolicyRow[] }) {
  return (
    <table className="policy-table" aria-label="Autopilot policy">
      <colgroup>
        {POLICY_COLUMNS.map((c) => (
          <col key={c} style={{ width: `${POLICY_WIDTHS[c]}%` }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {POLICY_COLUMNS.map((c) => (
            <th key={c} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => (
          <tr key={r.policy} title={r.policy}>
            <td className="mono policy-wrap">{breakAfterCommas(r.kind)}</td>
            <td className="policy-wrap">{r.condition}</td>
            <td className="mono policy-wrap">{r.answer}</td>
            <td className="mono dim policy-wrap">{budgetCell(r)}</td>
            <td className="policy-wrap">{r.rationale}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface AutopilotProps {
  /** The retained `volley/_waves/_config` payload (the global scope's values). */
  config: ConfigPayload | null;
  /** `null` = no broker credentials: read-only with copyable commands. */
  transport: ConfigTransport | null;
  /** volleyd's control channel, for the `policy` op; `null`: the Desk cannot ask. */
  control: ControlFn | null;
  /** A wave's scope: its policy, and its effective config (`values`) read-only. */
  wave?: string;
  values?: Tunables | null;
}

export function Autopilot({ config, transport, control, wave, values }: AutopilotProps) {
  const policy = usePolicy(control, wave);
  const scoped = wave !== undefined;
  const cmd = scoped ? `volleyd policy ${wave}` : "volleyd policy";
  return (
    <>
      <ConfigRows
        scope={scoped ? "wave" : "global"}
        sections={AUTOPILOT_SECTIONS}
        values={scoped ? (values ?? null) : config}
        transport={transport}
        accent={ACCENT}
        {...(scoped
          ? {}
          : {
              foot: "Saved through volleyd config set · applies from the next decision on. A kind under Owner only always waits for the owner.",
            })}
      />
      <Group title="Policy table">
        {policy === null ? (
          <p className="s-hint">
            The Desk cannot ask volleyd without broker credentials: run <code>{cmd}</code> in a
            terminal. <SwitchToAdmin />
          </p>
        ) : policy.state === "loading" ? (
          <p className="s-hint dim">Asking volleyd…</p>
        ) : policy.state === "failed" ? (
          <p className="s-hint" role="alert">
            No policy table: {policy.error}. <code>{cmd}</code> prints it in a terminal.
          </p>
        ) : (
          <PolicyTable rules={policy.rules} />
        )}
      </Group>
    </>
  );
}
