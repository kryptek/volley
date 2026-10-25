import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planFirstWave, readFirstWave } from "../../src/setup/first-wave";
import { planSignin, simulatedExec } from "../../src/setup/signin";
import type { SetupExec } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, HELLO_PR, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

/**
 * `--simulated` with the real processes: the step's own gh and git argv run under volley-sim's
 * `gh` (first on PATH, `VOLLEY_SIMULATED=1`), so the scratch repository's origin is a bare
 * repository under `$VOLLEY_SIM_HOME`, and its wave file goes through the real `volleyd
 * validate`. Only `volleyd run` and the wave's state are the fake machine's (the daemon's run of
 * this wave file is packages/volleyd/test/first-wave-simulated.test.ts).
 */

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

describe("setup: the test wave, --simulated against volley-sim's gh", () => {
  let fake: FakeDynsec;
  let m: FakeMachine;
  let dir: string;
  beforeEach(async () => {
    fake = await startFakeDynsec();
    dir = tempDir("volley-first-wave-sim-");
    m = fakeMachine(fake, dir);
    m.ctx.coordinator = "studio";
  });
  afterEach(async () => {
    await fake.close();
  });

  it(
    "the scratch repository, its README, the issue and the release branch on a bare origin; volleyd validate passes",
    { timeout: 60_000 },
    async () => {
      const simHome = join(dir, "sim");
      const fakeVolleyd = join(dir, "repo", "packages", "volleyd", "src", "cli.ts");
      const real: SetupExec = async (argv, o) => {
        if (argv[1] === fakeVolleyd && argv[2] === "run") return m.deps.exec(argv, o);
        const a =
          argv[1] === fakeVolleyd
            ? [
                argv[0] as string,
                join(REPO, "packages", "volleyd", "src", "cli.ts"),
                ...argv.slice(2),
              ]
            : [...argv];
        const r = spawnSync(a[0] as string, a.slice(1), {
          cwd: o?.cwd,
          env: o?.env as NodeJS.ProcessEnv,
          encoding: "utf-8",
        });
        return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      };
      const ctx = {
        ...m.ctx,
        auth: {
          ...m.ctx.auth,
          env: {
            // A fresh user: no git identity anywhere (not even the system's config).
            HOME: m.ctx.home,
            PATH: process.env.PATH,
            VOLLEY_SIM_HOME: simHome,
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
        firstWave: { simulated: true },
        deps: { ...m.deps, exec: real },
      };
      // The test wave refuses a machine git cannot commit on; the Sign-ins step gives it one.
      expect((await planFirstWave(ctx)).blocked).toContain("volley setup --step signin");
      const signin = await planSignin({
        ...ctx,
        auth: { ...ctx.auth, env: { ...ctx.auth.env, VOLLEY_SIMULATED: "1" } },
        deps: { ...ctx.deps, exec: simulatedExec(real) },
      });
      const identity = signin.changes.find((c) => c.summary.startsWith("Give git"));
      expect(identity?.summary).toContain("1+volley-sim@users.noreply.github.com");
      await identity?.apply();
      const plan = await planFirstWave(ctx);
      const lines: string[] = [];
      for (const c of plan.changes) lines.push(...(await c.apply()));

      const slug = "volley-sim/volley-hello-aaaa";
      const origin = join(simHome, "origins", `${slug}.git`);
      expect(existsSync(origin)).toBe(true);
      const branches = spawnSync("git", ["-C", origin, "branch", "--format=%(refname:short)"], {
        encoding: "utf-8",
      }).stdout;
      expect(branches.split("\n")).toEqual(
        expect.arrayContaining(["main", "release/2026-10-18-hello-aaaa"]),
      );
      const clone = join(m.ctx.volleydHome, "first-wave", "volley-hello-aaaa");
      expect(readFileSync(join(clone, ".volley", "waves", "hello-aaaa.yaml"), "utf-8")).toContain(
        "T1: { issue: 1 }",
      );
      expect(lines).toContain(`Filed ${slug}#1 "Add HELLO.md"`);
      expect(lines).toContain(`Merged ${HELLO_PR} in 0 m 2 s`);
      expect(readFirstWave(m.ctx.volleydHome)).toMatchObject({ merged: true, scratch: slug });
      const author = spawnSync("git", ["-C", clone, "log", "-1", "--format=%an <%ae>"], {
        encoding: "utf-8",
        env: ctx.auth.env as NodeJS.ProcessEnv,
      }).stdout;
      expect(author.trim()).toBe("Volley Sim <1+volley-sim@users.noreply.github.com>");
    },
  );
});
