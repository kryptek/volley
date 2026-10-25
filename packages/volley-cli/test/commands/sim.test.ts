import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SIM_BIN } from "volley-sim/env";
import { runCli } from "../helpers/run-cli";
import { tempDir } from "../helpers/tmp";

describe("volley sim", () => {
  it("`env` prints the line `eval` turns the simulator on with", async () => {
    const home = join(tempDir("volley-sim-cli-"), "sim");
    const r = await runCli({ argv: ["sim", "env"], env: { VOLLEY_SIM_HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      `export PATH='${SIM_BIN}':"$PATH" VOLLEY_SIM_HOME='${home}' VOLLEY_SIMULATED=1\n`,
    );
    // eval'd by a shell, the fakes come first on PATH and answer.
    const sh = spawnSync(
      "sh",
      [
        "-c",
        `eval "$1" && command -v gh && echo "$VOLLEY_SIM_HOME $VOLLEY_SIMULATED"`,
        "sh",
        r.stdout,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    expect(sh.stdout).toBe(`${join(SIM_BIN, "gh")}\n${home} 1\n`);
  });

  it("`env` defaults the world to ~/.volley/sim", async () => {
    const r = await runCli({ argv: ["sim", "env"], env: { HOME: "/path/to/home" } });
    expect(r.stdout).toContain("VOLLEY_SIM_HOME='/path/to/home/.volley/sim'");
  });

  it("`env` carries VOLLEY_SIM_ORIGINS and VOLLEY_SIM_WORKFLOWS on when set (the VM install tests)", async () => {
    const r = await runCli({
      argv: ["sim", "env"],
      env: {
        HOME: "/path/to/home",
        VOLLEY_SIM_ORIGINS: "volley@10.20.0.11:/path/to/home/.volley/sim/origins",
        VOLLEY_SIM_WORKFLOWS: "0",
      },
    });
    expect(r.stdout).toMatch(
      / VOLLEY_SIM_ORIGINS='volley@10\.20\.0\.11:\/path\/to\/home\/\.volley\/sim\/origins' VOLLEY_SIM_WORKFLOWS='0'\n$/,
    );
  });

  it("`reset` clears the world and nothing else in its home", async () => {
    const home = join(tempDir("volley-sim-cli-"), "sim");
    mkdirSync(join(home, "origins", "volley-sim", "x.git"), { recursive: true });
    writeFileSync(join(home, "world.json"), "{}");
    writeFileSync(join(home, "unknown.jsonl"), "{}\n");
    writeFileSync(join(home, "notes.txt"), "mine");
    const r = await runCli({ argv: ["sim", "reset"], env: { VOLLEY_SIM_HOME: home } });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(home);
    expect(existsSync(join(home, "world.json"))).toBe(false);
    expect(existsSync(join(home, "unknown.jsonl"))).toBe(false);
    expect(existsSync(join(home, "origins"))).toBe(false);
    expect(existsSync(join(home, "notes.txt"))).toBe(true);
  });

  it("no verb or an unknown one is a usage error; --help is not", async () => {
    expect((await runCli({ argv: ["sim"] })).exitCode).toBe(2);
    expect((await runCli({ argv: ["sim", "bogus"] })).exitCode).toBe(2);
    const help = await runCli({ argv: ["sim", "--help"] });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("volley sim env");
  });

  it("is listed in the usage", async () => {
    const r = await runCli({ argv: ["--help"] });
    expect(r.stdout).toMatch(/^ {2}sim {6}/m);
  });
});
