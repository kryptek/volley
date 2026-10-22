import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_ENV, renderSigninScript } from "../src/claude/signin-script";

/**
 * Grep-guard: volleyd never reads, stores or forwards a Claude credential (the accounts spike,
 * sections (a) and (b)). No source line outside a comment names where Claude Code keeps one — the
 * profile's `.credentials.json` (its fallback when the Keychain is locked), the Keychain item
 * `Claude Code-credentials[-<hash>]` or the `security` calls that read it — or the
 * `setup-token` flow, which prints a bearer token. The credential env variables appear only in
 * CREDENTIAL_ENV, which launch.sh and signin.sh `unset`. The same holds for the machine doctor
 * (`volley peer doctor`, volley-cli's `src/peer/`), which runs `claude auth status` and reads
 * `~/.claude.json` on every paired machine, with one exception (SPEC §4.6.11): its usage probe,
 * `usage-probe.ts`, which reads a login's token on the machine that holds it, read-only, through
 * exactly the Keychain lookup and the file named below.
 */

const SRC = new URL("../src/", import.meta.url).pathname;
const PEER_DOCTOR = new URL("../../volley-cli/src/peer/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? sourceFiles(join(dir, d.name))
      : d.name.endsWith(".ts")
        ? [join(dir, d.name)]
        : [],
  );
}

const TOKEN_LOCATIONS = [
  /\.credentials\.json/,
  /Claude Code-credentials/,
  /find-generic-password|find-internet-password|dump-keychain/,
  /\bsecurity\b["'`,\s]+(?:find|dump|export)/,
  /setup-token/,
  /CLAUDE_SECURESTORAGE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY/,
];

/** Code lines (comments stripped) that name a token location, as `file:line: text`. */
function offenders(file: string): string[] {
  const rel = relative(SRC, file);
  return readFileSync(file, "utf-8")
    .split("\n")
    .flatMap((line, i) => {
      if (/^\s*(\/\*|\*|\/\/)/.test(line)) return [];
      const code = line.replace(/\/\/.*$/, "");
      return TOKEN_LOCATIONS.some((re) => re.test(code)) ? [`${rel}:${i + 1}: ${line.trim()}`] : [];
    });
}

describe("no Claude credential handling in volleyd", () => {
  it("the detector catches what it guards against", () => {
    const hits = (line: string) => TOKEN_LOCATIONS.some((re) => re.test(line));
    expect(hits('readFileSync(join(dir, ".credentials.json"))')).toBe(true);
    expect(hits('exec(["security", "find-generic-password", "-s", svc])')).toBe(true);
    expect(hits("`Claude Code-credentials-${hash}`")).toBe(true);
    expect(hits('exec(["claude", "setup-token"])')).toBe(true);
    expect(hits("env.CLAUDE_CODE_OAUTH_TOKEN = token")).toBe(true);
    expect(hits('exec(["claude", "auth", "status"])')).toBe(false);
  });

  it("the machine doctor's modules name no token location and no credential env", () => {
    const files = sourceFiles(PEER_DOCTOR).filter((f) => !f.endsWith("/usage-probe.ts"));
    // The doctor and every check family are scanned (a module that moves away must be followed).
    expect(files.map((f) => relative(PEER_DOCTOR, f)).sort()).toEqual(
      expect.arrayContaining([
        "doctor.ts",
        "checks/claude.ts",
        "checks/github.ts",
        "checks/machine.ts",
        "checks/repo.ts",
        "checks/tools.ts",
      ]),
    );
    expect(files.flatMap(offenders)).toEqual([]);
  });

  it("the usage probe is the one exception: a Keychain lookup and the credentials file, read-only", () => {
    const probe = join(PEER_DOCTOR, "usage-probe.ts");
    const lines = offenders(probe).map((o) => o.replace(/^.*?:\d+: /, ""));
    // Exactly the reads of SPEC §4.6.11's exception; never a write, a dump or a token flow.
    expect(lines).toEqual([
      'if (dir === null) return "Claude Code-credentials";',
      "return `Claude Code-credentials-${h}`;",
      '"find-generic-password",',
      'text = readFileSync(join(login.dir, ".credentials.json"), "utf-8");',
    ]);
    const text = readFileSync(probe, "utf-8");
    expect(text).not.toMatch(
      /add-generic-password|delete-generic-password|dump-keychain|setup-token|writeFileSync\([^)]*credentials/,
    );
  });

  it("a paired machine's sign-in (remote-signin, forward) names none and unsets the credential env there", () => {
    const files = sourceFiles(join(SRC, "claude")).filter((f) =>
      /\/(remote-signin|forward|signin-script)\.ts$/.test(f),
    );
    expect(files.map((f) => relative(SRC, f)).sort()).toEqual([
      "claude/forward.ts",
      "claude/remote-signin.ts",
      "claude/signin-script.ts",
    ]);
    const listed = new Set(CREDENTIAL_ENV.map((k) => `claude/signin-script.ts: "${k}",`));
    expect(files.flatMap(offenders).filter((o) => !listed.has(o.replace(/:\d+:/, ":")))).toEqual(
      [],
    );
    // The box's script (no profile dir) still unsets every credential variable.
    const script = renderSigninScript({ signinDir: "/path/to/home/.volley/signin/primary" });
    expect(script).toContain(`unset ${CREDENTIAL_ENV.join(" ")}`);
    expect(script).not.toMatch(/setup-token|CLAUDE_CONFIG_DIR/);
  });

  it("src/ names no token location; the credential env lives only in CREDENTIAL_ENV", () => {
    // CREDENTIAL_ENV's own entries (the list launch.sh and signin.sh unset) are the one exception.
    const listed = new Set(CREDENTIAL_ENV.map((k) => `claude/signin-script.ts: "${k}",`));
    const rest = sourceFiles(SRC)
      .flatMap(offenders)
      .filter((o) => !listed.has(o.replace(/:\d+:/, ":")));
    expect(rest).toEqual([]);
    expect(CREDENTIAL_ENV).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    ]);
  });
});
