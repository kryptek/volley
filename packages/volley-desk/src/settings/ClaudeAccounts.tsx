/**
 * Settings › Claude accounts & usage, ported from the prototype
 * `ClaudeAccounts` (SPEC §4.6.11–12). One card per Anthropic account: the
 * supervisor's retained usage records, registry profiles that have not
 * reported yet, signed-in peers and this machine's own login (the primary,
 * first and from the start), merged by the login's e-mail (`accountGroups`).
 * A card shows the label, plan chip and organisation, the e-mail masked until
 * its eye button reveals it (never persisted), the 5-hour and weekly meters
 * from the freshest reading (a disagreeing older one named stale), one row per
 * machine holding the account, the agents and waves on it, and "Move a wave
 * here…" (its login on this machine, by account id). An open
 * `account_limit` decision is a Needs-you banner whose Move / Not now answer
 * it (`resolve`); volleyd moves a wave only by such an answer, so "Move a wave
 * here…" lists the waves that have one open. **Add Claude account** is a
 * Stepper: a label and the machine (this one, or any paired host whose tunnel
 * is up), then "Sign in on <machine>" (`claude_account_add { label, machine }`),
 * then the sign-in link from the answer and the `claude_signin_url` event (on
 * a peer, the same link and phone steps as Settings › Machines, `SigninLink`),
 * waiting until `claude_signin_done`. A card's **Add to another machine…**
 * opens it with the label filled in and the machines holding the account
 * greyed out. The Desk shows only the provider's sign-in link, never a
 * credential. Defaults: the account for new waves (`claude.default_account`,
 * through config_set) and the warn-at threshold from config.
 */
import { EyeIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { maskEmail } from "../lib/email";
import { plural } from "../lib/plural";
import Stepper, { Step } from "../rb/Stepper/Stepper";
import type { ControlReply } from "../steer/transport";
import {
  type AccountGroup,
  type AccountInfo,
  LOCAL_MACHINE,
  type RegistryAccount,
  accountGroups,
  accountList,
  fiveHourLabel,
  moveAnswer,
  moveTargetOf,
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
  MachinePayload,
  UsageWindow,
  WaveView,
} from "../store/types";
import { AckLine, type RowState } from "./ConfigRows";
import { SigninLink } from "./PeerSigninSheet";
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
}

const machineName = (m: string) => (m === LOCAL_MACHINE ? "this machine" : m);

/** volleyd's id for Claude Code's default profile on its own machine. */
const PRIMARY = "primary";
/** How the primary's card names it: never just "primary", which reads as one more profile. */
export const PRIMARY_LABEL = "This machine's Claude login";

/**
 * The list with this machine's own login first. It is always there (agents run on it by
 * default), but it has a usage record only once it reports usage, so until then one is made up
 * for it: an owner who adds a profile must not read the missing card as their login gone. Its
 * plan is the one volleyd reports (its record's, else `claude_accounts`'s), never a guess.
 */
function withPrimary(list: AccountInfo[], plan: string | undefined): AccountInfo[] {
  const own = list.find((a) => a.id === PRIMARY);
  const primary: AccountInfo =
    own === undefined
      ? {
          id: PRIMARY,
          label: PRIMARY_LABEL,
          machine: LOCAL_MACHINE,
          plan: plan ?? null,
          email: null,
          org: null,
          fiveHour: null,
          weekly: null,
          sampledAt: null,
          signedIn: true,
          agents: [],
          waves: [],
        }
      : {
          ...own,
          label: own.label === PRIMARY ? PRIMARY_LABEL : own.label,
          plan: own.plan ?? plan ?? null,
        };
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

/** `3 h`, `12 min`, `2 d`: how old a reading is; `null` under a minute. */
function age(at: string, now: number): string | null {
  const m = Math.floor((now - Date.parse(at)) / 60_000);
  if (!(m >= 1)) return null;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

const WINDOW_NAME = { five_hour: "5-hour", weekly: "weekly" } as const;

/** The login's e-mail, masked until its eye button shows it (per card, never persisted). */
function EmailRow({ email }: { email: string | null }) {
  const [shown, setShown] = useState(false);
  if (email === null)
    return <div className="s-hint">e-mail not reported yet (run the machine's doctor)</div>;
  return (
    <div className="cc-email">
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
    </div>
  );
}

/** One Anthropic account's card. */
function AccountCard({
  g,
  movable,
  onMove,
  onAdd,
  now,
}: {
  g: AccountGroup;
  /** Open `account_limit` decisions on other accounts: the waves that can move here. */
  movable: DecisionPayload[];
  onMove: ((d: DecisionPayload) => void) | null;
  /** Add to another machine…; `null`: read-only. */
  onAdd: (() => void) | null;
  now: number;
}) {
  const only = g.members.length === 1 ? g.members[0] : undefined;
  const ago = g.freshest && age(g.freshest.sampledAt, now);
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
        {g.plan && <span className="chip">{g.plan}</span>}
      </div>
      <EmailRow email={g.email} />
      <Meter label="5-hour window" w={g.fiveHour} now={now} />
      <Meter label="This week" w={g.weekly} now={now} />
      {g.members.length > 1 && g.freshest && (
        <div className="cc-fresh">
          <div className="s-hint">
            freshest: {machineName(g.freshest.machine)}, {ago ? `${ago} ago` : "just now"}
          </div>
          {g.stale.map((s) => (
            <div key={`${s.machine}-${s.window}`} className="s-hint cc-stale">
              {machineName(s.machine)}'s {WINDOW_NAME[s.window]} reading ({Math.round(s.pct)}%,{" "}
              {age(s.sampledAt, now) ?? "<1 min"} old) is stale
            </div>
          ))}
        </div>
      )}
      <ul className="cc-machines" aria-label="Machines">
        {g.members.map((m) => (
          <li key={m.account}>
            <span className={`cc-dot${m.signedIn ? " cc-dot--in" : ""}`} aria-hidden="true" />
            <span className="sr-only">{m.signedIn ? "signed in" : "signed out"}</span>
            <b>{machineName(m.machine)}</b>
            <span className="dim ell">{m.label}</span>
            <span className="dim cc-waves">
              {m.waves.length ? `waves: ${m.waves.join(", ")}` : "no waves"}
            </span>
          </li>
        ))}
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
export interface AddMachine {
  /** How the picker names it ("this machine" for volleyd's own). */
  name: string;
  /** `claude_account_add`'s `machine`: `LOCAL_MACHINE` or the peer's host name. */
  op: string;
  /** Its tunnel is up (this machine always is). */
  up: boolean;
  /** It already holds the account being added (Add to another machine…). */
  holds: boolean;
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
  | { phase: "waiting"; machine: string; acct?: string; r?: Started };

/** The add-account Stepper: label and machine → Anthropic's sign-in page → done. */
function AddAccount({
  machines,
  initialLabel = "",
  signins,
  control,
  onClose,
}: {
  /** This machine first, then each paired host. */
  machines: AddMachine[];
  initialLabel?: string;
  signins: Record<string, ClaudeSignin>;
  control: ControlFn;
  onClose: () => void;
}) {
  const [s, setS] = useState<Adding>({ phase: "pick" });
  const [label, setLabel] = useState(initialLabel);
  const [pick, setPick] = useState(() => machines.find((m) => m.up && !m.holds)?.op);
  const chosen = machines.find((m) => m.op === pick && m.up && !m.holds);
  const signin = s.phase === "waiting" && s.acct ? signins[s.acct] : undefined;
  const done = signin?.state === "done";
  const r = s.phase === "waiting" ? (s.r ?? {}) : {};
  const url = signin?.url ?? r.url;
  const machine = s.phase === "waiting" ? s.machine : (chosen?.op ?? LOCAL_MACHINE);
  const remote = machine !== LOCAL_MACHINE;

  const start = async (machine: string) => {
    const name = label.trim();
    if (!name) return;
    setS({ phase: "waiting", machine });
    const r = await control(
      "claude_account_add",
      { label: name, machine },
      `volley claude add "${name}"`,
      ADD_ACCOUNT_TIMEOUT_MS,
    );
    const res = (r.result ?? {}) as Record<string, unknown>;
    const acct = typeof res.acct === "string" ? res.acct : res.account;
    if (!r.ok || typeof acct !== "string") {
      setS({ phase: "pick", error: r.error ?? "volleyd did not start the sign-in" });
      return;
    }
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
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <fieldset className="claude-add-machines">
            <legend>Machine</legend>
            {machines.map((m) => {
              const why = m.holds ? "already holds this account" : m.up ? null : "tunnel down";
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
                  {why && <span className="s-hint">{why}</span>}
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
          <h3>Sign in with the account you want to add</h3>
          {signin?.state === "failed" ? (
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
            for new waves below, or let them take the account with the most headroom.
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
  machines,
  localName,
  hosts = [],
}: ClaudeAccountsProps) {
  /** The Add dialog: the label it starts with and the machines already holding that account. */
  const [adding, setAdding] = useState<{ label: string; holds: string[] } | null>(null);
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
  const groups = accountGroups(list, machines, localName);
  const labelOf = (id: string | null | undefined) =>
    list.find((a) => a.id === id)?.label ?? id ?? "";
  const decisions = openLimitDecisions(waves);
  const addMachines = (holds: string[]): AddMachine[] =>
    [
      { name: machineName(LOCAL_MACHINE), op: LOCAL_MACHINE, up: true },
      ...hosts
        .filter((h) => h !== localName)
        .map((h) => ({ name: h, op: h, up: machines?.[h]?.tunnel !== "down" })),
    ].map((m) => ({ ...m, holds: holds.includes(m.op) }));

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
        {groups.map((g) => {
          const to = moveTargetOf(g);
          return (
            <AccountCard
              key={g.key}
              g={g}
              movable={decisions.filter((d) => !g.members.some((m) => m.account === d.acct))}
              onMove={
                control && !busy && to !== null
                  ? (d) => void answer(d, moveAnswer(d.wave, to))
                  : null
              }
              onAdd={
                control
                  ? () => setAdding({ label: g.label, holds: g.members.map((m) => m.machine) })
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
      {adding && control && (
        <AddAccount
          machines={addMachines(adding.holds)}
          initialLabel={adding.label}
          signins={signins}
          control={control}
          onClose={() => {
            setAdding(null);
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
