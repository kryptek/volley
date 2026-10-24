import { join } from "node:path";
import { PEER_DEFAULTS } from "../commands/peer";
import { sshCommand } from "../deploy/peers";

/**
 * How `volley machine add` reaches the box: one interactive `ssh` (the terminal inherited, so a
 * password or host-key prompt is ssh's own, never ours) whose only action installs this
 * machine's key in the box's `authorized_keys`; after it, every step is `ssh -T -o
 * BatchMode=yes … <target> bash -s` with its script on stdin, the shape `volley deploy` uses for
 * paired machines (`sshCommand`). `ssh -t` only where a person answers on the box: a sudo the
 * installer needs, and `gh auth login --web`.
 *
 * Every remote script and command string is rendered by a `Scripts` registry, and the fence
 * (`machineFence`) runs nothing on the box that the registry did not render: a raw script or
 * command is refused.
 */

/**
 * The box's PATH for a step: its own first, then where the installers put Volley, bun, Claude
 * Code and Homebrew (a non-interactive ssh session's PATH lacks them, a Mac's above all).
 */
export const BOX_PATH =
  'export PATH="$HOME/.volley/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH:/opt/homebrew/bin:/usr/local/bin"';

/** A single-quoted shell word. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The argv of every batch step: `sshCommand`'s, the script on stdin. */
export const batchArgv = (target: string): string[] => sshCommand(target, { argv: [] }).argv;

const connectTimeout = `ConnectTimeout=${PEER_DEFAULTS.ssh_connect_timeout_s}`;

/** The one interactive connect: runs `command` (the key install), prompts are ssh's. */
export const connectArgv = (target: string, command: string): string[] => [
  "ssh",
  "-o",
  connectTimeout,
  target,
  command,
];

/** A step a person answers on the box (sudo's prompt, gh's code): `ssh -t`, the terminal inherited. */
export const ttyArgv = (target: string, command: string): string[] => [
  "ssh",
  "-t",
  "-o",
  connectTimeout,
  target,
  command,
];

/** This machine's key, created when it has none (`ssh-keygen`, no passphrase: BatchMode needs none). */
export const keygenArgv = (home: string): string[] => [
  "ssh-keygen",
  "-t",
  "ed25519",
  "-N",
  "",
  "-q",
  "-f",
  join(home, ".ssh", "id_ed25519"),
];

/** A Mac's Remote Login (sshd) as launchd has it: exit 0 when it is on. */
export const REMOTE_LOGIN_ARGV = ["launchctl", "print", "system/com.openssh.sshd"] as const;

/** A public key line as `authorized_keys` holds it: `<type> <base64> [comment]`. */
export const PUBKEY_RE =
  /^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/=]+( [^\n'\\]*)?$/;

/** The scripts and command strings this run may send to the box (and nothing else). */
export class Scripts {
  private readonly rendered = new Set<string>();

  /** A `bash -s` script: the box's PATH, then `body`. */
  script(body: string): string {
    const s = `${BOX_PATH}\n${body.endsWith("\n") ? body : `${body}\n`}`;
    this.rendered.add(s);
    return s;
  }

  /**
   * A command string for `ssh <target> <command>`: run by `sh -c`, so the box's login shell
   * (zsh, fish) only passes it on.
   */
  command(body: string): string {
    const c = `sh -c ${sq(`${BOX_PATH}\n${body}`)}`;
    this.rendered.add(c);
    return c;
  }

  has(s: string | undefined): boolean {
    return s !== undefined && this.rendered.has(s);
  }
}

/** What the fence lets `volley machine add` run on this machine (the hub). */
export interface MachineFenceInputs {
  target: string;
  name: string;
  home: string;
  /** argv that runs this volley CLI (the Claude sign-in goes through volleyd, as `volley claude add`). */
  volleyArgv: readonly string[];
  scripts: Scripts;
}

/**
 * The authority fence over `volley machine add`'s exec: the batch shape with a rendered script on
 * stdin, the interactive connect and `ssh -t` with a rendered command, all to `target` only;
 * this machine's key creation; a Mac's Remote Login check; and the box's Claude sign-in through
 * volleyd. Throws on anything else.
 */
export function machineFence({ target, name, home, volleyArgv, scripts }: MachineFenceInputs) {
  const batch = batchArgv(target);
  const same = (argv: readonly string[], want: readonly string[]) =>
    argv.length === want.length && want.every((w, i) => argv[i] === w);
  const claudeAdd = [...volleyArgv, "claude", "add", name, "--machine", name, "--wait"];
  return (argv: readonly string[], opts?: { input?: string }): void => {
    const last = argv[argv.length - 1];
    const ok =
      (same(argv, batch) && scripts.has(opts?.input)) ||
      (argv.length === 5 && same(argv, connectArgv(target, last ?? "")) && scripts.has(last)) ||
      (argv.length === 6 && same(argv, ttyArgv(target, last ?? "")) && scripts.has(last)) ||
      same(argv, keygenArgv(home)) ||
      same(argv, REMOTE_LOGIN_ARGV) ||
      same(argv, claudeAdd);
    if (!ok) {
      throw new Error(
        `volley machine add does not run \`${argv.slice(0, 5).join(" ")}${argv.length > 5 ? " …" : ""}\``,
      );
    }
  };
}
