import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthDeps, auth } from "../../src/commands/auth";
import { makeBufferIO } from "../../src/io";

/**
 * A fake `mosquitto_passwd` that keeps the file format (`user:hash` per line) so tests
 * can assert on file contents without the real binary or a real broker.
 */
function fakeDeps(): AuthDeps & {
  calls: string[][];
  reloads: number;
  chowns: [string, number, number][];
} {
  let n = 0;
  const deps = {
    calls: [] as string[][],
    reloads: 0,
    chowns: [] as [string, number, number][],
    async passwd(args: string[]) {
      deps.calls.push(args);
      const create = args[0] === "-c";
      const del = args[0] === "-D";
      const [file, user, password] = args.slice(create ? 2 : 1) as [
        string,
        string,
        string | undefined,
      ];
      const lines = create || !existsSync(file) ? [] : readFileSync(file, "utf-8").split("\n");
      // Like the real mosquitto_passwd 2.x: -D on an unknown user warns and exits 1.
      if (del && !lines.some((l) => l.startsWith(`${user}:`))) {
        return { code: 1, stderr: `Warning: User ${user} not found` };
      }
      const kept = lines.filter((l) => l !== "" && !l.startsWith(`${user}:`));
      if (!del) kept.push(`${user}:hashed(${password})`);
      writeFileSync(file, kept.length > 0 ? `${kept.join("\n")}\n` : "");
      return { code: 0, stderr: "" };
    },
    async reload() {
      deps.reloads++;
      return { ok: true, detail: "sent SIGHUP to mosquitto" };
    },
    generatePassword() {
      n++;
      return `pw-${n}`;
    },
    brokerOwner: (): { uid: number; gid: number } | null => null,
    chown(path: string, uid: number, gid: number) {
      deps.chowns.push([path, uid, gid]);
    },
  };
  return deps;
}

describe("volley auth", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "volley-auth-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (argv: string[], deps = fakeDeps()) => {
    const io = makeBufferIO();
    const code = await auth({ argv, env: { VOLLEYD_HOME: join(dir, "volleyd-home") }, io }, deps);
    return { code, stdout: io.readStdout(), stderr: io.readStderr(), deps };
  };

  describe("init", () => {
    it("writes a passwd file with the three fixed identities, the ACL, and prints the conf lines", async () => {
      const r = await run(["init", "--dir", dir]);
      expect(r.code).toBe(0);

      const passwd = readFileSync(join(dir, "passwd"), "utf-8");
      expect(passwd).toBe("volleyd:hashed(pw-1)\ndesk:hashed(pw-2)\ncoordinator:hashed(pw-3)\n");
      expect(r.deps.calls[0]?.[0]).toBe("-c"); // first call creates the file
      expect(statSync(join(dir, "passwd")).mode & 0o777).toBe(0o600);

      const acl = readFileSync(join(dir, "acl.conf"), "utf-8");
      expect(acl).toContain("pattern write volley/+/%u/status");
      expect(acl).toContain("user volleyd");

      expect(r.stdout).toContain("allow_anonymous false");
      expect(r.stdout).toContain(`password_file ${join(dir, "passwd")}`);
      expect(r.stdout).toContain(`acl_file ${join(dir, "acl.conf")}`);
      // Plaintext passwords are shown exactly once, here.
      expect(r.stdout).toContain("volleyd      pw-1");
      expect(r.stdout).toContain("desk         pw-2");
      expect(r.stdout).toContain("coordinator  pw-3");
      expect(r.deps.reloads).toBe(1);
    });

    it("refuses to overwrite an existing passwd file without --force", async () => {
      writeFileSync(join(dir, "passwd"), "volleyd:old\n");
      const r = await run(["init", "--dir", dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--force");
      expect(readFileSync(join(dir, "passwd"), "utf-8")).toBe("volleyd:old\n");

      const forced = await run(["init", "--dir", dir, "--force"]);
      expect(forced.code).toBe(0);
      expect(readFileSync(join(dir, "passwd"), "utf-8")).toContain("desk:hashed(pw-2)");
    });

    it("--force rotates the fixed identities in place and keeps minted agents", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      await run(["add-agent", "w1-t1-implementer-1", "--dir", dir], deps); // pw-4
      deps.calls.length = 0;

      const r = await run(["init", "--dir", dir, "--force"], deps);
      expect(r.code).toBe(0);
      // No -c: recreating the file would revoke (and, after the reload, kick) every agent.
      expect(deps.calls.every((c) => c[0] !== "-c")).toBe(true);
      expect(readFileSync(join(dir, "passwd"), "utf-8")).toBe(
        "w1-t1-implementer-1:hashed(pw-4)\nvolleyd:hashed(pw-5)\ndesk:hashed(pw-6)\ncoordinator:hashed(pw-7)\n",
      );
    });

    it("keeps an existing (possibly customised) acl.conf", async () => {
      writeFileSync(join(dir, "acl.conf"), "# my edits\n");
      const r = await run(["init", "--dir", dir]);
      expect(r.code).toBe(0);
      expect(readFileSync(join(dir, "acl.conf"), "utf-8")).toBe("# my edits\n");
      expect(r.stdout).toContain("Kept the existing");
    });

    it("removes a half-written passwd file when mosquitto_passwd fails mid-way", async () => {
      const deps = fakeDeps();
      const real = deps.passwd;
      deps.passwd = async (args) =>
        args.includes("desk") ? { code: 1, stderr: "Error: boom" } : real(args);
      const r = await run(["init", "--dir", dir], deps);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Error: boom");
      // A leftover passwd holding only volleyd would make the next plain `init` refuse.
      expect(existsSync(join(dir, "passwd"))).toBe(false);
    });

    it("as root, hands the dir and files to the broker's user so it can read them", async () => {
      const deps = fakeDeps();
      deps.brokerOwner = () => ({ uid: 101, gid: 102 });
      const r = await run(["init", "--dir", dir], deps);
      expect(r.code).toBe(0);
      expect(deps.chowns).toEqual([
        [dir, 101, 102],
        [join(dir, "acl.conf"), 101, 102],
        [join(dir, "passwd"), 101, 102],
      ]);
    });

    it("does not chown when there is no broker user to hand the files to", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      expect(deps.chowns).toEqual([]);
    });

    it("--no-reload skips the broker reload and says so", async () => {
      const r = await run(["init", "--dir", dir, "--no-reload"]);
      expect(r.code).toBe(0);
      expect(r.deps.reloads).toBe(0);
      expect(r.stderr).toContain("reload");
    });

    it("takes the directory from VOLLEY_AUTH_DIR", async () => {
      const io = makeBufferIO();
      const code = await auth(
        { argv: ["init"], env: { VOLLEY_AUTH_DIR: dir, VOLLEYD_HOME: join(dir, "vh") }, io },
        fakeDeps(),
      );
      expect(code).toBe(0);
      expect(existsSync(join(dir, "passwd"))).toBe(true);
    });

    it("--coordinator-file writes $VOLLEY_AUTH_DIR/coordinator.json (0600) with the coordinator password", async () => {
      const io = makeBufferIO();
      const code = await auth(
        {
          argv: ["init", "--coordinator-file"],
          env: { VOLLEY_AUTH_DIR: dir, VOLLEYD_HOME: join(dir, "vh") },
          io,
        },
        fakeDeps(),
      );
      expect(code).toBe(0);
      const path = join(dir, "coordinator.json");
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
        username: "coordinator",
        password: "pw-3",
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(io.readStdout()).toContain(path);
    });

    it("without --coordinator-file writes no coordinator.json; --force rotates an existing one", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      expect(existsSync(join(dir, "coordinator.json"))).toBe(false);

      writeFileSync(join(dir, "coordinator.json"), "{}");
      const r = await run(["init", "--dir", dir, "--force"], deps); // pw-4..pw-6
      expect(r.code).toBe(0);
      // A stale file would lock the coordinator's hooks out after the rotation.
      expect(JSON.parse(readFileSync(join(dir, "coordinator.json"), "utf-8"))).toEqual({
        username: "coordinator",
        password: "pw-6",
      });
      expect(statSync(join(dir, "coordinator.json")).mode & 0o777).toBe(0o600);
    });

    it("as root with --coordinator-file, warns that the coordinator's hooks cannot read the file", async () => {
      const deps = fakeDeps();
      deps.brokerOwner = () => ({ uid: 101, gid: 102 });
      const r = await run(["init", "--dir", dir, "--coordinator-file"], deps);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`${join(dir, "coordinator.json")} is now readable only by root`);
      expect(r.stdout).toContain("VOLLEY_AUTH_DIR");
      const plain = await run(["init", "--dir", mkdtempSync(join(tmpdir(), "va-"))], deps);
      expect(plain.stdout).not.toContain("readable only by root");
    });

    it("--volleyd-file writes $VOLLEYD_HOME/broker.json (0600, dir 0700) with the volleyd password", async () => {
      const r = await run(["init", "--dir", dir, "--volleyd-file"]);
      expect(r.code).toBe(0);
      const home = join(dir, "volleyd-home");
      const path = join(home, "broker.json");
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
        username: "volleyd",
        password: "pw-1",
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(r.stdout).toContain(path);
      expect(r.stdout).not.toContain("volleyd:              its config file");
    });

    it("without --volleyd-file writes no broker.json; --force rotates an existing one", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      const path = join(dir, "volleyd-home", "broker.json");
      expect(existsSync(path)).toBe(false);

      await run(["init", "--dir", dir, "--force", "--volleyd-file"], deps); // pw-4..pw-6
      writeFileSync(path, "{}");
      const r = await run(["init", "--dir", dir, "--force"], deps); // pw-7..pw-9
      expect(r.code).toBe(0);
      // A stale file would lock the daemon out after the rotation.
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
        username: "volleyd",
        password: "pw-7",
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it("--volleyd-file is only for init", async () => {
      await run(["init", "--dir", dir]);
      const r = await run(["add-agent", "w1-t1-implementer-1", "--dir", dir, "--volleyd-file"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--volleyd-file");
    });

    it("--coordinator-file is only for init", async () => {
      await run(["init", "--dir", dir]);
      const r = await run(["add-agent", "w1-t1-implementer-1", "--dir", dir, "--coordinator-file"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--coordinator-file");
    });
  });

  describe("add-agent / rm-agent", () => {
    it("add-agent appends the agent and prints its password once on stdout", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      deps.reloads = 0;

      const r = await run(["add-agent", "w1-t1-implementer-1", "--dir", dir], deps);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("pw-4\n");
      expect(readFileSync(join(dir, "passwd"), "utf-8")).toContain(
        "w1-t1-implementer-1:hashed(pw-4)",
      );
      expect(readFileSync(join(dir, "passwd"), "utf-8")).toContain("volleyd:hashed(pw-1)");
      expect(r.deps.reloads).toBe(1);
    });

    it("add-agent --json prints the identity-file broker block", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      const r = await run(["add-agent", "w1-t1-implementer-1", "--dir", dir, "--json"], deps);
      expect(JSON.parse(r.stdout)).toEqual({ username: "w1-t1-implementer-1", password: "pw-4" });
    });

    it("rm-agent removes the agent and reloads", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      await run(["add-agent", "w1-t1-implementer-1", "--dir", dir], deps);
      deps.reloads = 0;
      const r = await run(["rm-agent", "w1-t1-implementer-1", "--dir", dir], deps);
      expect(r.code).toBe(0);
      expect(readFileSync(join(dir, "passwd"), "utf-8")).not.toContain("w1-t1-implementer-1");
      expect(r.deps.reloads).toBe(1);
    });

    it("rejects an out-of-grammar id and the fixed identity names", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      for (const id of ["Bad Id", "volleyd", "desk", "coordinator"]) {
        for (const verb of ["add-agent", "rm-agent"]) {
          const r = await run([verb, id, "--dir", dir], deps);
          expect(r.code).toBe(2);
        }
      }
    });

    it("add-agent rejects ids the ACL's `+` would let reach reserved or foreign topics", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      // `volley/+/%u/status` with %u=registry matches volley/_system/registry/status;
      // an agent named `mailbox` has a registry entry any steering client can write.
      for (const id of ["registry", "leases", "health", "federation", "status", "mailbox"]) {
        const r = await run(["add-agent", id, "--dir", dir], deps);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("reserved");
      }
    });

    it("add-agent --ack-to grants the agent write on exactly those senders' mailboxes", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      const bundled = readFileSync(join(dir, "acl.conf"), "utf-8");
      const r = await run(
        [
          "add-agent",
          "w1-t1-implementer-1",
          "--ack-to",
          "coordinator-ab12",
          "--ack-to",
          "volleyd",
          "--dir",
          dir,
        ],
        deps,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("pw-4\n");
      const acl = readFileSync(join(dir, "acl.conf"), "utf-8");
      expect(acl.startsWith(bundled)).toBe(true);
      expect(acl.slice(bundled.length)).toBe(
        [
          "",
          "# >>> volley agent w1-t1-implementer-1 (managed by `volley auth`; do not edit)",
          "user w1-t1-implementer-1",
          "topic write volley/+/coordinator-ab12/mailbox",
          "topic write volley/+/volleyd/mailbox",
          "# <<< volley agent w1-t1-implementer-1",
          "",
        ].join("\n"),
      );

      // Re-minting replaces the block instead of stacking a second one.
      await run(
        ["add-agent", "w1-t1-implementer-1", "--ack-to", "coordinator-cd34", "--dir", dir],
        deps,
      );
      const again = readFileSync(join(dir, "acl.conf"), "utf-8");
      expect(again.match(/user w1-t1-implementer-1/g)).toHaveLength(1);
      expect(again).toContain("topic write volley/+/coordinator-cd34/mailbox");
      expect(again).not.toContain("volley/+/coordinator-ab12/mailbox");

      // rm-agent drops the block along with the password.
      await run(["rm-agent", "w1-t1-implementer-1", "--dir", dir], deps);
      expect(readFileSync(join(dir, "acl.conf"), "utf-8")).toBe(bundled);
    });

    it("add-agent without --ack-to writes no ACL block", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      const bundled = readFileSync(join(dir, "acl.conf"), "utf-8");
      await run(["add-agent", "w1-t1-implementer-1", "--dir", dir], deps);
      expect(readFileSync(join(dir, "acl.conf"), "utf-8")).toBe(bundled);
    });

    it("add-agent rejects an out-of-grammar --ack-to id without minting anything", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      const r = await run(["add-agent", "w1", "--ack-to", "Bad Id", "--dir", dir], deps);
      expect(r.code).toBe(2);
      expect(readFileSync(join(dir, "passwd"), "utf-8")).not.toContain("w1:");
    });

    it("rm-agent of an agent that was never minted (or already revoked) succeeds", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      deps.calls.length = 0;
      const r = await run(["rm-agent", "w1-t1-implementer-1", "--dir", dir], deps);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("not in");
      expect(deps.calls).toEqual([]);
    });

    it("add-agent before init fails with a pointer to init", async () => {
      const r = await run(["add-agent", "w1-t1-implementer-1", "--dir", dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("volley auth init");
    });

    it("surfaces a mosquitto_passwd failure", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      deps.passwd = async () => ({ code: 1, stderr: "Error: boom" });
      const r = await run(["add-agent", "w1-t1-implementer-1", "--dir", dir], deps);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Error: boom");
      expect(r.stdout).toBe(""); // no password printed for an identity that does not exist
    });
  });

  it("a failed reload is a warning, not an error", async () => {
    const deps = fakeDeps();
    deps.reload = async () => ({ ok: false, detail: "no mosquitto process found" });
    const r = await run(["init", "--dir", dir], deps);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("no mosquitto process found");
  });

  it("with no verb prints usage and exits 2", async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("volley auth init");
  });
});
