import { join } from "node:path";
import {
  type Command,
  DEPLOY,
  RECORD_LOCK_ARGV,
  RESTART_PEER_ARGV,
  type Ref,
  type ServiceUnit,
  TAG_RE,
  deskDir,
  peerDoctorArgv,
} from "./plan";

/** What the deploy's exec may run: the fence's inputs. */
export interface DeployFenceInputs {
  /** The services checkout: every git command runs on it (`git -C <repo>`). */
  repo: string;
  /** The bun the services run. */
  bun: string;
  /** The two services' restarts. */
  services: ServiceUnit[];
}

/** A branch name the rollback may check out again (never an option, never a path spec). */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export const isRollbackBranch = (name: string) => BRANCH_RE.test(name) && !name.includes("..");
const SHA_RE = /^[0-9a-f]{40}$/;
const STASH_RE = new RegExp(`^${DEPLOY.stash_prefix}\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z$`);

/**
 * The authority fence over `volley deploy`'s exec, after `setupFence`: the exact argv shapes the
 * deploy runs, on the services checkout only, nothing else. Throws on any other argv (so never
 * `git push`, `reset`, `clean` or `checkout -- <paths>`).
 */
export function deployFence({ repo, bun, services }: DeployFenceInputs) {
  const volleyCli = join(repo, "packages", "volley-cli", "src", "cli.ts");
  const volleydCli = join(repo, "packages", "volleyd", "src", "cli.ts");
  const fixture = join(repo, "packages", "volleyd", "test", "fixtures", "example.yaml");
  const restarts = services.map((s) => s.restart.join("\0"));
  return (argv: readonly string[], opts?: { cwd?: string }): void => {
    const is = (...want: string[]) =>
      argv.length === want.length && want.every((w, i) => argv[i] === w);
    const g = argv[0] === "git" && argv[1] === "-C" && argv[2] === repo ? argv.slice(3) : null;
    const gis = (...want: string[]) =>
      g !== null && g.length === want.length && want.every((w, i) => g[i] === w);
    const arg = (i: number) => (g?.[i] ?? "") as string;
    const ok =
      gis("status", "--porcelain") ||
      gis("fetch", "--tags", "origin") ||
      gis("tag", "--list", "v*") ||
      gis("rev-parse", "--abbrev-ref", "HEAD") ||
      gis("rev-parse", "HEAD") ||
      gis("describe", "--tags", "--exact-match", "HEAD") ||
      (gis("checkout", "--detach", arg(2)) && (TAG_RE.test(arg(2)) || SHA_RE.test(arg(2)))) ||
      (gis("checkout", arg(1), "--") && isRollbackBranch(arg(1))) ||
      (gis("stash", "push", "-u", "-m", arg(4)) && STASH_RE.test(arg(4))) ||
      (is(bun, "install", "--frozen-lockfile") && opts?.cwd === repo) ||
      (is(bun, "run", "build") && opts?.cwd === deskDir(repo)) ||
      is(bun, volleyCli, "--version") ||
      is(bun, volleydCli, "validate", fixture) ||
      restarts.includes(argv.join("\0"));
    if (!ok) throw new Error(`volley deploy does not run \`${argv.join(" ")}\``);
  };
}

/** A paired machine as the deploy reaches it: its name, ssh target and volley checkout. */
export interface PairedPeer {
  name: string;
  target: string;
  volleyDir: string;
}

/**
 * The fence over the commands `volley deploy` runs on a paired machine: the read-only git queries,
 * the fetch, a checkout of `tag` or of the ref the machine was at (`from`, its rollback), the
 * install and its lock record in the machine's volley checkout, the service restart and the
 * doctor. Throws on any other command (so never another branch, `git reset`, or `rm`).
 */
export function peerFence(peer: PairedPeer, refs: { tag: string; from: Ref | null }) {
  const dir = peer.volleyDir;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((w, i) => w === b[i]);
  const from = refs.from;
  return (c: Command): void => {
    const g =
      c.argv[0] === "git" && c.argv[1] === "-C" && c.argv[2] === dir ? c.argv.slice(3) : null;
    const gis = (...want: string[]) => g !== null && same(g, want);
    const inDir = c.cwd === dir;
    const ok =
      gis("status", "--porcelain") ||
      gis("rev-parse", "--abbrev-ref", "HEAD") ||
      gis("rev-parse", "HEAD") ||
      gis("describe", "--tags", "--exact-match", "HEAD") ||
      gis("fetch", "--tags", "origin") ||
      gis("checkout", "--detach", refs.tag) ||
      (from !== null &&
        (from.kind === "branch"
          ? gis("checkout", from.name, "--") && isRollbackBranch(from.name)
          : gis("checkout", "--detach", from.name) &&
            (TAG_RE.test(from.name) || SHA_RE.test(from.name)))) ||
      (same(c.argv, ["bun", "install", "--frozen-lockfile"]) && inDir) ||
      (same(c.argv, RECORD_LOCK_ARGV) && inDir) ||
      same(c.argv, RESTART_PEER_ARGV) ||
      (same(c.argv, peerDoctorArgv(dir)) && inDir);
    if (!ok) throw new Error(`volley deploy does not run \`${c.argv.join(" ")}\` on ${peer.name}`);
  };
}
