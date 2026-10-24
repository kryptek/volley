import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup } from "../../src/commands/setup";
import { makeBufferIO } from "../../src/io";
import { looksSecret } from "../../src/peer/doctor";
import { SetupMeter, completeLine, formatWall } from "../../src/setup/metrics";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, NOW, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

describe("setup metrics", () => {
  let fake: FakeDynsec;
  let m: FakeMachine;
  beforeEach(async () => {
    fake = await startFakeDynsec();
    m = fakeMachine(fake, tempDir("volley-metrics-"));
  });
  afterEach(async () => {
    await fake.close();
  });

  const run = async (argv: string[]) => {
    const io = makeBufferIO({ now: () => new Date(NOW) });
    const env = {
      HOME: m.ctx.home,
      VOLLEYD_HOME: m.ctx.volleydHome,
      VOLLEY_AUTH_DIR: m.layout.authDir,
      VOLLEY_BROKER_URL: fake.url,
    };
    const code = await setup({ argv, env, io }, m.deps);
    return { code, stdout: io.readStdout() };
  };
  const file = () => join(m.ctx.volleydHome, "setup-metrics.json");

  it("a --yes run writes setup-metrics.json: wall time, no questions, each step's time and changes", async () => {
    const r = await run(["--yes", "--lan"]);
    expect(r.code).toBe(0);
    const text = readFileSync(file(), "utf-8");
    const j = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual([
      "finished_at",
      "questions",
      "sign_ins",
      "started_at",
      "steps",
      "sudo_prompts",
      "wall_ms",
    ]);
    expect(j.started_at).toBe(new Date(NOW).toISOString());
    expect(j.questions).toBe(0);
    expect(j.sign_ins).toBe(0);
    expect(j.sudo_prompts).toBe(0);
    expect(typeof j.wall_ms).toBe("number");
    const steps = j.steps as { name: string; ms: number; changes: number }[];
    expect(steps.map((s) => s.name)).toEqual([
      "detect",
      "security",
      "accounts",
      "signin",
      "claude-code",
      "terminal",
      "services",
      "phone",
    ]);
    for (const s of steps) expect(Object.keys(s).sort()).toEqual(["changes", "ms", "name"]);
    expect(steps.find((s) => s.name === "security")?.changes).toBe(3);
    expect(steps.find((s) => s.name === "detect")?.changes).toBe(0);
    // Never a token, though the run printed passwords and an admin token.
    expect(r.stdout).toMatch(/vly_admin_/);
    expect(looksSecret(text)).toBe(false);
    expect(text).not.toMatch(/vly_|pw-\d/);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    // setup.json points at it; the last line reports it.
    const saved = JSON.parse(readFileSync(join(m.ctx.volleydHome, "setup.json"), "utf-8"));
    expect(saved.metrics).toBe(file());
    expect(r.stdout).toMatch(
      /\nSetup complete in \d+ m \d+ s \(0 questions, 0 sign-ins, 0 sudo\)\n/,
    );
  });

  it("counts the sign-ins the run made (not as questions)", async () => {
    m.claude.signedIn = false;
    m.gh.signedIn = false;
    const r = await run(["--yes", "--lan"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(readFileSync(file(), "utf-8"));
    expect(j.sign_ins).toBe(2);
    expect(j.questions).toBe(0);
    expect(r.stdout).toContain("(0 questions, 2 sign-ins, 0 sudo)");
  });

  it("a run that stops still writes what it measured", async () => {
    m.answers = [false, false];
    expect((await run([])).code).toBe(1);
    const j = JSON.parse(readFileSync(file(), "utf-8"));
    // The LAN question and the Security confirmation: both seen.
    expect(j.questions).toBe(2);
    expect(j.steps.map((s: { name: string }) => s.name)).toEqual(["detect", "security"]);
  });

  it("counts a question only when someone saw it, and a sudo prompt per sudo command", async () => {
    const asked: string[] = [];
    let clock = 0;
    const meter = new SetupMeter(
      () => new Date(NOW),
      () => clock,
    );
    const quiet = meter.wrap({ ...m.deps, interactive: false });
    await quiet.confirm("nobody sees this");
    const seen = meter.wrap({
      ...m.deps,
      confirm: async (q) => {
        asked.push(q);
        return true;
      },
    });
    await seen.confirm("Apply?");
    await seen.askSecret?.("hidden: ");
    await seen.ask?.("Name: ");
    await seen.exec(["sudo", "systemctl", "restart", "mosquitto"]);
    const end = meter.begin("security");
    clock = 125_000;
    end(3);
    end(9); // once only
    const out = meter.done();
    expect(out.questions).toBe(3);
    expect(out.sudo_prompts).toBe(1);
    expect(out.steps).toEqual([{ name: "security", ms: 125_000, changes: 3 }]);
    expect(out.wall_ms).toBe(125_000);
    expect(asked).toEqual(["Apply?"]);
    expect(formatWall(125_000)).toBe("2 m 5 s");
    expect(completeLine({ ...out, sign_ins: 1, questions: 1 })).toBe(
      "Setup complete in 2 m 5 s (1 question, 1 sign-in, 1 sudo)",
    );
  });
});
