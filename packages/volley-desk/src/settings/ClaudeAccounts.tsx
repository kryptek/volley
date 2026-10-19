/**
 * Settings › Claude accounts & usage, ported from the prototype
 * `ClaudeAccounts` (SPEC §4.6.11–12). One card per account (the supervisor's
 * retained usage records, plus registry profiles that have not reported yet,
 * and this machine's own login, the primary, first and from the start):
 * label, machine, plan chip, the 5-hour and weekly meters with their resets,
 * the agents and waves on it, and "Move a wave here…". An open
 * `account_limit` decision is a Needs-you banner whose Move / Not now answer
 * it (`resolve`); volleyd moves a wave only by such an answer, so "Move a wave
 * here…" lists the waves that have one open. **Add Claude account** is a
 * Stepper: a label, then "Sign in on this machine" (`claude_account_add`;
 * volleyd adds profiles on its own machine only, so a remote host gets the
 * `volley claude add` hint), then "Open Anthropic sign-in ↗" with the link
 * from the `claude_signin_url` event, waiting until `claude_signin_done`. The Desk shows only the provider's sign-in link, never
 * a credential. Defaults: the account for new waves (`claude.default_account`,
 * through config_set) and the warn-at threshold from config.
 */
import { useEffect, useState } from "react";
import { plural } from "../lib/plural";
import Stepper, { Step } from "../rb/Stepper/Stepper";
import type { ControlReply } from "../steer/transport";
import {
  type AccountInfo,
  LOCAL_MACHINE,
  type RegistryAccount,
  accountList,
  fiveHourLabel,
  moveAnswer,
  notNowAnswer,
  openLimitDecisions,
  resetsIn,
  resolveFields,
} from "../store/claude";
import type {
  ClaudeAccountPayload,
  ClaudeSignin,
  ConfigPayload,
  DecisionPayload,
  UsageWindow,
  WaveView,
} from "../store/types";
import { AckLine, type RowState } from "./ConfigRows";
import type { ConfigTransport } from "./configTransport";
import { Group, Row, Seg } from "./primitives";

/** A volleyd control request (the steering transport's `control`). */
export type ControlFn = (
  op: string,
  fields: Record<string, unknown>,
  text?: string,
  timeoutMs?: number,
) => Promise<ControlReply>;

/** `claude_account_add` answers once the sign-in URL is known; the login starts first. */
export const ADD_ACCOUNT_TIMEOUT_MS = 60_000;
/** volleyd's default `claude.warn_at_pct`. */
const WARN_AT_DEFAULT = 90;
const CLAUDE_TINT = "#d97757";
/** Meter tones for a rate-limit window (the prototype's). */
const METER_HOT = 90;
const METER_WARN = 70;

/** volleyd answers `agent_move_account` after the respawn; stopping alone may take a minute. */
export const MOVE_ACCOUNT_TIMEOUT_MS = 120_000;
/** How often the "resets in" times re-read the clock. */
const CLOCK_TICK_MS = 30_000;

/** The clock, ticking while the section is open; a fixed `now` (tests) never ticks. */
function useNow(fixed: number | undefined): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, [fixed]);
  return fixed ?? now;
}

/**
 * volleyd's profile registry (`claude_accounts`), fetched when the Desk can ask
 * and again whenever `refresh` changes (a sign-in finished, the dialog closed).
 */
export function useClaudeRegistry(control: ControlFn | null, refresh = 0): RegistryAccount[] {
  const [registry, setRegistry] = useState<RegistryAccount[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the re-fetch trigger
  useEffect(() => {
    if (!control) return;
    let live = true;
    void control("claude_accounts", {}, "volley claude list").then((r) => {
      const rows = (r.result as { accounts?: unknown } | undefined)?.accounts;
      if (live && r.ok && Array.isArray(rows)) setRegistry(rows as RegistryAccount[]);
    });
    return () => {
      live = false;
    };
  }, [control, refresh]);
  return registry;
}

/** How many sign-ins have finished: a registry refresh key. */
export const signinsDone = (signins: Record<string, ClaudeSignin> | undefined) =>
  Object.values(signins ?? {}).filter((s) => s.state === "done").length;

export interface ClaudeAccountsProps {
  /** `volley/_system/claude-accounts/+`, by account. */
  accounts: Record<string, ClaudeAccountPayload>;
  /** Sign-in events heard since the page loaded, by account. */
  signins: Record<string, ClaudeSignin>;
  /** The waves, for their open `account_limit` decisions. */
  waves: Record<string, WaveView>;
  config: ConfigPayload | null;
  /** `null` = the Desk cannot steer: read-only, with the CLI commands instead. */
  control: ControlFn | null;
  configTransport: ConfigTransport | null;
  /** Clock override (tests). */
  now?: number;
  /** Hears each registry fetch, so the agent windows can list profiles with no usage yet. */
  onRegistry?: (rows: RegistryAccount[]) => void;
}

const machineName = (m: string) => (m === LOCAL_MACHINE ? "this machine" : m);

/** volleyd's id for Claude Code's default profile on its own machine. */
const PRIMARY = "primary";
/** How the primary's card names it: never just "primary", which reads as one more profile. */
export const PRIMARY_LABEL = "This machine's Claude login";

/**
 * The list with this machine's own login first. It is always there (agents run on it by
 * default), but it has a card only once it reports usage, so until then one is made up for it:
 * an owner who adds a profile must not read the missing card as their login gone.
 */
function withPrimary(list: AccountInfo[]): AccountInfo[] {
  const own = list.find((a) => a.id === PRIMARY);
  const primary: AccountInfo =
    own === undefined
      ? {
          id: PRIMARY,
          label: PRIMARY_LABEL,
          machine: LOCAL_MACHINE,
          plan: null,
          fiveHour: null,
          weekly: null,
          agents: [],
          waves: [],
        }
      : { ...own, label: own.label === PRIMARY ? PRIMARY_LABEL : own.label };
  return [primary, ...list.filter((a) => a !== own)];
}

function Meter({ label, w, now }: { label: string; w: UsageWindow | null; now: number }) {
  const pct = w === null ? null : Math.round(w.pct);
  const tone = pct === null ? "none" : pct >= METER_HOT ? "hot" : pct >= METER_WARN ? "warn" : "ok";
  const reset = resetsIn(w?.resets_at, now);
  return (
    <div className="meter">
      <div className="meter-top">
        <span>{label}</span>
        <span className={`mono meter-pct meter-${tone}`}>{pct === null ? "—" : `${pct}%`}</span>
      </div>
      <div
        className="meter-bar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? 0}
        aria-valuetext={pct === null ? "no usage reported yet" : `${pct}%`}
      >
        <span className={`meter-${tone}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="s-hint">
        {pct === null
          ? "no usage reported yet"
          : reset
            ? `resets in ${reset}`
            : "reset time unknown"}
      </div>
    </div>
  );
}

/** One account's card. */
function AccountCard({
  a,
  movable,
  onMove,
  now,
}: {
  a: AccountInfo;
  /** Open `account_limit` decisions on other accounts: the waves that can move here. */
  movable: DecisionPayload[];
  onMove: ((d: DecisionPayload) => void) | null;
  now: number;
}) {
  return (
    <article className="claude-card" aria-label={a.label}>
      <div className="cc-head">
        <span className="tile" style={{ background: CLAUDE_TINT }} aria-hidden="true">
          ✳
        </span>
        <div className="min0">
          <b>{a.label}</b>
          <div className="s-hint ell">
            {a.id === PRIMARY
              ? `${PRIMARY} · Claude Code's default login`
              : `${a.id} · ${machineName(a.machine)}`}
          </div>
        </div>
        {a.plan && <span className="chip">{a.plan}</span>}
      </div>
      <Meter label="5-hour window" w={a.fiveHour} now={now} />
      <Meter label="This week" w={a.weekly} now={now} />
      <div className="cc-move">
        <span className="s-hint">Use for</span>
        <select
          aria-label={`Move a wave to ${a.label}`}
          title={
            movable.length
              ? "Answers the wave's account-limit decision: new agents start on this account"
              : "volleyd moves a wave when its account nears the limit (Needs-you)"
          }
          value=""
          disabled={!onMove || movable.length === 0}
          onChange={(e) => {
            const d = movable.find((x) => x.wave === e.target.value);
            if (d) onMove?.(d);
          }}
        >
          <option value="">
            {movable.length ? "Move a wave here…" : "No wave waiting to move"}
          </option>
          {movable.map((d) => (
            <option key={d.decision_id} value={d.wave}>
              {d.wave}
            </option>
          ))}
        </select>
      </div>
      <div className="cc-foot">
        <span>{plural(a.agents.length, "agent")}</span>
        <span className="dim">
          {a.waves.length ? `waves: ${a.waves.join(", ")}` : "no waves assigned"}
        </span>
      </div>
    </article>
  );
}

type Adding =
  | { phase: "pick"; label: string; error?: string }
  | { phase: "waiting"; label: string; machine: string; acct?: string; url?: string };

/** The add-account Stepper: machine → Anthropic's sign-in page → done. */
function AddAccount({
  remotes,
  signins,
  control,
  onClose,
}: {
  /** Remote hosts seen in the account list: volleyd adds profiles on its own machine only. */
  remotes: string[];
  signins: Record<string, ClaudeSignin>;
  control: ControlFn;
  onClose: () => void;
}) {
  const [s, setS] = useState<Adding>({ phase: "pick", label: "" });
  const signin = s.phase === "waiting" && s.acct ? signins[s.acct] : undefined;
  const done = signin?.state === "done";
  const url = signin?.url ?? (s.phase === "waiting" ? s.url : undefined);

  const start = async (machine: string) => {
    const label = s.label.trim();
    if (!label) return;
    setS({ phase: "waiting", label, machine });
    const r = await control(
      "claude_account_add",
      { label, machine },
      `volley claude add "${label}"`,
      ADD_ACCOUNT_TIMEOUT_MS,
    );
    const res = (r.result ?? {}) as { acct?: unknown; account?: unknown; url?: unknown };
    const acct = typeof res.acct === "string" ? res.acct : res.account;
    if (!r.ok || typeof acct !== "string") {
      setS({ phase: "pick", label, error: r.error ?? "volleyd did not start the sign-in" });
      return;
    }
    setS((cur) =>
      cur.phase === "waiting"
        ? { ...cur, acct, ...(typeof res.url === "string" ? { url: res.url } : {}) }
        : cur,
    );
  };

  return (
    <div className="pair claude-add">
      <Stepper
        theme="dark"
        accentColor={CLAUDE_TINT}
        indicator="numbers"
        linear
        frame={false}
        width="100%"
        step={s.phase === "pick" ? 1 : done ? 3 : 2}
        disableStepIndicators
        showFooter={false}
      >
        <Step title="Machine" description="Where it runs">
          <h3>Add a Claude account</h3>
          <p className="dim">
            You sign in on Anthropic’s own page; volleyd does the rest on the machine you pick.
            Volley never sees your password or your login.
          </p>
          <input
            className="recessed claude-add-label"
            aria-label="Account label"
            placeholder="Label, e.g. Work"
            value={s.label}
            onChange={(e) => setS({ phase: "pick", label: e.target.value })}
          />
          {remotes.length > 0 && (
            <p className="s-hint">
              To add one on {remotes.join(", ")}, run <code>volley claude add</code> there: each
              machine's volleyd adds its own.
            </p>
          )}
          {s.phase === "pick" && s.error && (
            <p className="s-error" role="alert">
              {s.error}
            </p>
          )}
          <div className="ny-actions">
            <button
              type="button"
              className="btn btn--blue"
              disabled={!s.label.trim()}
              onClick={() => void start(LOCAL_MACHINE)}
            >
              Sign in on {machineName(LOCAL_MACHINE)}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </Step>
        <Step title="Sign in" description="Anthropic’s page">
          <h3>Sign in with the account you want to add</h3>
          {url && (
            <div className="ny-actions">
              <a className="btn btn--blue" href={url} target="_blank" rel="noreferrer">
                Open Anthropic sign-in ↗
              </a>
            </div>
          )}
          <p className="dim">
            The page hands the sign-in straight back to Claude Code on{" "}
            {machineName(s.phase === "waiting" ? s.machine : LOCAL_MACHINE)}: open it in a browser
            there.
            {signin?.flow === "manual_code" &&
              ` If it shows a code, paste it into the sign-in terminal${signin.attach ? ` (tmux attach -t ${signin.attach})` : ""}, never here.`}
          </p>
          {signin?.state === "failed" ? (
            <p className="s-error" role="alert">
              The sign-in did not finish: {signin.reason ?? "unknown reason"}
            </p>
          ) : (
            <div className="waiting">
              <span className="spinner" aria-hidden="true" /> Waiting for the sign-in to finish…
            </div>
          )}
          <div className="ny-actions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </Step>
        <Step title="Done" description="Added">
          <h3>Added: {s.label}</h3>
          <p className="dim">
            {signin?.plan ? `${signin.plan} · ` : ""}signed in on{" "}
            {machineName(s.phase === "waiting" ? s.machine : LOCAL_MACHINE)}. Pick it for new waves
            below, or let them take the account with the most headroom.
          </p>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </Step>
      </Stepper>
    </div>
  );
}

export function ClaudeAccounts({
  accounts: records,
  signins,
  waves,
  config,
  control,
  configTransport,
  now: fixedNow,
  onRegistry,
}: ClaudeAccountsProps) {
  const [adding, setAdding] = useState(false);
  const [closed, setClosed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** A resolve in flight: the answers stay disabled so a double click sends one. */
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState<RowState>();
  const now = useNow(fixedNow);
  const registry = useClaudeRegistry(control, signinsDone(signins) + closed);
  useEffect(() => {
    if (registry.length) onRegistry?.(registry);
  }, [registry, onRegistry]);

  const list = withPrimary(accountList(records, registry));
  const labelOf = (id: string | null | undefined) =>
    list.find((a) => a.id === id)?.label ?? id ?? "";
  const decisions = openLimitDecisions(waves);
  const remotes = [...new Set(list.map((a) => a.machine).filter((m) => m !== LOCAL_MACHINE))];

  const answer = async (d: DecisionPayload, text: string) => {
    if (!control || busy) return;
    setError(null);
    setBusy(true);
    const r = await control("resolve", resolveFields(d, text), `volleyd resolve ${d.decision_id}`);
    setBusy(false);
    if (!r.ok) setError(r.error ?? "volleyd refused the answer");
  };

  const setDefault = (k: string) => {
    if (!configTransport) return;
    setAck({ state: "sending" });
    void configTransport
      .send({ claude: { default_account: k } })
      .then((a) => setAck({ state: "done", ...a }));
  };

  const warnAt = config?.claude?.warn_at_pct ?? WARN_AT_DEFAULT;
  const current = config?.claude?.default_account ?? PRIMARY;
  const defaults: [string, string][] = [
    ["most_headroom", "Most headroom"],
    // The Seg's options are short; the card names it in full.
    [PRIMARY, labelOf(PRIMARY) === PRIMARY_LABEL ? "Primary" : labelOf(PRIMARY)],
    ...list
      .filter((a) => a.machine === LOCAL_MACHINE && a.id !== PRIMARY && !a.id.includes("@"))
      .map((a): [string, string] => [a.id, a.label]),
  ];
  if (!defaults.some(([k]) => k === current)) defaults.push([current, current]);

  return (
    <>
      {!control && (
        <p className="s-note">
          Read-only: the Desk has no broker credentials. <code>volley claude add</code> adds an
          account from a terminal.
        </p>
      )}
      {decisions.map((d) => {
        const target = d.suggested ? list.find((a) => a.id === d.suggested) : undefined;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a banner live region (as in the prototype), not a form <output>
          <div key={d.decision_id} className="needs-you" role="status">
            <div className="ny-head">
              Needs you: {labelOf(d.acct)} is at {Math.round(d.pct ?? 0)}% of its 5-hour window
            </div>
            <p className="ny-q">
              {d.suggested ? (
                <>
                  Move wave <b>{d.wave}</b> to <b>{labelOf(d.suggested)}</b>
                  {/* nothing until the Desk has the account (its record may arrive later) */}
                  {target === undefined
                    ? ""
                    : target.fiveHour
                      ? ` (${Math.round(target.fiveHour.pct)}% used)`
                      : ` (${fiveHourLabel(null, target.weekly?.pct ?? null)})`}
                  ? New agents start on {labelOf(d.suggested)}; running agents finish where they
                  are.
                </>
              ) : (
                <>
                  No other account has headroom for wave <b>{d.wave}</b>
                  {resetsIn(d.resets_at, now)
                    ? `; the window resets in ${resetsIn(d.resets_at, now)}`
                    : ""}
                  .
                </>
              )}
            </p>
            {control && (
              <div className="ny-actions">
                {d.suggested && (
                  <button
                    type="button"
                    className="btn btn--hot"
                    disabled={busy}
                    onClick={() => void answer(d, moveAnswer(d.wave, d.suggested as string))}
                  >
                    Move to {labelOf(d.suggested)}
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void answer(d, notNowAnswer(d))}
                >
                  Not now
                </button>
              </div>
            )}
          </div>
        );
      })}
      {error && (
        <p className="s-error" role="alert">
          {error}
        </p>
      )}
      <div className="claude-cards">
        {list.map((a) => (
          <AccountCard
            key={a.id}
            a={a}
            movable={decisions.filter((d) => d.acct !== a.id)}
            onMove={
              control && !busy && !a.id.includes("@")
                ? (d) => void answer(d, moveAnswer(d.wave, a.id))
                : null
            }
            now={now}
          />
        ))}
        <button
          type="button"
          className="claude-card claude-card--add"
          disabled={!control}
          onClick={() => setAdding(true)}
        >
          + Add Claude account
        </button>
      </div>
      {adding && control && (
        <AddAccount
          remotes={remotes}
          signins={signins}
          control={control}
          onClose={() => {
            setAdding(false);
            setClosed((n) => n + 1);
          }}
        />
      )}
      <Group title="Defaults">
        <Row label="Account for new waves" hint="A wave file's account: overrides it">
          {configTransport ? (
            <>
              <Seg
                label="Account for new waves"
                options={defaults}
                value={current}
                onPick={setDefault}
              />
              <AckLine s={ack} />
            </>
          ) : (
            <span className="mono s-hint">{defaults.find(([k]) => k === current)?.[1]}</span>
          )}
        </Row>
        <Row
          label="Warn me at"
          hint="Raises a Needs-you to move waves; nothing switches on its own"
        >
          <span className="mono s-hint">{warnAt}% of the 5-hour window</span>
        </Row>
      </Group>
    </>
  );
}
