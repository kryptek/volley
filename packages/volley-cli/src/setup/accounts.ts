import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AdminLink,
  VOLLEYD_ADMIN_FILE,
  VOLLEYD_BROKER_FILE,
  ensureOwnedDir,
  openAdmin,
  readCredentials,
  withAdmin,
  writeSecret,
} from "../auth/context";
import { type RoleDrift, classify, clientOf, cmd, inspectRoles } from "../auth/dynsec";
import { type MigrateFlags, initOrMigrate } from "../auth/migrate";
import {
  FIXED_CLIENTS,
  FIXED_IDENTITIES,
  type FixedIdentity,
  VOLLEY_ROLES,
  type VolleyRole,
  roleName,
  tokenIdOf,
} from "../auth/roles";
import { accountVerb, readAccounts } from "../commands/auth-accounts";
import { makeBufferIO } from "../io";
import { encodeQr, renderQr } from "./qr";
import type { Change, SetupContext, StepPlan } from "./step";
import { lanWsUrl } from "./step";

/**
 * Step 3 of `volley setup`: Volley's shared roles and the fixed identities on the broker (the
 * admin login came with step 2), each one's credential file, the operator's own login in the OS
 * keychain where there is one, and a one-time admin token for the first Desk sign-in. It runs
 * `volley auth init` / `volley auth migrate --roles` underneath, so existing logins keep their
 * passwords and only what is missing is created.
 */

/** The keychain item holding the coordinator's broker login (macOS `security`). */
export const KEYCHAIN_SERVICE = "volley-broker";

const list = (xs: readonly string[]) => xs.join(", ");

/** A double-quoted word for `security -i`'s command line (`\` and `"` escaped). */
const securityQuote = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The `security -i` command that stores the coordinator's password (fed on stdin). */
export function keychainAddCommand(password: string): string {
  return [
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    "coordinator",
    "-l",
    securityQuote("Volley broker login (coordinator)"),
    "-w",
    securityQuote(password),
  ].join(" ");
}

/** `volley auth init`'s flags for setup: no config (step 2 owns it), every credential file. */
const initFlags = (ctx: SetupContext, extra: Partial<MigrateFlags> = {}): MigrateFlags => ({
  migrate: false,
  force: false,
  noConfig: true,
  restart: false,
  coordinatorFile: true,
  volleydFile: true,
  roles: false,
  yes: false,
  worktrees: [],
  config: ctx.config,
  stateFile: ctx.stateFile,
  ...extra,
});

async function runInit(ctx: SetupContext, extra: Partial<MigrateFlags> = {}): Promise<string[]> {
  const code = await initOrMigrate(ctx.auth, initFlags(ctx, extra));
  if (code !== 0) throw new Error("`volley auth init` failed (its error is above)");
  return [];
}

/** Who gets volleyd's files under sudo: the invoking user. */
function sudoUser(ctx: SetupContext) {
  const u = ctx.auth.deps.invokingUser(ctx.auth.env);
  return typeof u === "object" && u !== null ? u : null;
}

function readable(path: string) {
  try {
    return readCredentials(path);
  } catch {
    return null;
  }
}

const driftDetail = (drifted: readonly RoleDrift[]) =>
  drifted
    .flatMap((d) => [
      `${roleName(d.role)}:`,
      ...d.missing.map((a) => `  + ${a.acltype} ${a.topic}${a.allow ? "" : " (deny)"}`),
      ...d.extra.map((a) => `  - ${a.acltype} ${a.topic}${a.allow ? "" : " (deny)"}`),
    ])
    .join("\n");

interface BrokerState {
  missingRoles: VolleyRole[];
  drifted: RoleDrift[];
  missingIds: FixedIdentity[];
  /** Identities that exist without every role they should hold. */
  partialIds: FixedIdentity[];
}

async function brokerState(link: AdminLink): Promise<BrokerState> {
  const { missing: missingRoles, drifted } = await inspectRoles(link.session, VOLLEY_ROLES);
  const answers = await link.session.run(FIXED_IDENTITIES.map((u) => cmd.getClient(u)));
  const missingIds: FixedIdentity[] = [];
  const partialIds: FixedIdentity[] = [];
  FIXED_IDENTITIES.forEach((u, i) => {
    const r = answers[i];
    const info = r === undefined ? null : clientOf(r);
    if (info === null) {
      if (r !== undefined && classify(r) !== "missing") {
        throw new Error(`getClient ${u}: ${r.error ?? "no answer"}`);
      }
      missingIds.push(u);
    } else if (FIXED_CLIENTS[u].some((role) => !info.roles.includes(roleName(role)))) {
      partialIds.push(u);
    }
  });
  return { missingRoles, drifted, missingIds, partialIds };
}

/**
 * What a new identity's password comes to. The terminal prints each one once; over the Desk
 * (`remote`) volleyd and coordinator get theirs in their files only, and desk's is never shown:
 * the Desk issues one when a device needs it (`newDeskPassword`).
 */
function passwordNote(missing: readonly FixedIdentity[], remote: boolean): string {
  if (missing.length === 0) return "";
  if (!remote) return ` (password${missing.length === 1 ? "" : "s"} shown once)`;
  return missing.includes("desk")
    ? " (desk's password is not shown here: Setup & Security › New desk password issues one, shown once)"
    : "";
}

/** "Create Volley's 8 shared roles and the identities …" for what is missing. */
function createSummary(
  s: BrokerState,
  adminFileMissing: boolean,
  adminFile: string,
  remote: boolean,
): string {
  const parts: string[] = [];
  if (s.missingRoles.length === VOLLEY_ROLES.length) {
    parts.push(`Volley's ${VOLLEY_ROLES.length} shared roles`);
  } else if (s.missingRoles.length > 0) {
    parts.push(
      `the missing shared role${s.missingRoles.length === 1 ? "" : "s"} ${list(s.missingRoles.map(roleName))}`,
    );
  }
  if (s.missingIds.length === FIXED_IDENTITIES.length) {
    parts.push(`the identities ${list(s.missingIds)}`);
  } else if (s.missingIds.length > 0) {
    parts.push(
      `the missing identit${s.missingIds.length === 1 ? "y" : "ies"} ${list(s.missingIds)}`,
    );
  }
  const what: string[] = [];
  if (parts.length > 0) {
    what.push(`Create ${parts.join(" and ")}${passwordNote(s.missingIds, remote)}`);
  }
  if (s.partialIds.length > 0) what.push(`Give ${list(s.partialIds)} their missing roles`);
  // init writes it along with the identities; alone, it is the whole change.
  if (adminFileMissing && what.length === 0)
    what.push(`Write ${adminFile} (the admin login volleyd mints agents with)`);
  return what.join("; ");
}

export async function planAccounts(ctx: SetupContext): Promise<StepPlan> {
  const plan: StepPlan = { step: "accounts", title: "Accounts", found: [], changes: [] };
  const { dir, deps } = ctx.auth;
  let link: AdminLink;
  try {
    link = await openAdmin(ctx.auth);
  } catch (e) {
    plan.blocked = `the broker does not take the admin login yet (the security step is not done): ${e instanceof Error ? e.message : String(e)}`;
    return plan;
  }
  let state: BrokerState;
  try {
    state = await brokerState(link);
  } finally {
    await link.close().catch(() => {});
  }

  const coordinatorFile = join(dir, "coordinator.json");
  const brokerFile = join(ctx.volleydHome, VOLLEYD_BROKER_FILE);
  const adminFile = join(ctx.volleydHome, VOLLEYD_ADMIN_FILE);
  const adminFileMissing = !existsSync(adminFile);

  const present = FIXED_IDENTITIES.filter((u) => !state.missingIds.includes(u));
  if (present.length > 0) plan.found.push(`Identities on the broker: ${list(present)}`);
  if (state.missingRoles.length === 0 && state.drifted.length === 0) {
    plan.found.push(`The ${VOLLEY_ROLES.length} shared roles match this Volley`);
  }

  if (
    state.missingRoles.length > 0 ||
    state.missingIds.length > 0 ||
    state.partialIds.length > 0 ||
    adminFileMissing
  ) {
    plan.changes.push({
      summary: createSummary(state, adminFileMissing, adminFile, ctx.deliverToken !== undefined),
      detail: "volley auth init --no-config --coordinator-file --volleyd-file",
      apply: () => runInit(ctx),
    });
  }

  // A login whose credential file is gone: its password is unknown, so it gets a new one.
  const rotate: { user: FixedIdentity; file: string }[] = [];
  if (!state.missingIds.includes("coordinator") && readable(coordinatorFile) === null) {
    rotate.push({ user: "coordinator", file: coordinatorFile });
  }
  if (!state.missingIds.includes("volleyd") && readable(brokerFile) === null) {
    rotate.push({ user: "volleyd", file: brokerFile });
  }
  for (const r of rotate) {
    plan.changes.push({
      summary: `New password for ${r.user}, written to ${r.file} (disconnects its sessions)`,
      apply: async () => {
        const password = await newPassword(ctx, r.user);
        const owner = r.user === "volleyd" ? sudoUser(ctx) : null;
        ensureOwnedDir(deps, dirname(r.file), owner);
        writeSecret(r.file, `${JSON.stringify({ username: r.user, password })}\n`);
        if (owner !== null) deps.chown(r.file, owner.uid, owner.gid);
        return [`Wrote ${r.file} (mode 0600) with ${r.user}'s new password.`];
      },
    });
  }

  if (state.drifted.length > 0) {
    const names = list(state.drifted.map((d) => roleName(d.role)));
    plan.changes.push({
      summary: `Update the drifted role${state.drifted.length === 1 ? "" : "s"} ${names} (volley auth migrate --roles; disconnects every client holding ${state.drifted.length === 1 ? "it" : "them"})`,
      detail: driftDetail(state.drifted),
      apply: () => runInit(ctx, { migrate: true, roles: true, yes: true }),
    });
  }

  // The operator's own login: the coordinator's.
  const coordinator = readable(coordinatorFile);
  const coordinatorChanges =
    state.missingIds.includes("coordinator") || rotate.some((r) => r.user === "coordinator");
  if (ctx.deps.platform === "darwin") {
    let stored = false;
    if (coordinator !== null && !coordinatorChanges) {
      const r = await ctx.deps.exec([
        "security",
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        "coordinator",
        "-w",
      ]);
      stored = r.code === 0 && r.stdout.replace(/\n$/, "") === coordinator.password;
    }
    if (stored) plan.found.push(`The coordinator's login is in the keychain (${KEYCHAIN_SERVICE})`);
    else {
      plan.changes.push({
        summary: `Store the coordinator's broker login in the macOS keychain (service ${KEYCHAIN_SERVICE})`,
        detail: `security -i, fed on stdin: add-generic-password -U -s ${KEYCHAIN_SERVICE} -a coordinator -w <password> (never on a command line)`,
        apply: async () => {
          const c = readCredentials(coordinatorFile);
          if (c === null) throw new Error(`${coordinatorFile} does not exist`);
          // `security -i` reads its commands from stdin: the password never reaches argv (`ps`).
          const r = await ctx.deps.exec(["security", "-i"], {
            input: `${keychainAddCommand(c.password)}\n`,
          });
          // -i reports a failed command on stderr, not always in its exit code: read it back.
          const back = await ctx.deps.exec([
            "security",
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            "coordinator",
            "-w",
          ]);
          if (r.code !== 0 || back.code !== 0 || back.stdout.replace(/\n$/, "") !== c.password) {
            throw new Error(
              `security add-generic-password failed (exit ${r.code}): ${(r.stderr || back.stderr).trim()}`,
            );
          }
          return [`Stored the coordinator's login in the keychain (service ${KEYCHAIN_SERVICE}).`];
        },
      });
    }
  } else if (coordinator !== null) {
    plan.found.push(`The coordinator's login: ${coordinatorFile} (mode 0600; no OS keychain here)`);
  }

  if (!ctx.repair) {
    const admin = readAccounts(dir).find((a) => a.role === "admin");
    const pending = pendingTokens(ctx, (t) => t.kind === "admin")[0];
    if (admin !== undefined)
      plan.found.push(`An admin account exists (admin account ${admin.name})`);
    else if (pending !== undefined) {
      plan.found.push(
        `A one-time admin token is pending until ${pending.expires_at} (\`volley auth token\` issues another)`,
      );
    } else plan.changes.push(adminTokenChange(ctx));
  }
  return plan;
}

/** Give a fixed identity a new password on the broker (its sessions are disconnected). */
async function newPassword(ctx: SetupContext, user: FixedIdentity): Promise<string> {
  const password = ctx.auth.deps.generatePassword();
  const l = await openAdmin(ctx.auth);
  try {
    const [a] = await l.session.run([cmd.setClientPassword(user, password)]);
    if (a !== undefined && classify(a) === "missing") {
      throw new Error(`no ${user} login on the broker yet: apply the accounts step first`);
    }
    if (a === undefined || classify(a) !== "ok") {
      throw new Error(`setClientPassword ${user}: ${a?.error ?? "no answer"}`);
    }
  } finally {
    await l.close().catch(() => {});
  }
  return password;
}

/**
 * A new password for the shared `desk` login (the one `volley dash` and a Desk without a token
 * sign in as). No file keeps it, so this is how the Desk issues one when a device needs it: the
 * caller shows it once. Signs out whatever uses the old one.
 */
export const newDeskPassword = (ctx: SetupContext): Promise<string> => newPassword(ctx, "desk");

function adminTokenChange(ctx: SetupContext): Change {
  return {
    summary:
      "Issue a one-time admin token (10 minutes, single use) to sign in to the Desk as admin",
    detail:
      ctx.deliverToken === undefined
        ? "volley auth token: printed here only; tokens.json keeps its hash"
        : "volley auth token: shown once, to this browser only; tokens.json keeps its hash",
    apply: async () => {
      const deliver = ctx.deliverToken;
      if (deliver === undefined) {
        const code = await accountVerb(
          ctx.auth,
          "token",
          undefined,
          {
            json: false,
            deskUrl: `http://localhost:${ctx.deskPort}/`,
            deskHost: ctx.deskHost,
          },
          (fn) => withAdmin(ctx.auth, fn),
        );
        if (code !== 0) throw new Error("`volley auth token` failed (its error is above)");
        return [];
      }
      // The token comes back as JSON on a captured stdout and goes to `deliver` only.
      const capture = makeBufferIO({ now: () => ctx.auth.io.now() });
      const code = await accountVerb(
        { ...ctx.auth, io: { ...capture, stderr: ctx.auth.io.stderr } },
        "token",
        undefined,
        { json: true },
        (fn) => withAdmin(ctx.auth, fn),
      );
      if (code !== 0) throw new Error("`volley auth token` failed (its error is above)");
      const { token, expires_at } = JSON.parse(capture.readStdout()) as {
        token: string;
        expires_at: string;
      };
      const tokenId = tokenIdOf(token) ?? "";
      deliver({ token, token_id: tokenId, expires_at });
      return [`Issued a one-time admin token (${tokenId}, until ${expires_at}).`];
    },
  };
}

export interface PendingToken {
  id: string;
  kind: string;
  role: string;
  label?: string;
  expires_at: string;
  used_at?: string;
}

/** tokens.json entries not used and not expired, matching `pick`. */
export function pendingTokens(
  ctx: SetupContext,
  pick: (t: PendingToken) => boolean,
): PendingToken[] {
  const file = join(ctx.auth.dir, "tokens.json");
  if (!existsSync(file)) return [];
  const now = ctx.auth.io.now().getTime();
  const tokens =
    (JSON.parse(readFileSync(file, "utf-8")) as { tokens?: PendingToken[] }).tokens ?? [];
  return tokens.filter((t) => t.used_at === undefined && Date.parse(t.expires_at) > now && pick(t));
}

/** The device label of the phone's sign-in link (and of the account it redeems for). */
export const PHONE_LABEL = "Desk on phone";

/** The Desk URL a sign-in token travels in (SPEC: `<desk_url>#signin=<token>`). */
export function signinUrl(host: string, port: number, token: string): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}/#signin=${token}`;
}

/**
 * Step 5 of `volley setup`: a one-time `steer` sign-in link for the phone, as a QR code and a URL
 * in the terminal (10 minutes, single use; only its hash is stored). Done while one is pending
 * or once the phone has redeemed one; skipped while a phone cannot reach the broker's WebSocket
 * listener (LAN access off), so no link is spent on a page that could not sign in.
 */
export async function planPhone(ctx: SetupContext): Promise<StepPlan> {
  const plan: StepPlan = { step: "phone", title: "Phone", found: [], changes: [] };
  if (ctx.repair) {
    plan.found.push(
      `Skipped under --repair (\`volley auth signin-link --role steer --label "${PHONE_LABEL}"\` issues a link any time)`,
    );
    return plan;
  }
  const signedIn = readAccounts(ctx.auth.dir).find((a) => a.label === PHONE_LABEL);
  const pending = pendingTokens(ctx, (t) => t.kind === "signin" && t.label === PHONE_LABEL)[0];
  if (signedIn !== undefined) {
    plan.found.push(`The phone is signed in (account ${signedIn.name}, role ${signedIn.role})`);
    return plan;
  }
  if (pending !== undefined) {
    plan.found.push(
      `A phone sign-in link is pending until ${pending.expires_at} (it cannot be shown again; once it expires, rerun \`volley setup\` for a new one)`,
    );
    return plan;
  }
  // The page a phone loads connects to port 9001 on the host it came from: without that reach a
  // sign-in link (single use) would be wasted.
  const ws = lanWsUrl(ctx);
  if ((await ctx.deps.probeAnonymous(ws)) === "unreachable") {
    plan.skipped = `a phone cannot reach the broker's WebSocket listener at ${ws} (it is on this machine only). Rerun \`volley setup --lan\` to open it to your network, or reach this machine over a tunnel; then \`volley auth signin-link --role steer --label "${PHONE_LABEL}"\` issues the link`;
    return plan;
  }
  plan.changes.push({
    summary: `Issue a one-time steer sign-in link for "${PHONE_LABEL}" (10 minutes, single use), shown as a QR code`,
    detail: `volley auth signin-link --role steer --label "${PHONE_LABEL}"; the link opens http://${ctx.deskHost}:${ctx.deskPort}/`,
    apply: async () => {
      // The token comes back as JSON on a captured stdout; only the terminal ever shows it.
      const capture = makeBufferIO({ now: () => ctx.auth.io.now() });
      const code = await accountVerb(
        { ...ctx.auth, io: { ...capture, stderr: ctx.auth.io.stderr } },
        "signin-link",
        undefined,
        { role: "steer", label: PHONE_LABEL, json: true },
        (fn) => withAdmin(ctx.auth, fn),
      );
      if (code !== 0) throw new Error("`volley auth signin-link` failed (its error is above)");
      const { token, expires_at } = JSON.parse(capture.readStdout()) as {
        token: string;
        expires_at: string;
      };
      const url = signinUrl(ctx.deskHost, ctx.deskPort, token);
      ctx.auth.io.stdout(
        [
          "",
          "Scan with your phone to open the Desk, signed in as steer:",
          "",
          renderQr(encodeQr(url)),
          `  ${url}`,
          "",
          `It signs in one device once (single use) and expires at ${expires_at} (10 minutes). Only its hash is stored.`,
          "",
        ].join("\n"),
      );
      return [];
    },
  });
  return plan;
}
