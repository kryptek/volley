import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuthDeps, auth } from "../../src/commands/auth";
import { aclBlock, tokenAclBlock } from "../../src/commands/auth-roles";
import { makeBufferIO } from "../../src/io";

/**
 * A fake `mosquitto_passwd` that keeps the file format (`user:hash` per line) so tests
 * can assert on file contents without the real binary or a real broker.
 */
function fakeDeps(): AuthDeps & {
  calls: string[][];
  reloads: number;
  chowns: [string, number, number][];
  stdin: string;
} {
  let n = 0;
  let h = 0;
  const deps = {
    calls: [] as string[][],
    stdin: "",
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
    // Deterministic "random" hex: 0…01, 0…02, … at the requested width.
    randomHex(bytes: number) {
      h++;
      return h.toString(16).padStart(bytes * 2, "0");
    },
    async readStdin() {
      return deps.stdin;
    },
    brokerOwner: (): { uid: number; gid: number } | null => null,
    invokingUser: (): ReturnType<AuthDeps["invokingUser"]> => null,
    chown(path: string, uid: number, gid: number) {
      deps.chowns.push([path, uid, gid]);
    },
  };
  return deps;
}

const NOW = Date.parse("2026-10-18T12:00:00.000Z");

describe("volley auth", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "volley-auth-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (argv: string[], deps = fakeDeps(), now = () => new Date(NOW)) => {
    const io = makeBufferIO({ now });
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

    describe("--volleyd-file under sudo", () => {
      const sudoRun = async (argv: string[], deps: ReturnType<typeof fakeDeps>, extra = {}) => {
        const io = makeBufferIO();
        // sudo resets HOME to root's: the file must still land in the invoking user's home.
        const env = { HOME: join(dir, "roothome"), SUDO_UID: "501", SUDO_GID: "20", ...extra };
        const code = await auth({ argv, env, io }, deps);
        return { code, stdout: io.readStdout(), stderr: io.readStderr() };
      };
      const sudoDeps = () => {
        const deps = fakeDeps();
        deps.invokingUser = () => ({ uid: 501, gid: 20, home: join(dir, "userhome") });
        return deps;
      };

      it("writes broker.json in the invoking user's home, owned by them, 0600", async () => {
        const deps = sudoDeps();
        const r = await sudoRun(["init", "--dir", join(dir, "etc"), "--volleyd-file"], deps);
        expect(r.code).toBe(0);
        const vh = join(dir, "userhome", ".volley", "volleyd");
        const path = join(vh, "broker.json");
        expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
          username: "volleyd",
          password: "pw-1",
        });
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(existsSync(join(dir, "roothome"))).toBe(false);
        // Every directory init created, and the file, go to the invoking user.
        expect(deps.chowns).toEqual([
          [join(dir, "userhome"), 501, 20],
          [join(dir, "userhome", ".volley"), 501, 20],
          [vh, 501, 20],
          [path, 501, 20],
        ]);
      });

      it("--force without --volleyd-file rotates the invoking user's broker.json", async () => {
        const deps = sudoDeps();
        await sudoRun(["init", "--dir", join(dir, "etc"), "--volleyd-file"], deps); // pw-1..3
        const r = await sudoRun(["init", "--dir", join(dir, "etc"), "--force"], deps); // pw-4..6
        expect(r.code).toBe(0);
        const path = join(dir, "userhome", ".volley", "volleyd", "broker.json");
        expect(JSON.parse(readFileSync(path, "utf-8")).password).toBe("pw-4");
        expect(deps.chowns.at(-1)).toEqual([path, 501, 20]);
      });

      it("an explicit VOLLEYD_HOME is honoured and still handed to the invoking user", async () => {
        const deps = sudoDeps();
        const vh = join(dir, "explicit");
        const r = await sudoRun(["init", "--dir", join(dir, "etc"), "--volleyd-file"], deps, {
          VOLLEYD_HOME: vh,
        });
        expect(r.code).toBe(0);
        expect(deps.chowns).toEqual([
          [vh, 501, 20],
          [join(vh, "broker.json"), 501, 20],
        ]);
      });

      it("as root with no sudo user, refuses --volleyd-file without VOLLEYD_HOME (nothing minted)", async () => {
        const deps = fakeDeps();
        deps.invokingUser = () => "root";
        const etc = join(dir, "etc");
        const r = await sudoRun(["init", "--dir", etc, "--volleyd-file"], deps);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("VOLLEYD_HOME");
        expect(deps.calls).toEqual([]);
        expect(existsSync(join(etc, "passwd"))).toBe(false);
      });
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

    it("grant adds ack senders to a minted agent's block without touching its password", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      await run(
        ["add-agent", "w1-t1-implementer-1", "--ack-to", "coordinator-ab12", "--dir", dir],
        deps,
      );
      const passwdBefore = readFileSync(join(dir, "passwd"), "utf-8");
      deps.reloads = 0;
      deps.calls.length = 0;
      const r = await run(
        ["grant", "w1-t1-implementer-1", "--ack-to", "coordinator-cd34", "--dir", dir],
        deps,
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(deps.calls).toEqual([]); // no mosquitto_passwd: the password is unchanged
      expect(readFileSync(join(dir, "passwd"), "utf-8")).toBe(passwdBefore);
      expect(r.deps.reloads).toBe(1);
      const acl = readFileSync(join(dir, "acl.conf"), "utf-8");
      expect(acl.match(/user w1-t1-implementer-1/g)).toHaveLength(1);
      expect(acl).toContain("topic write volley/+/coordinator-ab12/mailbox");
      expect(acl).toContain("topic write volley/+/coordinator-cd34/mailbox");

      // Idempotent: granting a sender twice lists it once.
      await run(
        ["grant", "w1-t1-implementer-1", "--ack-to", "coordinator-cd34", "--dir", dir],
        deps,
      );
      const again = readFileSync(join(dir, "acl.conf"), "utf-8");
      expect(again.match(/coordinator-cd34/g)).toHaveLength(1);
    });

    it("grant refuses an agent that was never minted, and needs --ack-to", async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps);
      const unknown = await run(["grant", "w9", "--ack-to", "desk", "--dir", dir], deps);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('"w9" is not in');
      await run(["add-agent", "w1", "--dir", dir], deps);
      const none = await run(["grant", "w1", "--dir", dir], deps);
      expect(none.code).toBe(2);
      expect(none.stderr).toContain("--ack-to");
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

  describe("accounts (roles)", () => {
    const accounts = () =>
      JSON.parse(readFileSync(join(dir, "accounts.json"), "utf-8")) as {
        accounts: Record<string, unknown>[];
      };
    const acl = () => readFileSync(join(dir, "acl.conf"), "utf-8");
    const passwdText = () => readFileSync(join(dir, "passwd"), "utf-8");
    const initDeps = async () => {
      const deps = fakeDeps();
      await run(["init", "--dir", dir], deps); // pw-1..pw-3
      deps.reloads = 0;
      return deps;
    };

    it("add --role watch writes an account entry + passwd line and the watch ACL block", async () => {
      const deps = await initDeps();
      const r = await run(["add", "ops-alice", "--role", "watch", "--dir", dir], deps);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("pw-4\n"); // the password, once
      expect(passwdText()).toContain("ops-alice:hashed(pw-4)");
      expect(accounts().accounts).toEqual([
        {
          name: "ops-alice",
          role: "watch",
          kind: "device",
          created: "2026-10-18T12:00:00.000Z",
        },
      ]);
      expect(acl()).toContain(aclBlock("ops-alice", "watch"));
      expect(aclBlock("ops-alice", "watch")).not.toContain("topic write");
      expect(deps.reloads).toBe(1);
    });

    it("each role gets its template", () => {
      expect(aclBlock("a1", "admin")).toContain("topic write volley/_system/auth/ops/a1");
      expect(aclBlock("a1", "admin")).toContain("topic write volley/+/+/mailbox");
      expect(aclBlock("a1", "admin")).toContain("topic write volley/+/+/status");
      expect(aclBlock("s1", "steer")).toContain("topic write volley/+/+/mailbox");
      expect(aclBlock("s1", "steer")).not.toContain("volley/+/+/status");
      expect(aclBlock("v1", "supervisor")).toContain("topic readwrite volley/#");
      // ...but never an admin's ops topic (the topic names the sender) or the daemon's answers.
      expect(aclBlock("v1", "supervisor")).toContain("topic deny volley/_system/auth/ops/#");
      expect(aclBlock("v1", "supervisor")).toContain("topic deny volley/_system/auth/replies/#");
      expect(aclBlock("m1", "peer")).toContain("topic write volley/_system/machines/m1\n");
      expect(aclBlock("m1", "peer")).toContain("topic write volley/_system/machines/m1/#");
      expect(aclBlock("m1", "peer")).not.toContain("mailbox");
      for (const role of ["steer", "watch", "peer"] as const) {
        expect(aclBlock("x", role)).not.toContain("_system/auth/ops");
      }
    });

    it("add --json prints the credentials and the role; --kind overrides the default", async () => {
      const deps = await initDeps();
      const r = await run(
        ["add", "laptop", "--role", "peer", "--kind", "machine", "--json", "--dir", dir],
        deps,
      );
      expect(JSON.parse(r.stdout)).toEqual({ username: "laptop", password: "pw-4", role: "peer" });
      expect(accounts().accounts[0]).toMatchObject({
        name: "laptop",
        role: "peer",
        kind: "machine",
      });
    });

    it("add refuses a missing/unknown role or kind, a taken name, and reserved names", async () => {
      const deps = await initDeps();
      await run(["add-agent", "w1-t1-implementer-1", "--dir", dir], deps);
      await run(["add", "bob", "--role", "steer", "--dir", dir], deps);
      const bad: string[][] = [
        ["add", "carol"],
        ["add", "carol", "--role", "agent"],
        ["add", "carol", "--role", "root"],
        ["add", "carol", "--role", "steer", "--kind", "robot"],
        ["add", "Bad Name", "--role", "steer"],
        ["add", "desk", "--role", "steer"],
        ["add", "registry", "--role", "steer"],
        ["add", "redeem-00000001", "--role", "steer"],
      ];
      for (const argv of bad) {
        const r = await run([...argv, "--dir", dir], deps);
        expect(r.code, argv.join(" ")).toBe(2);
        expect(r.stdout).toBe("");
      }
      for (const name of ["bob", "w1-t1-implementer-1"]) {
        const r = await run(["add", name, "--role", "watch", "--dir", dir], deps);
        expect(r.code, name).toBe(1);
        expect(r.stderr).toContain("already");
      }
      expect(accounts().accounts.map((a) => a.name)).toEqual(["bob"]);
    });

    it("rotate prints a new password once and keeps the role and ACL block", async () => {
      const deps = await initDeps();
      await run(["add", "bob", "--role", "steer", "--dir", dir], deps); // pw-4
      const r = await run(["rotate", "bob", "--dir", dir], deps);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("pw-5\n");
      expect(passwdText()).toContain("bob:hashed(pw-5)");
      expect(passwdText()).not.toContain("pw-4");
      expect(acl()).toContain(aclBlock("bob", "steer"));
      const unknown = await run(["rotate", "nobody", "--dir", dir], deps);
      expect(unknown.code).toBe(1);
      expect(unknown.stdout).toBe("");
    });

    it("revoke removes the passwd line, the account and its ACL block", async () => {
      const deps = await initDeps();
      await run(["add", "bob", "--role", "steer", "--dir", dir], deps);
      await run(["add", "eve", "--role", "watch", "--dir", dir], deps);
      deps.reloads = 0;
      const r = await run(["revoke", "bob", "--dir", dir], deps);
      expect(r.code).toBe(0);
      expect(passwdText()).not.toContain("bob:");
      expect(acl()).not.toContain("account bob");
      expect(acl()).toContain(aclBlock("eve", "watch"));
      expect(accounts().accounts.map((a) => a.name)).toEqual(["eve"]);
      expect(deps.reloads).toBe(1);
      const again = await run(["revoke", "bob", "--dir", dir], deps);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("no account");
    });

    it("list --json prints the registry without passwords; plain list is a table", async () => {
      const deps = await initDeps();
      await run(["add", "bob", "--role", "steer", "--dir", dir], deps);
      const r = await run(["list", "--json", "--dir", dir], deps);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        accounts: [
          { name: "bob", role: "steer", kind: "device", created: "2026-10-18T12:00:00.000Z" },
        ],
      });
      expect(r.stdout).not.toContain("pw-");
      const table = await run(["list", "--dir", dir], deps);
      expect(table.stdout).toMatch(/bob\s+steer\s+device/);
    });

    describe("one-time tokens", () => {
      const tokens = () =>
        JSON.parse(readFileSync(join(dir, "tokens.json"), "utf-8")) as {
          tokens: Record<string, unknown>[];
        };
      const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
      // randomHex: the id is the 1st draw (4 bytes), the secret the 2nd (16 bytes).
      const TOKEN = `vly_admin_00000001_${"2".padStart(32, "0")}`;

      it("token prints a one-time admin token and stores only its hash", async () => {
        const deps = await initDeps();
        const r = await run(["token", "--dir", dir], deps);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain(TOKEN);
        expect(r.stdout).toContain("10 minutes");
        const stored = JSON.stringify(tokens());
        expect(stored).not.toContain(TOKEN);
        expect(stored).not.toContain("2".padStart(32, "0"));
        expect(tokens().tokens).toEqual([
          {
            id: "00000001",
            kind: "admin",
            role: "admin",
            hash: sha256(TOKEN),
            created: "2026-10-18T12:00:00.000Z",
            expires_at: "2026-10-18T12:10:00.000Z",
          },
        ]);
        // The token is also a short-lived broker login that may only publish a redeem request.
        expect(passwdText()).toContain(`redeem-00000001:hashed(${TOKEN})`);
        expect(acl()).toContain(tokenAclBlock("00000001"));
        // Its own redeem and reply topics only: the deny shuts out the shared `pattern` grants
        // (read volley/#, its own %u channels, lease requests), which all live under volley/.
        expect(tokenAclBlock("00000001")).toContain(
          [
            "user redeem-00000001",
            "topic deny volley/#",
            "topic write volley-auth/redeem/00000001",
            "topic read volley-auth/redeem/00000001/reply",
            "",
          ].join("\n"),
        );
        // volleyd reads the requests and writes the answers there (the shipped ACL grants it).
        expect(acl()).toMatch(
          /^user volleyd\ntopic readwrite volley\/#\ntopic readwrite volley-auth\/#$/m,
        );
        expect(deps.reloads).toBe(1);
      });

      it("token grants volleyd the volley-auth/ topics in an ACL from before they existed", async () => {
        const deps = await initDeps();
        const file = join(dir, "acl.conf");
        writeFileSync(
          file,
          readFileSync(file, "utf-8").replace("topic readwrite volley-auth/#\n", ""),
        );
        expect(acl()).not.toContain("volley-auth/#");
        await run(["token", "--dir", dir], deps);
        await run(["token", "--dir", dir], deps);
        expect(acl()).toContain(
          "# >>> volley token topics (managed by `volley auth`; do not edit)\nuser volleyd\ntopic readwrite volley-auth/#\n# <<< volley token topics\n",
        );
        expect(acl().match(/volley-auth\/#/g)).toHaveLength(1);
      });

      it("token --json prints the token, its broker login and expiry", async () => {
        const deps = await initDeps();
        const r = await run(["token", "--json", "--ttl", "60", "--dir", dir], deps);
        expect(JSON.parse(r.stdout)).toEqual({
          token: TOKEN,
          username: "redeem-00000001",
          expires_at: "2026-10-18T12:01:00.000Z",
        });
      });

      it("redeem mints an admin account bound to the label and burns the token", async () => {
        const deps = await initDeps();
        await run(["token", "--dir", dir], deps);
        deps.stdin = `${TOKEN}\n`;
        const r = await run(["redeem", "--label", "Desk on mac", "--json", "--dir", dir], deps);
        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({
          username: "admin-00000001",
          password: "pw-4",
          role: "admin",
          label: "Desk on mac",
          token_id: "00000001",
        });
        expect(accounts().accounts).toEqual([
          {
            name: "admin-00000001",
            role: "admin",
            kind: "device",
            created: "2026-10-18T12:00:00.000Z",
            label: "Desk on mac",
          },
        ]);
        expect(acl()).toContain(aclBlock("admin-00000001", "admin"));
        // Burned: the entry records the redemption. The token's login stays: mosquitto drops a
        // connected client whose user leaves the password file on reload, and the client that
        // redeemed is still connected as it, waiting for its answer.
        expect(tokens().tokens[0]).toMatchObject({ used_at: "2026-10-18T12:00:00.000Z" });
        expect(passwdText()).toContain(`redeem-00000001:hashed(${TOKEN})`);
        expect(acl()).toContain(tokenAclBlock("00000001"));
        expect(deps.calls.some((c) => c[0] === "-D")).toBe(false);

        const again = await run(["redeem", "--label", "x", "--json", "--dir", dir], deps);
        expect(again.code).toBe(1);
        expect(again.stderr).toContain("already used");
        expect(again.stdout).toBe("");
      });

      it("a redeemed token's login is pruned once its short grace has passed", async () => {
        const deps = await initDeps();
        await run(["token", "--dir", dir], deps);
        deps.stdin = TOKEN;
        await run(["redeem", "--label", "Desk on mac", "--dir", dir], deps);
        await run(["list", "--dir", dir], deps, () => new Date(NOW + 30_000));
        expect(passwdText()).toContain("redeem-00000001");
        await run(["list", "--dir", dir], deps, () => new Date(NOW + 61_000));
        expect(passwdText()).not.toContain("redeem-00000001");
        expect(acl()).not.toContain("redeem-00000001");
        expect(accounts().accounts.map((a) => a.name)).toEqual(["admin-00000001"]);
      });

      it("redeem refuses, without burning the token, when the account name is taken", async () => {
        const deps = await initDeps();
        await run(["token", "--dir", dir], deps);
        // An account of that name from before the shape was reserved (or a hand-edited file).
        await deps.passwd(["-b", join(dir, "passwd"), "admin-00000001", "theirs"]);
        deps.stdin = TOKEN;
        const r = await run(["redeem", "--label", "x", "--json", "--dir", dir], deps);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("admin-00000001");
        expect(r.stdout).toBe("");
        expect(passwdText()).toContain("admin-00000001:hashed(theirs)");
        expect(tokens().tokens[0]?.used_at).toBeUndefined();
      });

      it("add refuses a name of the shape a redeemed token mints", async () => {
        const deps = await initDeps();
        for (const n of ["admin-1a2b3c4d", "steer-00000001", "watch-deadbeef"]) {
          const r = await run(["add", n, "--role", "watch", "--dir", dir], deps);
          expect(r.code, n).toBe(2);
        }
        expect(
          (await run(["add", "admin-laptop", "--role", "watch", "--dir", dir], deps)).code,
        ).toBe(0);
      });

      it("token draws a fresh id when the drawn one is already taken", async () => {
        const deps = await initDeps();
        await run(["token", "--dir", dir], deps); // id 00000001, secret …02
        let h = 0;
        deps.randomHex = (bytes) => {
          h++;
          return (h === 1 ? 1 : h + 10).toString(16).padStart(bytes * 2, "0");
        };
        const r = await run(["token", "--json", "--dir", dir], deps);
        expect(JSON.parse(r.stdout).username).not.toBe("redeem-00000001");
        expect(new Set(tokens().tokens.map((t) => t.id)).size).toBe(2);
      });

      it("rewrites tokens.json and accounts.json by rename, never in place", async () => {
        const deps = await initDeps();
        await run(["token", "--dir", dir], deps);
        await run(["add", "bob", "--role", "steer", "--dir", dir], deps);
        const before = [
          statSync(join(dir, "tokens.json")).ino,
          statSync(join(dir, "accounts.json")).ino,
        ];
        await run(["token", "--dir", dir], deps);
        await run(["add", "eve", "--role", "steer", "--dir", dir], deps);
        expect(statSync(join(dir, "tokens.json")).ino).not.toBe(before[0]);
        expect(statSync(join(dir, "accounts.json")).ino).not.toBe(before[1]);
        expect(statSync(join(dir, "accounts.json")).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      });

      it("refuses an expired, unknown or forged token; an expired login is pruned", async () => {
        const deps = await initDeps();
        await run(["token", "--dir", dir], deps);
        const later = () => new Date(NOW + 11 * 60_000);
        deps.stdin = TOKEN;
        const expired = await run(["redeem", "--label", "x", "--dir", dir], deps, later);
        expect(expired.code).toBe(1);
        expect(expired.stderr).toContain("expired");
        // redeem never drops a login (or reloads): the client must still get the refusal.
        expect(passwdText()).toContain("redeem-00000001");
        expect(deps.reloads).toBe(1);
        await run(["list", "--dir", dir], deps, later);
        expect(passwdText()).not.toContain("redeem-00000001");
        expect(acl()).not.toContain("redeem-00000001");

        await run(["token", "--dir", dir], deps); // id 00000003, secret …04
        for (const forged of [
          `vly_admin_00000003_${"5".padStart(32, "0")}`,
          `vly_admin_0000000f_${"4".padStart(32, "0")}`,
          "not-a-token",
        ]) {
          deps.stdin = forged;
          const r = await run(["redeem", "--label", "x", "--dir", dir], deps);
          expect(r.code, forged).toBe(1);
          expect(r.stderr).toContain("invalid token");
        }
        expect(existsSync(join(dir, "accounts.json"))).toBe(false);
      });

      it("any later auth command prunes an expired token's broker login", async () => {
        const deps = await initDeps();
        await run(["token", "--dir", dir], deps);
        await run(["list", "--dir", dir], deps, () => new Date(NOW + 11 * 60_000));
        expect(passwdText()).not.toContain("redeem-00000001");
        expect(acl()).not.toContain("redeem-00000001");
      });

      it("signin-link mints a sign-in token whose redemption yields that role", async () => {
        const deps = await initDeps();
        const r = await run(
          [
            "signin-link",
            "--role",
            "steer",
            "--label",
            "Phone",
            "--ttl",
            "300",
            "--json",
            "--dir",
            dir,
          ],
          deps,
        );
        expect(r.code).toBe(0);
        const signin = `vly_signin_00000001_${"2".padStart(32, "0")}`;
        expect(JSON.parse(r.stdout)).toEqual({
          token: signin,
          username: "redeem-00000001",
          expires_at: "2026-10-18T12:05:00.000Z",
        });
        expect(tokens().tokens[0]).toMatchObject({ kind: "signin", role: "steer", label: "Phone" });
        deps.stdin = signin;
        const red = await run(["redeem", "--label", "iPhone", "--json", "--dir", dir], deps);
        expect(JSON.parse(red.stdout)).toMatchObject({ username: "steer-00000001", role: "steer" });
        expect(acl()).toContain(aclBlock("steer-00000001", "steer"));
        deps.stdin = signin;
        expect((await run(["redeem", "--label", "x", "--dir", dir], deps)).code).toBe(1);
      });

      it("signin-link only issues steer or watch, and needs a label", async () => {
        const deps = await initDeps();
        for (const argv of [
          ["signin-link", "--role", "admin", "--label", "x"],
          ["signin-link", "--role", "supervisor", "--label", "x"],
          ["signin-link", "--role", "steer"],
          // A label the daemon, the fence and account.schema.json all refuse.
          ["signin-link", "--role", "steer", "--label=-x"],
        ]) {
          const r = await run([...argv, "--dir", dir], deps);
          expect(r.code, argv.join(" ")).toBe(2);
        }
      });
    });

    it("the integration fixture's role blocks are what `volley auth add` generates", () => {
      const fixture = readFileSync(
        new URL("../../../volley-mcp/test/integration/auth-fixture.sh", import.meta.url),
        "utf-8",
      );
      expect(fixture).toContain(aclBlock("admin-test", "admin"));
      expect(fixture).toContain(aclBlock("steer-test", "steer"));
      expect(fixture).toContain(aclBlock("watch-test", "watch"));
      expect(fixture).toContain(aclBlock("peer-test", "peer"));
      expect(fixture).toContain(aclBlock("supervisor-test", "supervisor"));
      expect(fixture).toContain(tokenAclBlock("0000abcd"));
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
