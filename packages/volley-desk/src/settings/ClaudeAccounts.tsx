/**
 * Settings › Claude accounts & usage, ported from the prototype
 * `ClaudeAccounts` (SPEC §4.6.11–12). One card per Anthropic account: the
 * supervisor's retained usage records, registry profiles that have not
 * reported yet, signed-in peers and this machine's own login (the primary,
 * first and from the start), merged by the login's e-mail (`accountGroups`).
 * A card shows the label, plan chip and organisation, the e-mail masked until
 * its eye button reveals it (never persisted), three meters: 5-hour and 7-day
 * from the freshest reading (a disagreeing older one named stale) and Fable
 * (7-day) from the freshest usage probe reading, with its age, or why there is
 * none while the probe's last attempt failed (`fableHint`), one row per
 * configured machine (`accountMatrix`: a filled dot where it holds the account,
 * with the account's three figures compactly and that login's own age when
 * older, else **Sign in on <machine>**, which opens Add already at the sign-in step
 * with the label `<label> (<machine>)`) under an `on N of M machines` chip,
 * the agents and waves on it, and "Move a wave
 * here…" (its login on this machine, by account id). An open
 * `account_limit` decision is a Needs-you banner whose Move / Not now answer
 * it (`resolve`); volleyd moves a wave only by such an answer, so "Move a wave
 * here…" lists the waves that have one open. **Add Claude account** is a
 * Stepper: a label and the machine (this one, or any paired host whose tunnel
 * is up), then "Sign in on <machine>" (`claude_account_add { label, machine }`),
 * then the sign-in link from the answer and the `claude_signin_url` event (on
 * a peer, the same link and phone steps as Settings › Machines, `SigninLink`),
 * waiting until `claude_signin_done`. A card's **Add to another machine…**
 * opens it with the label suggested as `<label> (<machine>)` (following the
 * picked machine until the owner types) and the machines holding the account
 * greyed out. The Desk shows only the provider's sign-in link, never a
 * credential. Defaults: the account for new waves (`claude.default_account`,
 * through config_set) and the warn-at threshold from config.
 *
 * The section drills into two groups (`GroupList`): Accounts (the banners,
 * the cards and Add) and Defaults.
 */
import { EyeIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { maskEmail, normalizeEmail } from "../lib/email";
import { plural } from "../lib/plural";
import Stepper, { Step } from "../rb/Stepper/Stepper";
import type { ControlReply } from "../steer/transport";
import {
  type AccountGroup,
  type AccountMatrixRow,
  LOCAL_MACHINE,
  type MatrixCell,
  type MatrixMachine,
  type Member,
  PRIMARY_LABEL,
  type RegistryAccount,
  accountList,
  accountMatrix,
  configuredMachines,
  deskAccountGroups,
  fableHint,
  fableShown,
  fiveHourLabel,
  machineName,
  moveAnswer,
  moveTargetOf,
  notNowAnswer,
  openLimitDecisions,
  readingAge,
  resetsIn,
  resolveFields,
  usageTriple,
  windowPct,
  withPrimary,
} from "../store/claude";
import type {
  ClaudeAccountPayload,
  ClaudeSignin,
  ConfigPayload,
  DecisionPayload,
  MachinePayload,
  UsageWindow,
  WaveView,
} from "../store/types";
import { AckLine, type RowState } from "./ConfigRows";
import { GroupList } from "./GroupNav";
import { SigninLink } from "./PeerSigninSheet";
import type { ConfigTransport } from "./configTransport";
import { Group, Row, Seg } from "./primitives";
import { sectionDef } from "./sections";

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

/** What `claude_accounts` answers that the Desk shows. */
export interface ClaudeRegistry {
  accounts: RegistryAccount[];
  /** The primary's plan as volleyd's `claude auth status` reported it; absent: not known. */
  primaryPlan?: string;
}

/**
 * volleyd's profile registry (`claude_accounts`), fetched when the Desk can ask
 * and again whenever `refresh` changes (a sign-in finished, the dialog closed).
 */
export function useClaudeRegistry(control: ControlFn | null, refresh = 0): ClaudeRegistry {
  const [registry, setRegistry] = useState<ClaudeRegistry>({ accounts: [] });
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the re-fetch trigger
  useEffect(() => {
    if (!control) return;
    let live = true;
    void control("claude_accounts", {}, "volley claude list").then((r) => {
      const result = r.result as { accounts?: unknown; primary?: { plan?: unknown } } | undefined;
      const rows = result?.accounts;
      if (!live || !r.ok || !Array.isArray(rows)) return;
      const plan = result?.primary?.plan;
      setRegistry({
        accounts: rows as RegistryAccount[],
        ...(typeof plan === "string" && plan !== "" ? { primaryPlan: plan } : {}),
      });
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
  /** The machine records: a peer's default login's e-mail and sign-in state. */
  machines?: Record<string, MachinePayload>;
  /** The supervisor's own machine record's name (`_config` `fleet.local_name`). */
  localName?: string | undefined;
  /** The paired hosts (`_config` `hosts`): the machines Add can sign a profile in on. */
  hosts?: string[];
  /** The open group's page (`accounts`, `defaults`), or null for the group list. */
  group: string | null;
  onOpenGroup?: (group: string) => void;
  /** The group a sidebar search hit. */
  hit?: string | undefined;
}

/** The group list's one-line summaries. */
export function claudeSummaries({
  accounts,
  needsYou,
  defaultLabel,
  warnAt,
}: {
  accounts: number;
  /** Open `account_limit` decisions. */
  needsYou: number;
  /** How the account for new waves reads (`Most headroom`). */
  defaultLabel: string;
  warnAt: number;
}): Record<string, string> {
  return {
    accounts: `${plural(accounts, "account")}${needsYou ? ` · ${needsYou} needs you` : ""}`,
    defaults: `${defaultLabel} · warn at ${warnAt}%`,
  };
}

/** volleyd's id for Claude Code's default profile on its own machine. */
const PRIMARY = "primary";
export { PRIMARY_LABEL };

/**
 * One rate-limit window: its percentage (a reset that passed counts as 0), a bar, and when it
 * resets. `missingHint` says why there is no figure; `ageText` how old the figure is.
 */
function Meter({
  label,
  w,
  now,
  missingHint = "no usage reported yet",
  ageText,
}: {
  label: string;
  w: UsageWindow | null;
  now: number;
  missingHint?: string;
  ageText?: string;
}) {
  const pct = windowPct(w, now);
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
        aria-valuetext={pct === null ? missingHint : ageText ? `${pct}%, ${ageText}` : `${pct}%`}
      >
        <span className={`meter-${tone}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="s-hint">
        {pct === null
          ? missingHint
          : `${reset ? `resets in ${reset}` : "reset time unknown"}${ageText ? ` · ${ageText}` : ""}`}
      </div>
    </div>
  );
}

/** An account's three meters: 5-hour and 7-day (the freshest reading), and its Fable week. */
function Meters({ g, now }: { g: AccountGroup; now: number }) {
  const fable = fableShown(g);
  const hint = fableHint(g.probe, now);
  return (
    <div className="cc-meters">
      <Meter label="5-hour" w={g.fiveHour} now={now} />
      <Meter label="7-day" w={g.weekly} now={now} />
      <Meter
        label="Fable (7-day)"
        w={fable}
        now={now}
        missingHint={g.probe?.state === "ok" ? "no Fable window reported" : hint}
        {...(fable ? { ageText: hint } : {})}
      />
    </div>
  );
}

/** A machine row's compact usage: `5h 37% · 7d 56% · Fable 12%`, and `sampled 3 h ago` when older. */
export function UsageTriple({ text, sampled }: { text: string; sampled: string | null }) {
  return (
    <span className="cc-usage">
      <span className="mono">{text}</span>
      {sampled && <span className="dim"> · {sampled}</span>}
    </span>
  );
}

const WINDOW_NAME = { five_hour: "5-hour", weekly: "7-day" } as const;

/** An e-mail masked until its eye button shows it (per mount, never persisted). */
function MaskedEmail({ email }: { email: string }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <span className="mono ell">{shown ? email : maskEmail(email)}</span>
      <button
        type="button"
        className="icon-btn"
        aria-pressed={shown}
        aria-label={shown ? "Hide email" : "Show email"}
        onClick={() => setShown((v) => !v)}
      >
        <HugeiconsIcon icon={shown ? ViewOffIcon : EyeIcon} size={13} strokeWidth={1.8} />
      </button>
    </>
  );
}

/** The login's e-mail, masked until its eye button shows it (per card, never persisted). */
function EmailRow({ email }: { email: string | null }) {
  if (email === null)
    return <div className="s-hint">e-mail not reported yet (run the machine's doctor)</div>;
  return (
    <div className="cc-email">
      <MaskedEmail email={email} />
    </div>
  );
}

/** Why a machine row's Sign in is off: its tunnel is down; `null` when it can sign in. */
const offline = (c: { up: boolean }) => (c.up ? null : "tunnel down");

/**
 * A configured machine's row with no login on the account: an empty dot, and Sign in on it (off
 * while its tunnel is down; none when the Desk cannot steer). `other` is the e-mail a sign-in
 * started here finished with when it was not this account's.
 */
function MissingRow({
  c,
  account,
  other,
  onSignIn,
}: {
  c: MatrixCell;
  /** The card's account, for the button's name (every card may offer the same machine). */
  account: string;
  other: string | null;
  onSignIn: (() => void) | null;
}) {
  const why = offline(c);
  return (
    <li className="gap">
      <span className="cc-dot" aria-hidden="true" />
      <b>{c.name}</b>
      <span className="dim ell">
        {other ? `signed in as another account (${maskEmail(other)})` : `not on ${c.name}`}
      </span>
      {onSignIn && (
        <span className="cc-signin">
          {why && <span className="s-hint">{why}</span>}
          <button
            type="button"
            className="btn"
            disabled={why !== null}
            aria-label={`Sign in on ${c.name} with ${account}`}
            onClick={onSignIn}
          >
            Sign in on {c.name}
          </button>
        </span>
      )}
    </li>
  );
}

/** A sign-in the account matrix started: which account, on which machine, under which id. */
export interface SignInTry {
  /** The account group's key (its normalised e-mail). */
  key: string;
  op: string;
  label: string;
  acct: string;
}

/** One Anthropic account's card. */
function AccountCard({
  row,
  others,
  movable,
  onMove,
  onAdd,
  onSignInOn,
  now,
}: {
  row: AccountMatrixRow;
  /** A sign-in started here that finished on another e-mail, by machine (`op`). */
  others: Record<string, string>;
  /** Open `account_limit` decisions on other accounts: the waves that can move here. */
  movable: DecisionPayload[];
  onMove: ((d: DecisionPayload) => void) | null;
  /** Add to another machine…; `null`: read-only. */
  onAdd: (() => void) | null;
  /** Sign in on a configured machine missing the account; `null`: read-only. */
  onSignInOn: ((c: MatrixCell) => void) | null;
  now: number;
}) {
  const g = row.group;
  const { held, total } = row.coverage;
  const only = g.members.length === 1 ? g.members[0] : undefined;
  const ago = g.freshest && readingAge(g.freshest.sampledAt, now);
  return (
    <article className="claude-card" aria-label={g.label}>
      <div className="cc-head">
        <span className="tile" style={{ background: CLAUDE_TINT }} aria-hidden="true">
          ✳
        </span>
        <div className="min0">
          <b>{g.label}</b>
          <div className="s-hint ell">
            {g.org ??
              (only === undefined
                ? plural(g.members.length, "machine")
                : only.account === PRIMARY
                  ? `${PRIMARY} · Claude Code's default login`
                  : `${only.account} · ${machineName(only.machine)}`)}
          </div>
        </div>
        {total > 1 && (
          <span className={`chip${held < total ? " chip--gap" : ""}`}>
            on {held} of {total} machines
          </span>
        )}
        {g.plan && <span className="chip">{g.plan}</span>}
      </div>
      <EmailRow email={g.email} />
      <Meters g={g} now={now} />
      {g.members.length > 1 && g.freshest && (
        <div className="cc-fresh">
          <div className="s-hint">
            freshest: {machineName(g.freshest.machine)}, {ago ? `${ago} ago` : "just now"}
          </div>
          {g.stale.map((s) => (
            <div key={`${s.machine}-${s.window}`} className="s-hint cc-stale">
              {machineName(s.machine)}'s {WINDOW_NAME[s.window]} reading ({Math.round(s.pct)}%,{" "}
              {readingAge(s.sampledAt, now) ?? "<1 min"} old) is stale
            </div>
          ))}
        </div>
      )}
      <ul className="cc-machines" aria-label="Machines">
        {row.rows.map((c) => {
          const m = c.member;
          if (m === null)
            return (
              <MissingRow
                key={`gap-${c.op}`}
                c={c}
                account={g.label}
                other={others[c.op] ?? null}
                onSignIn={onSignInOn && (() => onSignInOn(c))}
              />
            );
          return (
            <li key={m.account}>
              <span className={`cc-dot${m.signedIn ? " cc-dot--in" : ""}`} aria-hidden="true" />
              <span className="sr-only">{m.signedIn ? "signed in" : "signed out"}</span>
              <b>{c.name}</b>
              <span className="dim ell">{m.label}</span>
              <UsageTriple {...usageTriple(g, m, now)} />
              <span className="dim cc-waves">
                {m.waves.length ? `waves: ${m.waves.join(", ")}` : "no waves"}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="cc-move">
        <span className="s-hint">Use for</span>
        <select
          aria-label={`Move a wave to ${g.label}`}
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
        {onAdd && (
          <button type="button" className="btn" onClick={onAdd}>
            Add to another machine…
          </button>
        )}
      </div>
      <div className="cc-foot">
        <span>{plural(g.agents.length, "agent")}</span>
        <span className="dim">
          {g.waves.length ? `waves: ${g.waves.join(", ")}` : "no waves assigned"}
        </span>
      </div>
    </article>
  );
}

/** A machine the Add dialog can sign a new profile in on. */
export interface AddMachine extends MatrixMachine {
  /** It already holds the account being added (Add to another machine…). */
  holds: boolean;
}

/**
 * Sign in on <machine>: the account to sign in with and the profile to make for it. volleyd's
 * ids are unique across machines, so the label is Add to another machine…'s `<label> (<machine>)`.
 */
export interface SignInPreset {
  /** The account group's key. */
  key: string;
  /** The account as its card names it, for a dialog with no e-mail to show. */
  account: string;
  email: string | null;
  label: string;
  /** `claude_account_add`'s `machine`, and how the dialog names it. */
  machine: string;
  name: string;
}

/** A profile label for a machine's own login: never the e-mail, never "primary". */
const NEW_PROFILE = "Claude login";

/** The Sign in on <machine> preset for an account on a configured machine missing it. */
export function signInPreset(g: AccountGroup, m: MatrixMachine): SignInPreset {
  const held = g.members.find((x) => !x.isPrimary);
  // A label made by this rule names its machine already: `Work (peer-a)` → `Work`.
  const base = held ? held.label.replace(/ \([^()]+\)$/, "") || held.label : NEW_PROFILE;
  return {
    key: g.key,
    account: g.label,
    email: g.email,
    label: `${base} (${m.host ?? m.name})`,
    machine: m.op,
    name: m.name,
  };
}

/** What volleyd's `claude_account_add` answer carries for the sign-in (as its URL event). */
interface Started {
  url?: string;
  flow?: string;
  attach?: string;
  manual_url?: string;
}

type Adding =
  | { phase: "pick"; error?: string }
  | {
      phase: "waiting";
      machine: string;
      label: string;
      acct?: string;
      r?: Started;
      error?: string;
    };

/** The add-account Stepper: label and machine → Anthropic's sign-in page → done. */
function AddAccount({
  machines,
  baseLabel = "",
  preset,
  signins,
  control,
  onStarted,
  onClose,
}: {
  /** This machine first, then each paired host. */
  machines: AddMachine[];
  /**
   * Add to another machine…: the account's profile label. volleyd's ids are unique across
   * machines, so the field starts as `<label> (<machine>)` and follows the picked machine
   * until the owner types their own.
   */
  baseLabel?: string;
  /** Sign in on <machine>: no label or machine to pick, the sign-in starts at once. */
  preset?: SignInPreset;
  signins: Record<string, ClaudeSignin>;
  control: ControlFn;
  /** Hears the sign-in's account id once volleyd has started it. */
  onStarted?: (acct: string, label: string, machine: string) => void;
  onClose: () => void;
}) {
  const [s, setS] = useState<Adding>(() =>
    preset ? { phase: "waiting", machine: preset.machine, label: preset.label } : { phase: "pick" },
  );
  /** What the owner typed; null while the field still follows the suggestion. */
  const [typed, setTyped] = useState<string | null>(null);
  const [pick, setPick] = useState(() => machines.find((m) => m.up && !m.holds)?.op);
  const chosen = machines.find((m) => m.op === pick && m.up && !m.holds);
  const label =
    s.phase === "waiting"
      ? s.label
      : (typed ??
        (baseLabel && chosen ? `${baseLabel} (${chosen.host ?? chosen.name})` : baseLabel));
  const signin = s.phase === "waiting" && s.acct ? signins[s.acct] : undefined;
  const done = signin?.state === "done";
  const r = s.phase === "waiting" ? (s.r ?? {}) : {};
  const url = signin?.url ?? r.url;
  const machine = s.phase === "waiting" ? s.machine : (chosen?.op ?? LOCAL_MACHINE);
  const remote = machine !== LOCAL_MACHINE;

  const start = async (machine: string, name = label.trim()) => {
    if (!name) return;
    setS({ phase: "waiting", machine, label: name });
    const r = await control(
      "claude_account_add",
      { label: name, machine },
      `volley claude add "${name}"`,
      ADD_ACCOUNT_TIMEOUT_MS,
    );
    const res = (r.result ?? {}) as Record<string, unknown>;
    const acct = typeof res.acct === "string" ? res.acct : res.account;
    if (!r.ok || typeof acct !== "string") {
      const error = r.error ?? "volleyd did not start the sign-in";
      // A preset has no step 1 to go back to: the sign-in step says why.
      setS(preset ? { phase: "waiting", machine, label: name, error } : { phase: "pick", error });
      return;
    }
    onStarted?.(acct, name, machine);
    const field = (k: keyof Started) =>
      typeof res[k] === "string" ? { [k]: res[k] as string } : {};
    setS((cur) =>
      cur.phase === "waiting"
        ? {
            ...cur,
            acct,
            r: { ...field("url"), ...field("flow"), ...field("attach"), ...field("manual_url") },
          }
        : cur,
    );
  };

  // Sign in on <machine> starts the sign-in on open, once (a re-render or a strict-mode remount
  // must not start a second one).
  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on open only
  useEffect(() => {
    if (!preset || started.current) return;
    started.current = true;
    void start(preset.machine, preset.label);
  }, []);

  return (
    <section className="pair claude-add" aria-label="Add Claude account">
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
            value={label}
            onChange={(e) => setTyped(e.target.value)}
          />
          {baseLabel && (
            <p className="s-hint">
              Each machine’s profile needs its own label: volleyd names a profile once across
              machines.
            </p>
          )}
          <fieldset className="claude-add-machines">
            <legend>Machine</legend>
            {machines.map((m) => {
              const why = m.holds ? "already holds this account" : m.up ? null : "tunnel down";
              const note = why ?? (m.unknown ? "no record yet" : null);
              return (
                <label
                  key={m.op}
                  className={`claude-add-machine${why ? " claude-add-machine--off" : ""}`}
                >
                  <input
                    type="radio"
                    name="claude-add-machine"
                    value={m.op}
                    checked={chosen?.op === m.op}
                    disabled={why !== null}
                    onChange={() => setPick(m.op)}
                  />
                  <span>{m.name}</span>
                  {note && <span className="s-hint">{note}</span>}
                </label>
              );
            })}
          </fieldset>
          {s.phase === "pick" && s.error && (
            <p className="s-error" role="alert">
              {s.error}
            </p>
          )}
          <div className="ny-actions">
            <button
              type="button"
              className="btn btn--blue"
              disabled={!label.trim() || chosen === undefined}
              onClick={() => chosen && void start(chosen.op)}
            >
              Sign in on {chosen ? chosen.name : "…"}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </Step>
        <Step title="Sign in" description="Anthropic’s page">
          {preset ? (
            <h3>
              Sign in{" "}
              {preset.email ? (
                <>
                  with <MaskedEmail email={preset.email} />
                </>
              ) : (
                `as ${preset.account}`
              )}{" "}
              on {preset.name}
            </h3>
          ) : (
            <h3>Sign in with the account you want to add</h3>
          )}
          {s.phase === "waiting" && s.error ? (
            <p className="s-error" role="alert">
              {s.error}
            </p>
          ) : signin?.state === "failed" ? (
            <p className="s-error" role="alert">
              The sign-in did not finish: {signin.reason ?? "unknown reason"}
            </p>
          ) : remote ? (
            url ? (
              <SigninLink
                machine={machine}
                url={url}
                flow={signin?.flow ?? r.flow}
                attach={signin?.attach ?? r.attach}
                manualUrl={signin?.manual_url ?? r.manual_url}
                lead={`Sign in on Anthropic’s own page; the profile lives on ${machine}.`}
              />
            ) : (
              <p className="dim">
                <span className="spinner" aria-hidden="true" /> Starting the sign-in on {machine}…
              </p>
            )
          ) : (
            <>
              {url && (
                <div className="ny-actions">
                  <a className="btn btn--blue" href={url} target="_blank" rel="noreferrer">
                    Open Anthropic sign-in ↗
                  </a>
                </div>
              )}
              <p className="dim">
                The page hands the sign-in straight back to Claude Code on{" "}
                {machineName(LOCAL_MACHINE)}: open it in a browser there.
                {signin?.flow === "manual_code" &&
                  ` If it shows a code, paste it into the sign-in terminal${signin.attach ? ` (tmux attach -t ${signin.attach})` : ""}, never here.`}
              </p>
              <div className="waiting">
                <span className="spinner" aria-hidden="true" /> Waiting for the sign-in to finish…
              </div>
            </>
          )}
          <div className="ny-actions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </Step>
        <Step title="Done" description="Added">
          <h3>Added: {label.trim()}</h3>
          <p className="dim">
            {signin?.plan ? `${signin.plan} · ` : ""}signed in on {machineName(machine)}. Pick it
            for new waves under Defaults, or let them take the account with the most headroom.
          </p>
          {preset && signin?.email && normalizeEmail(signin.email) !== preset.key && (
            <output className="s-hint">
              That was another account ({maskEmail(signin.email)}): it gets a card of its own, and{" "}
              {preset.name} still misses {preset.email ? maskEmail(preset.email) : preset.account}.
            </output>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </Step>
      </Stepper>
    </section>
  );
}

/** Sign in on <machine> for one account: Add, already at the sign-in step. */
export function SignInOnDialog(p: {
  preset: SignInPreset;
  signins: Record<string, ClaudeSignin>;
  control: ControlFn;
  onStarted?: (acct: string, label: string, machine: string) => void;
  onClose: () => void;
}) {
  return <AddAccount machines={[]} {...p} />;
}

/**
 * Per account, the e-mail a matrix sign-in finished with when it was another account's, by
 * machine; and the groups with a login made up for each one that finished on the same e-mail
 * (until the registry, re-fetched, has it).
 */
export function withSignIns(
  groups: AccountGroup[],
  tries: readonly SignInTry[],
  signins: Record<string, ClaudeSignin>,
): { groups: AccountGroup[]; others: Record<string, Record<string, string>> } {
  const others: Record<string, Record<string, string>> = {};
  const added = new Map<string, Member[]>();
  // A group with no reported e-mail is keyed by its account id: nothing to compare against.
  const unknown = new Set(groups.filter((g) => g.email === null).map((g) => g.key));
  for (const t of tries) {
    const done = signins[t.acct];
    if (done?.state !== "done" || done.email === undefined) continue;
    if (!unknown.has(t.key) && normalizeEmail(done.email) !== t.key) {
      others[t.key] = { ...others[t.key], [t.op]: done.email };
      continue;
    }
    added.set(t.key, [
      ...(added.get(t.key) ?? []),
      {
        account: t.acct,
        machine: t.op,
        label: t.label,
        signedIn: true,
        agents: [],
        waves: [],
        isPrimary: false,
        sampledAt: null,
      },
    ]);
  }
  return {
    groups: groups.map((g) => {
      const extra = (added.get(g.key) ?? []).filter(
        (x) => !g.members.some((m) => m.machine === x.machine),
      );
      return extra.length ? { ...g, members: [...g.members, ...extra] } : g;
    }),
    others,
  };
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
  machines,
  localName,
  hosts = [],
  group,
  onOpenGroup = () => {},
  hit,
}: ClaudeAccountsProps) {
  /** The Add dialog: the account's profile label and the machines already holding it. */
  const [adding, setAdding] = useState<{ label: string; holds: string[] } | null>(null);
  /** Sign in on <machine>: the account and machine, from a card's matrix row. */
  const [signingIn, setSigningIn] = useState<SignInPreset | null>(null);
  /** The sign-ins the matrix started, to tell which account each one finished on. */
  const [tries, setTries] = useState<SignInTry[]>([]);
  const [closed, setClosed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** A resolve in flight: the answers stay disabled so a double click sends one. */
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState<RowState>();
  const now = useNow(fixedNow);
  const { accounts: registry, primaryPlan } = useClaudeRegistry(
    control,
    signinsDone(signins) + closed,
  );
  useEffect(() => {
    if (registry.length) onRegistry?.(registry);
  }, [registry, onRegistry]);

  const list = withPrimary(accountList(records, registry), primaryPlan);
  const signedIn = withSignIns(
    deskAccountGroups(records, registry, primaryPlan, machines, localName),
    tries,
    signins,
  );
  const groups = signedIn.groups;
  const configured = configuredMachines(hosts, machines, localName);
  const matrix = accountMatrix(groups, configured);
  const labelOf = (id: string | null | undefined) =>
    list.find((a) => a.id === id)?.label ?? id ?? "";
  const decisions = openLimitDecisions(waves);
  const addMachines = (holds: string[]): AddMachine[] =>
    configured.map((m) => ({ ...m, holds: holds.includes(m.op) }));

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
    [PRIMARY, "Primary"],
    ...list
      .filter((a) => a.machine === LOCAL_MACHINE && a.id !== PRIMARY && !a.id.includes("@"))
      .map((a): [string, string] => [a.id, a.label]),
  ];
  if (!defaults.some(([k]) => k === current)) defaults.push([current, current]);
  const currentLabel = defaults.find(([k]) => k === current)?.[1] ?? current;

  if (group === "defaults") {
    return (
      <Group>
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
            <span className="mono s-hint">{currentLabel}</span>
          )}
        </Row>
        <Row
          label="Warn me at"
          hint="Raises a Needs-you to move waves; nothing switches on its own"
        >
          <span className="mono s-hint">{warnAt}% of the 5-hour window</span>
        </Row>
      </Group>
    );
  }
  if (group !== "accounts") {
    return (
      <GroupList
        section={sectionDef("claude")}
        summaries={claudeSummaries({
          accounts: groups.length,
          needsYou: decisions.length,
          defaultLabel: currentLabel,
          warnAt,
        })}
        onOpen={onOpenGroup}
        hit={hit}
      />
    );
  }
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
        {matrix.map((row) => {
          const g = row.group;
          const to = moveTargetOf(g);
          return (
            <AccountCard
              key={g.key}
              row={row}
              others={signedIn.others[g.key] ?? {}}
              movable={decisions.filter((d) => !g.members.some((m) => m.account === d.acct))}
              onMove={
                control && !busy && to !== null
                  ? (d) => void answer(d, moveAnswer(d.wave, to))
                  : null
              }
              onAdd={
                control
                  ? () =>
                      setAdding({
                        // A real profile label only: never the card's e-mail or the primary's name.
                        label: g.members.find((m) => !m.isPrimary)?.label ?? "",
                        holds: g.members.map((m) => m.machine),
                      })
                  : null
              }
              onSignInOn={
                control
                  ? (c) => {
                      const m = configured.find((x) => x.op === c.op);
                      if (m) setSigningIn(signInPreset(g, m));
                    }
                  : null
              }
              now={now}
            />
          );
        })}
        <button
          type="button"
          className="claude-card claude-card--add"
          disabled={!control}
          onClick={() => setAdding({ label: "", holds: [] })}
        >
          + Add Claude account
        </button>
      </div>
      {signingIn && control && (
        <SignInOnDialog
          key={`${signingIn.key}@${signingIn.machine}`}
          preset={signingIn}
          signins={signins}
          control={control}
          onStarted={(acct, label, op) =>
            setTries((ts) => [...ts, { key: signingIn.key, op, label, acct }])
          }
          onClose={() => {
            setSigningIn(null);
            setClosed((n) => n + 1);
          }}
        />
      )}
      {adding && control && (
        <AddAccount
          machines={addMachines(adding.holds)}
          baseLabel={adding.label}
          signins={signins}
          control={control}
          onClose={() => {
            setAdding(null);
            setClosed((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
