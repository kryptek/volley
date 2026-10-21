import { join } from "node:path";
import { DEPLOY, type ServiceUnit, TAG_RE, deskDir } from "./plan";

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
      (gis("checkout", arg(1), "--") && BRANCH_RE.test(arg(1)) && !arg(1).includes("..")) ||
      (gis("stash", "push", "-u", "-m", arg(4)) && STASH_RE.test(arg(4))) ||
      (is(bun, "install", "--frozen-lockfile") && opts?.cwd === repo) ||
      (is(bun, "run", "build") && opts?.cwd === deskDir(repo)) ||
      is(bun, volleyCli, "--version") ||
      is(bun, volleydCli, "validate", fixture) ||
      restarts.includes(argv.join("\0"));
    if (!ok) throw new Error(`volley deploy does not run \`${argv.join(" ")}\``);
  };
}
