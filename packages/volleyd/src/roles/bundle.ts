import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExecFn } from "../exec";
import { lastLine } from "./health";

/**
 * A supervisor move's bundle (SPEC §4.6.24; #247's manifest): what travels from the old
 * supervisor's machine to the new one, as a gzip tar `volley role receive` restores there.
 *
 *   volleyd/  from $VOLLEYD_HOME: waves/** (journals and snapshots, never a log), config.yaml,
 *             peers.json, peer-codes.json, claude-usage.json, roles.json and the move's own
 *             roles/<move_id>/handover.json
 *   auth/     the auth dir's accounts.json, tokens.json, admin.json, coordinator.json
 *   claude/   the Claude profiles root's accounts.json (the registry, never a profile)
 *   broker/   the broker's Dynamic Security state file, only `with_broker` (a broker move)
 *
 * Never: worktrees, cmux.json, logs, setup.json, broker.json / dynsec-admin.json (the target's
 * receive mints volleyd's login afresh), a profile directory. `manifest.json` lists every file
 * with its sha256, so the receive refuses a bundle that is not exactly this one.
 */

export interface BundleSources {
  volleydHome: string;
  /** The auth dir `volley auth` uses here; null when there is none to carry. */
  authDir: string | null;
  /** `$VOLLEY_CLAUDE_DIR` (default `~/.volley/claude`). */
  claudeRoot: string;
  /** The broker's state file (`with_broker` only); null when not known. */
  stateFile?: string | null;
}

export interface Manifest {
  version: 1;
  move_id: string;
  role: "supervisor" | "broker";
  from: string;
  to: string;
  with_broker: boolean;
  files: { path: string; sha256: string }[];
}

const VOLLEYD_FILES = [
  "config.yaml",
  "peers.json",
  "peer-codes.json",
  "claude-usage.json",
  "roles.json",
];
const AUTH_FILES = ["accounts.json", "tokens.json", "admin.json", "coordinator.json"];

/** Every file under `dir` (relative paths, sorted), never a log; none when it does not exist. */
function filesUnder(dir: string, rel = ""): string[] {
  const here = join(dir, rel);
  if (!existsSync(here)) return [];
  const out: string[] = [];
  for (const name of readdirSync(here).sort()) {
    const r = rel === "" ? name : `${rel}/${name}`;
    const st = statSync(join(dir, r));
    if (st.isDirectory()) out.push(...filesUnder(dir, r));
    else if (st.isFile() && !name.endsWith(".log")) out.push(r);
  }
  return out;
}

/** The travel set: each file's path in the bundle and where it is read from here. */
export function travelSet(
  src: BundleSources,
  moveId: string,
  withBroker: boolean,
): { path: string; from: string }[] {
  const out: { path: string; from: string }[] = [];
  const add = (path: string, from: string) => {
    if (existsSync(from) && statSync(from).isFile()) out.push({ path, from });
  };
  const v = src.volleydHome;
  for (const f of filesUnder(join(v, "waves"))) add(`volleyd/waves/${f}`, join(v, "waves", f));
  for (const f of VOLLEYD_FILES) add(`volleyd/${f}`, join(v, f));
  add(`volleyd/roles/${moveId}/handover.json`, join(v, "roles", moveId, "handover.json"));
  if (src.authDir !== null) for (const f of AUTH_FILES) add(`auth/${f}`, join(src.authDir, f));
  add("claude/accounts.json", join(src.claudeRoot, "accounts.json"));
  if (withBroker && src.stateFile != null) add(`broker/${basename(src.stateFile)}`, src.stateFile);
  return out;
}

/** The bundle's tar: `tar -czf <out> -C <stage> --files-from <list>` (the fence's exact shape). */
export const tarArgv = (out: string, stage: string, list: string) => [
  "tar",
  "-czf",
  out,
  "-C",
  stage,
  "--files-from",
  list,
];

/**
 * Stage the travel set and its manifest under `dir/stage`, tar it to `dir/bundle.tgz` (mode
 * 0600) and remove the stage. Copies are made here, by this process: the only command is the tar.
 */
export async function makeBundle(
  exec: ExecFn,
  src: BundleSources,
  o: { move_id: string; from: string; to: string; with_broker: boolean; dir: string },
): Promise<{ path: string; manifest: Manifest }> {
  const files = travelSet(src, o.move_id, o.with_broker).map(({ path, from }) => ({
    path,
    data: readFileSync(from),
  }));
  return pack(exec, files, { ...o, role: "supervisor" });
}

/**
 * A broker move's bundle (SPEC §4.6.24; `volley broker receive` reads it): the old broker's
 * Dynamic Security state file (`broker/<its name>`), its admin login (`auth/admin.json`) and the
 * move's choices (`broker/choices.json`: `lan`). mosquitto's persistence DB never travels: the
 * new broker starts empty.
 */
export async function makeBrokerBundle(
  exec: ExecFn,
  src: { stateFile: string; adminFile: string; lan: boolean },
  o: { move_id: string; from: string; to: string; dir: string },
): Promise<{ path: string; manifest: Manifest }> {
  const files = [
    { path: `broker/${basename(src.stateFile)}`, data: readFileSync(src.stateFile) },
    { path: "broker/choices.json", data: Buffer.from(`${JSON.stringify({ lan: src.lan })}\n`) },
    { path: "auth/admin.json", data: readFileSync(src.adminFile) },
  ];
  return pack(exec, files, { ...o, role: "broker", with_broker: true });
}

/** Stage `files` and their manifest under `dir/stage`, tar them to `dir/bundle.tgz` (0600). */
async function pack(
  exec: ExecFn,
  entries: { path: string; data: Buffer }[],
  o: {
    move_id: string;
    from: string;
    to: string;
    with_broker: boolean;
    dir: string;
    role: Manifest["role"];
  },
): Promise<{ path: string; manifest: Manifest }> {
  const stage = join(o.dir, "stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const files = entries.map(({ path, data }) => {
      const to = join(stage, path);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      writeFileSync(to, data, { mode: 0o600 });
      chmodSync(to, 0o600);
      return { path, sha256: createHash("sha256").update(data).digest("hex") };
    });
    const manifest: Manifest = {
      version: 1,
      move_id: o.move_id,
      role: o.role,
      from: o.from,
      to: o.to,
      with_broker: o.with_broker,
      files,
    };
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    const list = join(o.dir, "files.txt");
    writeFileSync(list, `${["manifest.json", ...files.map((f) => f.path)].join("\n")}\n`, {
      mode: 0o600,
    });
    const out = join(o.dir, "bundle.tgz");
    rmSync(out, { force: true });
    const r = await exec(tarArgv(out, stage, list));
    if (r.code !== 0) throw new Error(`tar: ${lastLine(r)}`);
    chmodSync(out, 0o600);
    return { path: out, manifest };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
