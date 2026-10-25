/**
 * Settings › Machines, ported from the prototype `MachinesBody` (SPEC
 * §4.6.14–15): the machines that can run agents for the waves. The
 * supervisor's own machine comes first as "this one" (its record is the one
 * named by `_config` `fleet.local_name`; until it has one, a placeholder card
 * with its agents), then one `MachineCard` per paired machine's retained
 * record under `volley/_system/machines/#`, with volleyd's readiness verdict
 * from `<name>/readiness` (stale while volleyd is not live) and, for an
 * admin, the cap editor. Only configured hosts are machines: every account
 * may publish its own record.
 *
 * An admin Desk can pair and unpair. **+ Add a machine** creates a pairing
 * code at once (`peer_invite`) and opens a Stepper (`AddMachineByCode`) on "Run this on the other
 * machine": the copyable `volley peer join <code> --to <ssh address>` (the
 * address of this machine, which the owner types) and the code's countdown,
 * waiting until a record for a host that was not there before arrives
 * (joined); then step 3 its checks and verdict (with Repair…), step 4 Claude
 * on it (Check again runs a dry doctor), step 5 its readiness and max_agents,
 * then Done. **Add a bare machine…** does it all from here for a box with
 * only ssh (`machine_add`, `AddMachineSheet`): volleyd installs Volley there,
 * pairs and checks it, its rows streaming into the sheet. **Remove…** asks first, then sends `peer_remove`,
 * which revokes the machine's account and clears its record. Any other
 * session (not signed in, not an admin, demo, a browser that cannot make a
 * reply key at all) is read-only and is shown the terminal commands instead.
 * A plain-http LAN page can pair: its reply key comes from `lib/rsa.ts`.
 *
 * Each card lists the Claude accounts (`machineRows` over the groups App
 * computes), each with its sign-in state there and no usage figures (the
 * account's card in Settings › Claude accounts has them once): **Sign in on
 * <machine>** opens Settings › Claude accounts' sign-in for that account there
 * (`SignInOnDialog`). The block shows the registry's view only: a
 * sign-in started here fills its row once the registry is re-fetched, and one that finished
 * on another e-mail is said on the dialog's Done step, not on the card (Settings › Claude
 * accounts tracks both on its own cards).
 *
 * Machine roles (SPEC §4.6.24): under the intro, the summary line names where each role runs
 * (`broker · studio — supervisor · studio — desk · box-a`), from volleyd's record, and each card
 * chips its own; an admin moves a role to a machine from its card (`RoleMoveSheet`), and a
 * finished move leaves its notice here.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SwitchToAdmin } from "../auth/AccountActions";
import { plural } from "../lib/plural";
import { type AccountGroup, LOCAL_MACHINE, configuredMachines, machineRows } from "../store/claude";
import { type AdminStatus, type PeerOps, pairingSupported } from "../store/peerOps";
import type { RoleOps } from "../store/roleOps";
import {
  type ClaudeSignin,
  type ConfigPayload,
  MACHINE_ROLES,
  type MachinePayload,
  type ReadinessPayload,
  type RoleMovePayload,
  type RolesPayload,
  type WaveStatePayload,
} from "../store/types";
import { AddMachineByCode, useNow } from "./AddMachineByCode";
import { AddMachineSheet } from "./AddMachineSheet";
import { type ControlFn, SignInOnDialog, type SignInPreset, signInPreset } from "./ClaudeAccounts";
import { type MachineAccountRow, MachineCard } from "./MachineCard";
import type { ConfigTransport } from "./configTransport";
import "../styles/machines.css";

/** How often the clock ticks: every second while a code counts down, else for the "seen" ages. */
const COUNTDOWN_TICK_MS = 1000;
const AGE_TICK_MS = 15_000;

export interface MachinesProps {
  /** Machine records, by name (`volley/_system/machines/#`); only `hosts` (and `localName`) are shown. */
  machines: Record<string, MachinePayload>;
  /** The configured hosts (`_waves/_config` `hosts`): the names that are machines; none by default. */
  hosts?: readonly string[];
  /** Whether volleyd, on this machine, is live: this machine's dot. */
  hubUp: boolean;
  /** This machine's live agents. */
  hubAgents?: number;
  /** `null` = no op channel (not signed in, demo): read-only. */
  ops: PeerOps | null;
  /** Clock override (tests); otherwise the section ticks. */
  now?: number;
  /** This machine's host as the Desk reaches it, for the ssh address's placeholder. */
  host?: string;
  /** Told what the admin check found (Settings' account row shows an admin as one). */
  onAdmin?: (admin: AdminStatus) => void;
  /** volleyd's readiness verdicts, by machine name (`volley/_system/machines/<name>/readiness`). */
  readiness?: Record<string, ReadinessPayload>;
  /** The supervisor's own machine name (`_config` `fleet.local_name`): its record is "this one". */
  localName?: string | null | undefined;
  /** volleyd's config channel, for the cap editors; `null` = read-only. */
  configTransport?: ConfigTransport | null;
  /** Each machine's live agents (`agentsOnMachines`), listed by Remove. */
  agentsOn?: Record<string, string[]>;
  /** The remote Claude sign-in's button for a machine, when the Desk has one. */
  signIn?: (machine: string) => ReactNode;
  /** A machine to scroll into view on open (the agent window's machine chip). */
  focus?: string | undefined;
  /** Bumped on every chip click, so a second click on the same machine scrolls to it again. */
  focusSeq?: number | undefined;
  /** Open a Settings › Supervisor row by its config path (the local agents chip). */
  onOpenSetting?: ((path: string) => void) | undefined;
  /** Open Settings › Repositories (a card's Repositories… link). */
  onOpenRepos?: (() => void) | undefined;
  /** volleyd's config (`_waves/_config`): the repositories it assigns to each machine. */
  waveConfig?: ConfigPayload | null | undefined;
  /** volleyd's machine roles record (`volley/_system/roles`); absent until it arrives. */
  roles?: RolesPayload | undefined;
  /** The role moves' retained records, by move id. */
  roleMoves?: Record<string, RoleMovePayload> | undefined;
  /** The role ops (admin): Move a role here… on the cards; `null` = none. */
  roleOps?: RoleOps | null | undefined;
  /** The Claude account groups (App's `deskAccountGroups`), the sign-ins and volleyd's control. */
  claude?: {
    groups: AccountGroup[];
    signins: Record<string, ClaudeSignin>;
    /** `null`: read-only, the accounts listed without Sign in. */
    control: ControlFn | null;
  };
}

const FINISHED: ReadonlySet<string> = new Set(["done", "cancelled"]);

/**
 * Each machine's agents, from the waves' unfinished tasks: a task's machine is its `host`, else
 * its placement's (the supervisor's own machine, under its local name). `live` narrows them to
 * the agents still running (the store's statuses).
 */
export function agentsOnMachines(
  states: readonly WaveStatePayload[],
  live: (agentId: string) => boolean = () => true,
): Record<string, string[]> {
  const on: Record<string, string[]> = {};
  for (const s of states) {
    for (const t of s.tasks) {
      const host = t.host ?? t.placement?.host;
      if (!host || FINISHED.has(t.stage)) continue;
      const ids = Object.values(t.agents).filter((a): a is string => !!a && live(a));
      if (ids.length) on[host] = [...(on[host] ?? []), ...ids];
    }
  }
  return on;
}

/**
 * Whether `ops` may pair: what is already known at once, else `null` until
 * volleyd answers. Asked again when volleyd comes up, since no answer is kept.
 */
export function useAdmin(ops: PeerOps | null, hubUp: boolean): AdminStatus | null {
  const [admin, setAdmin] = useState<AdminStatus | null>(() => (ops ? ops.known() : "not-admin"));
  useEffect(() => {
    if (!ops) {
      setAdmin("not-admin");
      return;
    }
    const known = ops.known();
    if (known) {
      setAdmin(known);
      return;
    }
    let live = true;
    setAdmin((a) => (a === "no-answer" && !hubUp ? a : null));
    void ops.admin().then((a) => {
      if (live) setAdmin(a);
    });
    return () => {
      live = false;
    };
  }, [ops, hubUp]);
  return admin;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The ssh address's hint: the host the Desk reaches the broker on, which the
 * other machine can likely reach too; "" for a loopback address (the Desk
 * runs on this machine) or no broker. Only a hint: the ssh user is unknown
 * here, and a TLS proxy's host may not take ssh at all.
 */
export function sshHost(brokerUrl: string | null): string {
  if (!brokerUrl) return "";
  try {
    const host = new URL(brokerUrl).hostname;
    return LOOPBACK.has(host) ? "" : host;
  } catch {
    return "";
  }
}

/** `broker · studio — supervisor · studio — desk · box-a`: where each machine role runs. */
export const rolesSummary = (roles: RolesPayload) =>
  MACHINE_ROLES.map((r) => `${r} · ${roles[r].machine}`).join(" — ");

/**
 * The Desk's new address when this page is the old one: a Desk move to the record's machine is
 * done and the record's address is on another origin (the old Desk keeps serving until its unit
 * is unloaded, last). `null` otherwise, and for an address that is not a URL.
 */
export function deskMovedTo(
  roles: RolesPayload | undefined,
  moves: Record<string, RoleMovePayload> | undefined,
  origin: string,
): string | null {
  if (!roles) return null;
  const moved = Object.values(moves ?? {}).some(
    (m) => m.role === "desk" && m.status === "done" && m.to === roles.desk.machine,
  );
  if (!moved) return null;
  try {
    return new URL(roles.desk.url).origin === origin ? null : roles.desk.url;
  } catch {
    return null;
  }
}

/** This machine: the broker and volleyd run here, so it has no tunnel and no record. */
function HubCard({ up, agents }: { up: boolean; agents: number }) {
  return (
    <article className="machine machine--hub" aria-label="This machine">
      <div className="m-head">
        <b>This machine</b>
        <span className="chip chip--mine">this one</span>
      </div>
      <div className="dim">Runs the broker and volleyd</div>
      <div className="m-stats">
        <span className={`hb${up ? "" : " hb--stale"}`}>
          <i />
          local
        </span>
        <span>{plural(agents, "agent")}</span>
      </div>
      <div className="s-hint">{up ? "volleyd running" : "volleyd not running"}</div>
    </article>
  );
}

/** Why this session cannot pair, said before the terminal commands. */
function readOnlyReason(secure: boolean, admin: AdminStatus | null): string {
  if (!secure) {
    return "Read-only here: this browser cannot make the key that keeps the pairing code private.";
  }
  if (admin === null) return "Checking whether this Desk may pair machines…";
  if (admin === "no-answer") {
    return "volleyd did not answer, so this Desk cannot tell whether it may pair machines: pairing needs volleyd running on this machine.";
  }
  return "Read-only: pairing and removing machines takes an admin account. To pair from here, sign in to the Desk with an admin account.";
}

export function Machines(p: MachinesProps) {
  const [adding, setAdding] = useState(false);
  /** Add a bare machine… (`machine_add`): its sheet is open. */
  const [addingBare, setAddingBare] = useState(false);
  /** Re-pairing codes counting down on cards. */
  const [counting, setCounting] = useState(0);
  const onCountdown = useCallback((on: boolean) => setCounting((n) => n + (on ? 1 : -1)), []);
  const now = useNow(p.now, adding || counting > 0 ? COUNTDOWN_TICK_MS : AGE_TICK_MS);
  // A browser that cannot make a reply key at all (not even lib/rsa's): read-only.
  const secure = pairingSupported();
  const admin = useAdmin(secure ? p.ops : null, p.hubUp);
  const { onAdmin } = p;
  useEffect(() => {
    if (admin !== null) onAdmin?.(admin);
  }, [admin, onAdmin]);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const { focus, focusSeq, localName } = p;
  // On open (and on every chip click): the focused machine's card (this machine's is the hub card
  // until it has a record).
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new focusSeq is a new chip click
  useEffect(() => {
    if (!focus) return;
    const cards = [...(list.current?.querySelectorAll("article.machine") ?? [])];
    const label = (el: Element) => el.getAttribute("aria-label");
    const el =
      cards.find((c) => label(c) === focus) ??
      (focus === localName ? cards.find((c) => c.classList.contains("machine--hub")) : undefined);
    el?.scrollIntoView({ block: "nearest" });
  }, [focus, focusSeq, localName]);
  const shown = useMemo(() => {
    const hosts = new Set(p.hosts ?? []);
    return Object.fromEntries(Object.entries(p.machines).filter(([n]) => hosts.has(n)));
  }, [p.machines, p.hosts]);
  const machines = Object.values(shown).sort((a, b) => a.name.localeCompare(b.name));
  const canPair = secure && admin === "admin" && p.ops !== null;
  // volleyd's own record, published as itself under its local name (never a configured host).
  const own = p.localName ? p.machines[p.localName] : undefined;
  const [signingIn, setSigningIn] = useState<SignInPreset | null>(null);
  const configured = configuredMachines(p.hosts ?? [], p.machines, p.localName ?? undefined);
  /** Each account's row for one machine: its sign-in state there, no figures. */
  const accountRows = (op: string): MachineAccountRow[] =>
    (p.claude?.groups ?? []).map((g) => {
      const here = machineRows(g, configured).find((r) => r.op === op);
      return {
        key: g.key,
        label: g.label,
        email: g.email,
        plan: g.plan,
        held:
          here && here.state !== "missing"
            ? { label: here.labels.join(", "), state: here.state }
            : null,
        up: here?.up ?? true,
      };
    });
  const signInOn = (op: string) => (key: string) => {
    const g = p.claude?.groups.find((x) => x.key === key);
    const m = configured.find((x) => x.op === op);
    if (g && m) setSigningIn(signInPreset(g, m));
  };
  const card = (m: MachinePayload, self = false) => (
    <MachineCard
      key={m.name}
      m={m}
      r={p.readiness?.[m.name]}
      now={now}
      hubUp={p.hubUp}
      self={self}
      admin={canPair}
      ops={p.ops}
      config={p.configTransport}
      agents={p.agentsOn?.[m.name]}
      host={p.host}
      onRemoved={setNotice}
      signIn={self ? undefined : p.signIn?.(m.name)}
      accountRows={p.claude ? accountRows(self ? LOCAL_MACHINE : m.name) : undefined}
      onSignInOn={p.claude?.control ? signInOn(self ? LOCAL_MACHINE : m.name) : undefined}
      onCountdown={onCountdown}
      onOpenLocalAgents={
        self && p.onOpenSetting ? () => p.onOpenSetting?.("fleet.local_agents") : undefined
      }
      onOpenRepos={p.onOpenRepos}
      waveConfig={p.waveConfig}
      roles={p.roles}
      roleMoves={p.roleMoves}
      roleOps={p.roleOps}
      onMoved={setNotice}
    />
  );

  return (
    <div className="machines-section">
      <p className="dim">
        Machines that can run agents for your waves. Agents on another machine report back through a
        private tunnel.
      </p>
      {p.roles && <p className="m-roles-summary mono">{rolesSummary(p.roles)}</p>}
      {notice && <output className="s-hint m-notice">{notice}</output>}
      <div className="machines" ref={list}>
        {own ? card(own, true) : <HubCard up={p.hubUp} agents={p.hubAgents ?? 0} />}
        {machines.map((m) => card(m))}
        {canPair && !adding && (
          <button
            type="button"
            className="machine machine--add"
            onClick={() => {
              setNotice(null);
              setAdding(true);
            }}
          >
            + Add a machine
          </button>
        )}
        {canPair && !adding && (
          <button
            type="button"
            className="machine machine--add"
            onClick={() => {
              setNotice(null);
              setAddingBare(true);
            }}
          >
            Add a bare machine…
          </button>
        )}
      </div>
      {machines.length === 0 && (
        <p className="s-hint">
          No other machines yet. Pair one and waves can place agents on it too.
        </p>
      )}
      {canPair && adding && p.ops && (
        <AddMachineByCode
          ops={p.ops}
          machines={shown}
          readiness={p.readiness ?? {}}
          config={p.configTransport ?? null}
          signIn={p.signIn}
          now={now}
          host={p.host ?? ""}
          hubUp={p.hubUp}
          onClose={() => setAdding(false)}
        />
      )}
      {canPair && addingBare && p.ops && (
        <AddMachineSheet ops={p.ops} signIn={p.signIn} onClose={() => setAddingBare(false)} />
      )}
      {signingIn && p.claude?.control && (
        <SignInOnDialog
          key={`${signingIn.key}@${signingIn.machine}`}
          preset={signingIn}
          signins={p.claude.signins}
          control={p.claude.control}
          onClose={() => setSigningIn(null)}
        />
      )}
      {!canPair && (
        <p className="s-hint m-readonly">
          {readOnlyReason(secure, admin)}{" "}
          {secure && admin === "not-admin" && (
            <>
              <SwitchToAdmin />{" "}
            </>
          )}
          From a terminal on this machine, <code className="mono">volley peer invite</code> makes a
          pairing code and <code className="mono">volley peer remove &lt;name&gt;</code> unpairs
          one.
        </p>
      )}
    </div>
  );
}
