import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deskPortListeners, parseLsof, parseSs } from "../../src/setup/desk-port";
import { planServices } from "../../src/setup/services";
import type { ExecResult, SetupExec } from "../../src/setup/step";
import { setupFence } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, fakeMachine } from "../helpers/setup-machine";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

/** `lsof -F pcn` output for listeners: [pid, command, address]. */
const lsof = (...rows: [number, string, string][]) =>
  rows.map(([p, c, n]) => `p${p}\nc${c}\nf3\nn${n}\n`).join("");

describe("setup: the Desk's port", () => {
  it("parses lsof's field output: every listener with its PID, command and address", () => {
    expect(parseLsof(lsof([4242, "node", "127.0.0.1:5199"], [77, "bun", "*:5199"]))).toEqual([
      { pid: 4242, command: "node", address: "127.0.0.1:5199" },
      { pid: 77, command: "bun", address: "*:5199" },
    ]);
    // One process listening on two addresses is listed once per address.
    expect(parseLsof("p9\ncpython3\nf4\nn127.0.0.1:5199\nf5\nn[::1]:5199\n")).toEqual([
      { pid: 9, command: "python3", address: "127.0.0.1:5199" },
      { pid: 9, command: "python3", address: "[::1]:5199" },
    ]);
    expect(parseLsof("")).toEqual([]);
  });

  it("parses ss's output (Linux without lsof)", () => {
    expect(
      parseSs(
        'LISTEN 0      511        127.0.0.1:5199      0.0.0.0:*    users:(("node",pid=4242,fd=21))\n' +
          'LISTEN 0      511          0.0.0.0:5199      0.0.0.0:*    users:(("bun",pid=77,fd=3))\n',
      ),
    ).toEqual([
      { pid: 4242, command: "node", address: "127.0.0.1:5199" },
      { pid: 77, command: "bun", address: "0.0.0.0:5199" },
    ]);
  });

  it("asks lsof, then ss where there is no lsof, and says it cannot tell when neither runs", async () => {
    const calls: string[][] = [];
    const exec = (answers: Record<string, ExecResult>): SetupExec => {
      return async (argv) => {
        calls.push([...argv]);
        return answers[argv[0] as string] ?? { code: 127, stdout: "", stderr: "not found" };
      };
    };
    expect(await deskPortListeners(exec({ lsof: ok(lsof([1, "node", "*:5199"])) }), 5199)).toEqual([
      { pid: 1, command: "node", address: "*:5199" },
    ]);
    expect(calls[0]).toEqual(["lsof", "-nP", "-iTCP:5199", "-sTCP:LISTEN", "-Fpcn"]);
    // lsof exits 1 when nothing listens.
    expect(
      await deskPortListeners(exec({ lsof: { code: 1, stdout: "", stderr: "" } }), 5199),
    ).toEqual([]);
    calls.length = 0;
    expect(
      await deskPortListeners(
        exec({ ss: ok('LISTEN 0 5 127.0.0.1:5199 0.0.0.0:* users:(("x",pid=5,fd=3))\n') }),
        5199,
      ),
    ).toEqual([{ pid: 5, command: "x", address: "127.0.0.1:5199" }]);
    expect(calls[1]).toEqual(["ss", "-H", "-l", "-t", "-n", "-p", "sport", "=", ":5199"]);
    expect(await deskPortListeners(exec({}), 5199)).toBeNull();
    // A fenced exec that refuses (volleyd planning for the Desk) is "cannot tell", not a crash.
    expect(
      await deskPortListeners(async () => {
        throw new Error("not a setup command volleyd runs for the Desk");
      }, 5199),
    ).toBeNull();
  });

  it("the fence lets setup run exactly these probes", () => {
    const fence = setupFence({
      restart: "brew services restart mosquitto",
      repoRoot: "/r",
      bun: "bun",
    });
    expect(() => fence(["lsof", "-nP", "-iTCP:5199", "-sTCP:LISTEN", "-Fpcn"])).not.toThrow();
    expect(() => fence(["ss", "-H", "-l", "-t", "-n", "-p", "sport", "=", ":5199"])).not.toThrow();
    expect(() =>
      fence(["systemctl", "--user", "show", "-p", "MainPID", "--value", "volley-desk.service"]),
    ).not.toThrow();
    expect(() => fence(["lsof", "-p", "1"])).toThrow();
    expect(() => fence(["lsof", "-nP", "-iTCP:5199;rm", "-sTCP:LISTEN", "-Fpcn"])).toThrow();
    expect(() => fence(["ss", "-K"])).toThrow();
  });

  describe("planServices", () => {
    let dir: string;
    let fake: FakeDynsec;
    let m: FakeMachine;
    let listeners: string;
    let deskPid: number | null;
    const applyAll = async () => {
      for (const c of (await planServices(m.ctx)).changes) await c.apply();
    };
    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "volley-setup-port-"));
      fake = await startFakeDynsec();
      listeners = "";
      deskPid = null;
    });
    afterEach(async () => {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const withPort = (platform: NodeJS.Platform) => {
      m = fakeMachine(fake, dir, { platform });
      const inner = m.ctx.deps.exec;
      m.ctx.deps.exec = async (argv, o) => {
        if (argv[0] === "lsof") {
          m.execCalls.push([...argv]);
          return listeners === "" ? { code: 1, stdout: "", stderr: "" } : ok(listeners);
        }
        if (argv[0] === "systemctl" && argv[2] === "show") {
          m.execCalls.push([...argv]);
          return ok(`${deskPid ?? 0}\n`);
        }
        const r = await inner(argv, o);
        // launchctl print shows the running service's PID.
        if (argv[0] === "launchctl" && argv[1] === "print" && r.code === 0 && deskPid !== null) {
          return argv[2]?.endsWith("systems.volley.desk") ? ok(`\tpid = ${deskPid}\n`) : r;
        }
        return r;
      };
    };

    for (const platform of ["darwin", "linux"] as const) {
      it(`${platform}: stops with the PID and the command when another program has the port`, async () => {
        withPort(platform);
        listeners = lsof([4242, "node", "127.0.0.1:5199"]);
        const p = await planServices(m.ctx);
        expect(p.blocked).toContain("node (PID 4242) on 127.0.0.1:5199");
        expect(p.blocked).toContain("kill 4242");
        expect(p.blocked).toContain("--desk-port");
      });

      it(`${platform}: the Desk's own service on its port is no conflict`, async () => {
        withPort(platform);
        await applyAll();
        deskPid = 777;
        listeners = lsof([777, "bun", "*:5199"]);
        const p = await planServices(m.ctx);
        expect(p.blocked).toBeUndefined();
        expect(p.changes).toEqual([]);
        // A second listener beside it (a leftover dev server on 127.0.0.1) is.
        listeners = lsof([777, "bun", "*:5199"], [31337, "vite", "127.0.0.1:5199"]);
        const again = await planServices(m.ctx);
        expect(again.blocked).toContain("vite (PID 31337) on 127.0.0.1:5199");
        expect(again.blocked).not.toContain("PID 777");
        // A step that just applied its changes fails its check when the port is taken.
        expect((await p.verify?.())?.[0]).toContain("vite (PID 31337)");
      });
    }
  });
});
