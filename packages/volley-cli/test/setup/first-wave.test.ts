import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIM_BIN } from "volley-sim/env";
import { DEFAULT_MODEL } from "volleyd/config-defaults";
import { parseWaveFile } from "volleyd/wave-file";
import { setup } from "../../src/commands/setup";
import { makeBufferIO } from "../../src/io";
import {
  FIRST_WAVE_DEFAULTS,
  FIRST_WAVE_QUESTION,
  firstWaveEnv,
  planFirstWave,
  readFirstWave,
  waveOutcome,
} from "../../src/setup/first-wave";
import { helloRelease, helloSuffix, isFirstWaveCommand } from "../../src/setup/first-wave-repo";
import { completeLine } from "../../src/setup/metrics";
import { type StepPlan, fencedExec, setupFence } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, HELLO_PR, MERGING, NOW, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

const SLUG = "octo-volley/volley-hello-aaaa";
const RELEASE = "release/2026-10-18-hello-aaaa";

describe("setup: the test wave (first-wave)", () => {
  let fake: FakeDynsec;
  let m: FakeMachine;
  let dir: string;
  beforeEach(async () => {
    fake = await startFakeDynsec();
    dir = tempDir("volley-first-wave-");
    m = fakeMachine(fake, dir);
    m.ctx.coordinator = "studio";
  });
  afterEach(async () => {
    await fake.close();
  });

  const volleyCli = () => join(dir, "repo", "packages", "volley-cli", "src", "cli.ts");
  const volleydCli = () => join(dir, "repo", "packages", "volleyd", "src", "cli.ts");
  const ran = (prefix: string) => m.execCalls.filter((a) => a.join(" ").startsWith(prefix));
  const applyAll = async (plan: StepPlan) => {
    const lines: string[] = [];
    for (const c of plan.changes) lines.push(...(await c.apply()));
    return lines;
  };

  describe("the question", () => {
    it("is asked once (Enter: yes), and a yes needs no second confirmation", async () => {
      const asked: { q: string; d: boolean | undefined }[] = [];
      m.ctx.deps = {
        ...m.deps,
        confirm: async (q, d) => {
          asked.push({ q, d });
          return true;
        },
      };
      const plan = await planFirstWave(m.ctx);
      expect(asked).toEqual([{ q: FIRST_WAVE_QUESTION, d: true }]);
      expect(FIRST_WAVE_QUESTION).toBe("Run a 1-issue test wave now?");
      expect(plan.confirmed).toBe(true);
      expect(plan.changes).toHaveLength(1);
      expect(m.execCalls).toEqual([]);
    });

    it("declined, the step is skipped with the command to run later: not an error", async () => {
      m.answers = [false];
      const plan = await planFirstWave(m.ctx);
      expect(m.questions).toEqual([FIRST_WAVE_QUESTION]);
      expect(plan.blocked).toBeUndefined();
      expect(plan.skipped).toContain("volley setup --step first-wave");
      expect(plan.changes).toEqual([]);
    });

    it("is never asked under --yes, --simulated, --no-first-wave or --check", async () => {
      for (const ctx of [
        { ...m.ctx, yes: true },
        { ...m.ctx, firstWave: { simulated: true } },
        { ...m.ctx, firstWave: { skip: true } },
        { ...m.ctx, check: true },
      ]) {
        await planFirstWave(ctx);
      }
      expect(m.questions).toEqual([]);
      const skip = await planFirstWave({ ...m.ctx, firstWave: { skip: true } });
      expect(skip.skipped).toContain("--no-first-wave");
      const check = await planFirstWave({ ...m.ctx, check: true });
      expect(check.skipped).toContain("--check");
      expect(m.execCalls).toEqual([]);
    });

    it("the whole command asks it once and nothing else for the step", async () => {
      m.answers = [true];
      const io = makeBufferIO({ now: () => new Date(NOW) });
      writeSetupRecord(m);
      const code = await setup(
        {
          argv: ["--step", "first-wave"],
          env: {
            HOME: m.ctx.home,
            VOLLEYD_HOME: m.ctx.volleydHome,
            VOLLEY_AUTH_DIR: m.layout.authDir,
            VOLLEY_BROKER_URL: fake.url,
          },
          io,
        },
        m.deps,
      );
      expect(io.readStderr()).toBe("");
      expect(code).toBe(0);
      expect(m.questions).toEqual([FIRST_WAVE_QUESTION]);
      expect(io.readStdout()).toContain(`Merged ${HELLO_PR}`);
    });
  });

  describe("the repository", () => {
    it("without --repo: a scratch private repository, a README, the issue, the release branch, volley repo add --wait", async () => {
      const plan = await planFirstWave({ ...m.ctx, yes: true });
      expect(plan.changes[0]?.summary).toContain("volley-hello-aaaa");
      const lines = await applyAll(plan);
      const work = join(m.ctx.volleydHome, "first-wave");
      const clone = join(work, "volley-hello-aaaa");
      expect(m.execCalls[0]).toEqual([
        "gh",
        "repo",
        "create",
        "volley-hello-aaaa",
        "--private",
        "--clone",
      ]);
      expect(readFileSync(join(clone, "README.md"), "utf-8")).toContain("gh repo delete");
      const lineOf = (a: string[]) => a.join(" ");
      const calls = m.execCalls.map(lineOf);
      const order = [
        "gh repo create volley-hello-aaaa --private --clone",
        `git -C ${clone} add README.md`,
        `git -C ${clone} commit -q -m Add README.md`,
        `git -C ${clone} push -u origin HEAD`,
        `gh issue create --repo ${SLUG} --title Add HELLO.md`,
        `git -C ${clone} push origin HEAD:refs/heads/${RELEASE}`,
        `bun ${volleyCli()} repo add ${SLUG} --wait`,
        `bun ${volleyCli()} repo status ${SLUG} --json`,
        `bun ${volleydCli()} validate`,
        `bun ${volleydCli()} run`,
      ];
      const at = order.map((p) => calls.findIndex((c) => c.startsWith(p)));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      // The repository is cloned under fleet.repo_root by volleyd: the wave runs from that clone.
      const managed = join(m.firstWave.repoRoot, SLUG);
      expect(existsSync(join(managed, ".volley", "waves", "hello-aaaa.yaml"))).toBe(true);
      expect(lines).toContain(`Filed ${SLUG}#7 "Add HELLO.md"`);
      expect(lines.join("\n")).toContain(`gh repo delete ${SLUG} --yes`);
    });

    it("volley repo add gets the admin login in its environment, never on argv", async () => {
      mkdirSync(m.layout.authDir, { recursive: true });
      writeFileSync(
        join(m.layout.authDir, "admin.json"),
        JSON.stringify({ username: "admin", password: "s3cret-pw" }),
      );
      await applyAll(await planFirstWave({ ...m.ctx, yes: true }));
      const i = m.execCalls.findIndex((a) => a.includes("add") && a.includes("--wait"));
      expect(m.execEnvs[i]?.VOLLEY_AUTH_USERNAME).toBe("admin");
      expect(m.execEnvs[i]?.VOLLEY_AUTH_PASSWORD).toBe("s3cret-pw");
      expect(m.execCalls.flat()).not.toContain("s3cret-pw");
    });

    it("with --repo: the clone's origin slug, an issue only without --issue, no scratch repository", async () => {
      const clone = join(dir, "mine");
      mkdirSync(clone);
      await applyAll(await planFirstWave({ ...m.ctx, yes: true, firstWave: { repo: clone } }));
      expect(ran("gh repo create")).toEqual([]);
      expect(ran("gh issue create")).toEqual([
        expect.arrayContaining(["--repo", "octo-volley/mine"]),
      ]);
      expect(ran(`bun ${volleyCli()} repo`)).toEqual([]);
      const wave = readFileSync(join(clone, ".volley", "waves", "hello-aaaa.yaml"), "utf-8");
      expect(wave).toContain("T1: { issue: 7 }");

      m.execCalls.length = 0;
      m.firstWave.states = [...MERGING];
      const plan = await planFirstWave({
        ...m.ctx,
        yes: true,
        deps: { ...m.deps, random: () => 0.5 },
        firstWave: { repo: clone, issue: 42 },
      });
      expect(plan.changes[0]?.detail).toContain(`cut from ${clone}'s checked-out commit (HEAD)`);
      await applyAll(plan);
      expect(ran("gh issue create")).toEqual([]);
      expect(readFileSync(join(clone, ".volley", "waves", "hello-ssss.yaml"), "utf-8")).toContain(
        "T1: { issue: 42 }",
      );
      expect(
        ran(`git -C ${clone} push origin HEAD:refs/heads/release/2026-10-18-hello-ssss`),
      ).toHaveLength(1);
    });

    it("refuses a --repo clone with no origin, naming volleyd validate's rule", async () => {
      m.firstWave.origin = null;
      const plan = await planFirstWave({ ...m.ctx, yes: true, firstWave: { repo: dir } });
      expect(plan.blocked).toContain("has no origin remote");
      expect(plan.blocked).toContain("volleyd validate");
      expect(plan.blocked).toContain("BASE_STALE");
      expect(plan.changes).toEqual([]);
    });

    it("needs a coordinator to own the wave", async () => {
      const { coordinator: _, ...ctx } = m.ctx;
      const plan = await planFirstWave({ ...ctx, yes: true });
      expect(plan.blocked).toContain("volley setup --step claude-code");
    });

    it("names the scratch repository with four characters [a-z0-9]", () => {
      expect(helloSuffix(() => 0)).toBe("aaaa");
      expect(helloSuffix(() => 0.999)).toBe("9999");
      expect(helloSuffix()).toMatch(/^[a-z0-9]{4}$/);
      expect(helloRelease(new Date(NOW), "hello-aaaa")).toBe(RELEASE);
    });
  });

  describe("the wave", () => {
    it("hello-<suffix>.yaml: implement then merge_ready, merge: auto, the default model, one task", async () => {
      await applyAll(await planFirstWave({ ...m.ctx, yes: true }));
      const file = join(m.firstWave.repoRoot, SLUG, ".volley", "waves", "hello-aaaa.yaml");
      const text = readFileSync(file, "utf-8");
      const wave = parseWaveFile(text, file);
      expect(wave.wave).toBe("hello-aaaa");
      expect(wave.pipeline).toEqual(["implement", "merge_ready"]);
      expect(wave.merge).toBe("auto");
      expect(wave.model).toBe(DEFAULT_MODEL);
      expect(Object.keys(wave.tasks)).toEqual(["T1"]);
      expect(wave.tasks.T1?.issue).toBe(7);
      expect(wave.release_branch).toBe(RELEASE);
      expect(ran(`bun ${volleydCli()} validate ${file}`)).toEqual([
        ["bun", volleydCli(), "validate", file],
      ]);
      expect(ran(`bun ${volleydCli()} run`)).toEqual([
        ["bun", volleydCli(), "run", file, "--owner", "studio"],
      ]);
    });

    it("the fence allows exactly what the step runs", async () => {
      const fence = setupFence({
        restart: m.layout.restart,
        repoRoot: join(dir, "repo"),
        bun: "bun",
      });
      const ctx = {
        ...m.ctx,
        yes: true,
        deps: { ...m.deps, exec: fencedExec(m.deps.exec, fence) },
      };
      await applyAll(await planFirstWave(ctx));
      expect(m.execCalls.length).toBeGreaterThan(8);
      for (const bad of [
        ["gh", "repo", "create", "other", "--private", "--clone"],
        ["gh", "repo", "create", "volley-hello-aaaa", "--public", "--clone"],
        ["gh", "repo", "delete", SLUG, "--yes"],
        ["git", "-C", "relative", "push", "-u", "origin", "HEAD"],
        ["git", "-C", "/x", "push", "--force", "origin", "HEAD"],
        ["git", "-C", "/x", "push", "origin", "HEAD:refs/heads/main"],
        ["bun", volleyCli(), "repo", "add", "octo/other", "--wait"],
        ["bun", volleyCli(), "repo", "remove", SLUG, "--wait"],
        ["bun", volleydCli(), "run", "/x/wave.yaml", "--owner", "studio"],
        ["bun", volleydCli(), "stop", "/x/.volley/waves/hello-aaaa.yaml", "--owner", "studio"],
      ]) {
        expect(() => fence(bad), bad.join(" ")).toThrow(/does not run/);
        expect(isFirstWaveCommand(bad)).toBe(false);
      }
    });

    it("follows the state to done: the PR URL and the wall time", async () => {
      m.firstWave.states = [
        { status: "running", tasks: [{ id: "T1", stage: "implement" }], open_decisions: [] },
        { status: "running", tasks: [{ id: "T1", stage: "merge_ready" }], open_decisions: [] },
        ...m.firstWave.states.slice(1),
      ];
      const lines = await applyAll(await planFirstWave({ ...m.ctx, yes: true }));
      expect(lines).toContain(`Merged ${HELLO_PR} in 0 m 4 s`);
      const rec = readFirstWave(m.ctx.volleydHome);
      expect(rec).toMatchObject({ merged: true, pr: HELLO_PR, wall_ms: 4000, scratch: SLUG });
    });

    it("blocked: the journal tail and the open decisions, then an error", async () => {
      m.firstWave.states = [
        {
          status: "awaiting_decision",
          tasks: [{ id: "T1", stage: "blocked" }],
          open_decisions: ["d-1"],
        },
      ];
      const jdir = join(m.ctx.volleydHome, "waves", "hello-aaaa");
      mkdirSync(jdir, { recursive: true });
      writeFileSync(
        join(jdir, "journal.jsonl"),
        `${[1, 2, 3].map((seq) => JSON.stringify({ seq, type: seq === 3 ? "agent_blocked" : "x", task: "T1" })).join("\n")}\n`,
      );
      let metrics: unknown;
      const plan = await planFirstWave({
        ...m.ctx,
        yes: true,
        metrics: {
          signIn: () => {},
          firstWave: (x) => {
            metrics = x;
          },
        },
      });
      const err = await applyAll(plan).catch((e: Error) => e.message);
      expect(err).toContain("blocked: task T1 is blocked");
      expect(err).toContain("#3 agent_blocked T1");
      expect(err).toContain("open decisions: d-1");
      expect(metrics).toMatchObject({ merged: false, pr: null });
    });

    it("gives up after 15 minutes", async () => {
      m.firstWave.states = [
        { status: "running", tasks: [{ id: "T1", stage: "implement" }], open_decisions: [] },
      ];
      const t0 = m.clock;
      const err = await applyAll(await planFirstWave({ ...m.ctx, yes: true })).catch(
        (e: Error) => e.message,
      );
      expect(err).toContain("did not finish within 15 minutes");
      expect(m.clock - t0).toBeGreaterThanOrEqual(FIRST_WAVE_DEFAULTS.timeout_ms);
    });

    it("reads an ended wave: complete, stopped, a blocked task", () => {
      const t = (stage: string) => [{ id: "T1", stage }];
      expect(waveOutcome(null)).toBeNull();
      expect(
        waveOutcome({ status: "running", tasks: t("implement"), open_decisions: [] }),
      ).toBeNull();
      expect(waveOutcome({ status: "complete", tasks: t("done"), open_decisions: [] })?.end).toBe(
        "done",
      );
      expect(waveOutcome({ status: "stopped", tasks: t("queued"), open_decisions: [] })?.end).toBe(
        "failed",
      );
      expect(
        waveOutcome({ status: "running", tasks: t("cancelled"), open_decisions: [] })?.end,
      ).toBe("blocked");
    });

    it("a rerun after a merged test wave has nothing to do and asks nothing", async () => {
      await applyAll(await planFirstWave({ ...m.ctx, yes: true }));
      m.execCalls.length = 0;
      const plan = await planFirstWave(m.ctx);
      expect(plan.changes).toEqual([]);
      expect(plan.found.join("\n")).toContain(`${HELLO_PR} merged`);
      expect(m.questions).toEqual([]);
      expect(m.execCalls).toEqual([]);
    });

    it("a rerun after a blocked test wave runs a wave of its own: a fresh id and state, the earlier scratch repository still named", async () => {
      m.firstWave.states = [
        { status: "running", tasks: [{ id: "T1", stage: "blocked" }], open_decisions: ["d-1"] },
      ];
      const first = await applyAll(await planFirstWave({ ...m.ctx, yes: true })).catch(
        (e: Error) => e.message,
      );
      expect(first).toContain("blocked: task T1 is blocked");
      expect(first).toContain("volleyd status hello-aaaa");

      // The rerun: another suffix (0.5 → "ssss"), and the earlier wave's state still retained.
      m.firstWave.states = [...MERGING];
      m.ctx.deps = { ...m.deps, random: () => 0.5 };
      const plan = await planFirstWave({ ...m.ctx, yes: true });
      expect(plan.found.join("\n")).toContain(`gh repo delete ${SLUG} --yes`);
      const lines = await applyAll(plan);
      const runs = ran(`bun ${volleydCli()} run`).map((a) => basename(a[3] as string));
      expect(runs).toEqual(["hello-aaaa.yaml", "hello-ssss.yaml"]);
      expect(lines).toContain(`Merged ${HELLO_PR} in 0 m 2 s`);
      const out = lines.join("\n");
      expect(out).toContain("gh repo delete octo-volley/volley-hello-ssss --yes");
      expect(out).toContain(`gh repo delete ${SLUG} --yes`);
      expect(readFirstWave(m.ctx.volleydHome)).toMatchObject({
        merged: true,
        wave: "hello-ssss",
        scratch: "octo-volley/volley-hello-ssss",
        earlier: [SLUG],
      });
    });

    it("--repo after a merged scratch test wave runs its own wave (volleyd refuses a resubmitted id)", async () => {
      await applyAll(await planFirstWave({ ...m.ctx, yes: true }));
      m.firstWave.states = [...MERGING];
      m.ctx.deps = { ...m.deps, random: () => 0.5 };
      const clone = join(dir, "mine");
      mkdirSync(clone);
      const lines = await applyAll(
        await planFirstWave({ ...m.ctx, yes: true, firstWave: { repo: clone } }),
      );
      expect(lines).toContain(`Merged ${HELLO_PR} in 0 m 2 s`);
      expect(existsSync(join(clone, ".volley", "waves", "hello-ssss.yaml"))).toBe(true);
      expect(
        ran(`git -C ${clone} push origin HEAD:refs/heads/release/2026-10-18-hello-ssss`),
      ).toHaveLength(1);
    });

    it("the 15 minutes start at the submit, and a broker error is named when it gives up", async () => {
      m.ctx.deps = {
        ...m.deps,
        waveState: async () => {
          throw new Error("Connection refused: Not authorized");
        },
      };
      const before = m.clock;
      const plan = await planFirstWave({ ...m.ctx, yes: true });
      // repo add is slow: two minutes before the wave is submitted.
      const exec = m.ctx.deps.exec;
      m.ctx.deps.exec = async (argv, o) => {
        if (argv.includes("add") && argv.includes("--wait")) m.clock += 120_000;
        return exec(argv, o);
      };
      const err = await applyAll(plan).catch((e: Error) => e.message);
      expect(err).toContain("did not finish within 15 minutes");
      expect(err).toContain("Not authorized");
      expect(m.clock - before).toBeGreaterThanOrEqual(FIRST_WAVE_DEFAULTS.timeout_ms + 120_000);
    });
  });

  describe("--simulated", () => {
    it("runs with the fakes first on PATH and VOLLEY_SIMULATED=1, from the scratch clone (no repo add)", async () => {
      const ctx = {
        ...m.ctx,
        auth: {
          ...m.ctx.auth,
          env: { ...m.ctx.auth.env, PATH: "/usr/bin", VOLLEY_SIM_HOME: "/sim" },
        },
        firstWave: { simulated: true },
      };
      const env = firstWaveEnv(ctx);
      expect(env.PATH).toBe(`${SIM_BIN}:/usr/bin`);
      expect(env.VOLLEY_SIMULATED).toBe("1");
      expect(env.VOLLEY_SIM_HOME).toBe("/sim");
      // A fresh machine has no git identity: the scaffold commits as the simulated world does.
      expect(env.GIT_AUTHOR_NAME).toBe("Volley Sim");
      expect(env.GIT_COMMITTER_EMAIL).toBe("sim@volley.invalid");
      await applyAll(await planFirstWave(ctx));
      expect(m.questions).toEqual([]);
      expect(ran(`bun ${volleyCli()} repo`)).toEqual([]);
      expect(m.execEnvs.every((e) => e?.VOLLEY_SIMULATED === "1")).toBe(true);
      const clone = join(m.ctx.volleydHome, "first-wave", "volley-hello-aaaa");
      expect(existsSync(join(clone, ".volley", "waves", "hello-aaaa.yaml"))).toBe(true);
      // Without `volley repo add` (whose add volleyd takes as consent) setup trusts the clone it
      // made itself, or the wave would wait on a repo_untrusted decision on a fresh machine.
      const claudeJson = JSON.parse(readFileSync(join(m.ctx.home, ".claude.json"), "utf-8"));
      expect(claudeJson.projects[clone].hasTrustDialogAccepted).toBe(true);
    });
  });

  describe("metrics and the end", () => {
    it("first_wave in setup-metrics.json, on the Setup complete line, and how to delete the repository", async () => {
      const io = makeBufferIO({ now: () => new Date(NOW) });
      const code = await setup(
        {
          argv: ["--yes", "--lan"],
          env: {
            HOME: m.ctx.home,
            VOLLEYD_HOME: m.ctx.volleydHome,
            VOLLEY_AUTH_DIR: m.layout.authDir,
            VOLLEY_BROKER_URL: fake.url,
          },
          io,
        },
        m.deps,
      );
      expect(io.readStderr()).toBe("");
      expect(code).toBe(0);
      const j = JSON.parse(
        readFileSync(join(m.ctx.volleydHome, "setup-metrics.json"), "utf-8"),
      ) as { first_wave?: unknown; steps: { name: string }[] };
      expect(j.first_wave).toEqual({ wall_ms: 2000, pr: HELLO_PR, merged: true });
      expect(j.steps.at(-1)?.name).toBe("first-wave");
      const out = io.readStdout();
      expect(out).toMatch(/Setup complete in .*; test wave merged in 0 m 2 s: https:/);
      expect(out).toContain(`gh repo delete ${SLUG} --yes`);
    });

    it("completeLine reports a test wave that did not merge", () => {
      const base = {
        started_at: "",
        finished_at: "",
        wall_ms: 60_000,
        questions: 1,
        sign_ins: 0,
        sudo_prompts: 0,
        steps: [],
      };
      expect(completeLine(base)).toBe("Setup complete in 1 m 0 s (1 question, 0 sign-ins, 0 sudo)");
      expect(
        completeLine({ ...base, first_wave: { wall_ms: 900_000, pr: null, merged: false } }),
      ).toBe(
        "Setup complete in 1 m 0 s (1 question, 0 sign-ins, 0 sudo); test wave not merged in 15 m 0 s",
      );
    });
  });

  describe("flags", () => {
    const run = async (argv: string[]) => {
      const io = makeBufferIO({ now: () => new Date(NOW) });
      const code = await setup({ argv, env: { HOME: m.ctx.home }, io }, m.deps);
      return { code, stderr: io.readStderr() };
    };
    it("refuses --issue without --repo, a bad --issue, --no-first-wave with a test wave's flag, and --peer with them", async () => {
      expect(await run(["--issue", "3"])).toMatchObject({ code: 2 });
      expect((await run(["--repo", "/x", "--issue", "x"])).stderr).toContain("issue number");
      expect((await run(["--no-first-wave", "--repo", "/x"])).stderr).toContain("--no-first-wave");
      expect((await run(["--no-first-wave", "--simulated"])).stderr).toContain("--simulated");
      expect((await run(["--peer", "--simulated"])).stderr).toContain("--peer");
    });
  });
});

/** setup.json naming the coordinator, as a finished earlier run leaves it. */
function writeSetupRecord(m: FakeMachine): void {
  mkdirSync(m.ctx.volleydHome, { recursive: true });
  writeFileSync(
    join(m.ctx.volleydHome, "setup.json"),
    JSON.stringify({
      layout: "brew-arm64",
      config: m.layout.config,
      state_file: m.layout.stateFile,
      auth_dir: m.layout.authDir,
      coordinator: "studio",
    }),
  );
}
