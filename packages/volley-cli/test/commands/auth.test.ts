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
function fakeDeps(): AuthDeps & { calls: string[][]; reloads: number } {
  let n = 0;
  const deps = {
    calls: [] as string[][],
    reloads: 0,
    async passwd(args: string[]) {
      deps.calls.push(args);
      const create = args[0] === "-c";
      const del = args[0] === "-D";
      const rest = create ? args.slice(2) : del ? args.slice(1) : args.slice(1);
      const [file, user, password] = rest as [string, string, string | undefined];
      const lines = create || !existsSync(file) ? [] : readFileSync(file, "utf-8").split("\n");
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
    const code = await auth({ argv, env: {}, io }, deps);
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

    it("--no-reload skips the broker reload and says so", async () => {
      const r = await run(["init", "--dir", dir, "--no-reload"]);
      expect(r.code).toBe(0);
      expect(r.deps.reloads).toBe(0);
      expect(r.stderr).toContain("reload");
    });

    it("takes the directory from VOLLEY_AUTH_DIR", async () => {
      const io = makeBufferIO();
      const code = await auth({ argv: ["init"], env: { VOLLEY_AUTH_DIR: dir }, io }, fakeDeps());
      expect(code).toBe(0);
      expect(existsSync(join(dir, "passwd"))).toBe(true);
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
