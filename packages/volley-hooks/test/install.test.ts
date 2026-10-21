import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT, hookEnv } from "./helpers/hooks";
import { tempDir } from "./helpers/tmp";

const install = (settings: string, ...args: string[]) => installWith({}, settings, ...args);
const installWith = (extra: Record<string, string>, settings: string, ...args: string[]) =>
  execFileSync(join(PACKAGE_ROOT, "scripts", "install.sh"), args, {
    env: hookEnv({
      CLAUDE_SETTINGS: settings,
      VOLLEY_HOOKS_STATE_DIR: join(settings, "..", "st"),
      ...extra,
    }),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

type Settings = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
const read = (p: string) => JSON.parse(readFileSync(p, "utf-8")) as Settings;

describe("scripts/install.sh", () => {
  it("merges the hooks with the package path and coordinator mode, keeping other settings", () => {
    const dir = tempDir("volley-hooks-install-");
    const settings = join(dir, "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        model: "opus",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
      }),
    );
    install(settings);
    const merged = read(settings);
    expect((merged as unknown as { model: string }).model).toBe("opus");
    expect(Object.keys(merged.hooks).sort()).toEqual(
      [
        "Notification",
        "PostModelSwitch",
        "PostToolUse",
        "PreCompact",
        "PreToolUse",
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
      ].sort(),
    );
    expect(merged.hooks.Stop?.[0]?.hooks[0]?.command).toBe("say done");
    const stop = merged.hooks.Stop?.[1]?.hooks[0]?.command;
    expect(stop).toBe(`VOLLEY_HOOKS_COORDINATOR=1 bun run "${PACKAGE_ROOT}/src/hooks/stop.ts"`);
    expect(merged.hooks.PostToolUse?.map((g) => g.matcher)).toEqual(["", "AskUserQuestion"]);
    // PreToolUse: the Bash lease hook, the activity hook on every tool, then the picker hook.
    expect(merged.hooks.PreToolUse?.map((g) => g.matcher)).toEqual(["Bash", "", "AskUserQuestion"]);
    expect(merged.hooks.PreToolUse?.[1]?.hooks[0]?.command).toBe(
      `VOLLEY_HOOKS_COORDINATOR=1 bun run "${PACKAGE_ROOT}/src/hooks/pre-tool-use.ts"`,
    );
    expect(readdirSync(dir).some((f) => f.startsWith("settings.json.bak-"))).toBe(true);

    // Idempotent, and --uninstall restores the user's own hooks only.
    install(settings);
    expect(read(settings).hooks.Stop).toHaveLength(2);
    install(settings, "--uninstall");
    expect(read(settings).hooks).toEqual({
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    });
  });

  it("creates the settings file when missing", () => {
    const settings = join(tempDir("volley-hooks-install-"), "s.json");
    install(settings);
    expect(Object.keys(read(settings).hooks)).toHaveLength(8);
  });

  it("installs the usage statusLine and keeps the user's own as its chained command", () => {
    const dir = tempDir("volley-hooks-install-");
    const settings = join(dir, "settings.json");
    const own = { type: "command", command: "~/bin/my-status", padding: 1 };
    writeFileSync(settings, JSON.stringify({ statusLine: own }));
    install(settings);
    const chain = join(dir, "st", "statusline-chain.json");
    expect((read(settings) as unknown as { statusLine: unknown }).statusLine).toEqual({
      type: "command",
      command: `VOLLEY_HOOKS_COORDINATOR=1 bun run "${PACKAGE_ROOT}/src/statusline/publish.ts"`,
      padding: 0,
    });
    expect(JSON.parse(readFileSync(chain, "utf-8"))).toEqual(own);

    // A re-install keeps the saved command; --uninstall puts it back.
    install(settings);
    expect(JSON.parse(readFileSync(chain, "utf-8"))).toEqual(own);
    install(settings, "--uninstall");
    expect((read(settings) as unknown as { statusLine: unknown }).statusLine).toEqual(own);
    expect(existsSync(chain)).toBe(false);
  });

  it("--broker-url and --namespace are carried in every hook's and the statusLine's prefix", () => {
    const settings = join(tempDir("volley-hooks-install-"), "s.json");
    const url = "mqtt://127.0.0.1:21883";
    const flags = ["--broker-url", url, "--namespace", "team-a"];
    const dry = JSON.parse(install(settings, ...flags, "--dry-run")) as {
      hooks: Settings["hooks"];
      statusLine: { command: string };
    };
    expect(existsSync(settings)).toBe(false);
    const prefix = `VOLLEY_HOOKS_COORDINATOR=1 VOLLEY_BROKER_URL=${url} VOLLEY_NAMESPACE=team-a bun run "${PACKAGE_ROOT}/src/`;
    expect(dry.statusLine.command.startsWith(prefix)).toBe(true);
    const commands = Object.values(dry.hooks).flatMap((gs) =>
      gs.flatMap((g) => g.hooks.map((h) => h.command)),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(c.startsWith(prefix)).toBe(true);

    // Installed for another URL, a re-install replaces it (never two prefixes).
    install(settings, "--broker-url", "mqtt://127.0.0.1:21999");
    install(settings, ...flags);
    const again = read(settings);
    expect(again.hooks.Stop).toHaveLength(1);
    expect(again.hooks.Stop?.[0]?.hooks[0]?.command.startsWith(prefix)).toBe(true);
    // Without them, no prefix.
    install(settings);
    const bare = read(settings).hooks.Stop?.[0]?.hooks[0]?.command;
    expect(bare).not.toContain("VOLLEY_BROKER_URL");
    expect(bare).not.toContain("VOLLEY_NAMESPACE");
  });

  it("never reads VOLLEY_BROKER_URL from its environment (local volley setup passes its own env)", () => {
    const settings = join(tempDir("volley-hooks-install-"), "s.json");
    const plain = install(settings, "--dry-run");
    for (const url of ["tcp://localhost:1883", "mqtt://user:pw@127.0.0.1:1883", "mqtt://h:1883"]) {
      const env = { VOLLEY_BROKER_URL: url, VOLLEY_NAMESPACE: "team-a" };
      expect(installWith(env, settings, "--dry-run")).toBe(plain);
    }
    expect(plain).not.toContain("VOLLEY_BROKER_URL");
  });

  it("accepts tcp:// like the CLI does", () => {
    const settings = join(tempDir("volley-hooks-install-"), "s.json");
    const out = install(settings, "--broker-url", "tcp://localhost:1883", "--dry-run");
    expect(out).toContain("VOLLEY_BROKER_URL=tcp://localhost:1883 ");
  });

  it("refuses a --broker-url with a login (saying where the login goes) or one that is not a plain URL", () => {
    const settings = join(tempDir("volley-hooks-install-"), "s.json");
    const err = (args: string[]) => {
      try {
        install(settings, ...args);
      } catch (e) {
        return String((e as { stderr?: unknown }).stderr);
      }
      return null;
    };
    expect(err(["--broker-url", "mqtt://user:pw@127.0.0.1:1883"])).toMatch(
      /VOLLEY_AUTH_USERNAME.*coordinator\.json/s,
    );
    for (const url of ["mqtt://h:1883; rm -rf ~", "http://h"]) {
      expect(err(["--broker-url", url])).toMatch(/--broker-url/);
    }
    expect(err(["--namespace", "Not A Namespace"])).toMatch(/--namespace/);
    expect(err(["--broker-url"])).toMatch(/usage/);
    expect(existsSync(settings)).toBe(false);
  });

  it("removes its statusLine on uninstall when the user had none", () => {
    const settings = join(tempDir("volley-hooks-install-"), "s.json");
    install(settings);
    install(settings, "--uninstall");
    expect(read(settings) as unknown).toEqual({});
  });
});
