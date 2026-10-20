import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT, hookEnv } from "./helpers/hooks";
import { tempDir } from "./helpers/tmp";

const install = (settings: string, ...args: string[]) =>
  execFileSync(join(PACKAGE_ROOT, "scripts", "install.sh"), args, {
    env: hookEnv({ CLAUDE_SETTINGS: settings, VOLLEY_HOOKS_STATE_DIR: join(settings, "..", "st") }),
    encoding: "utf-8",
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
    expect(merged.hooks.PostToolUse?.[0]?.matcher).toBe("");
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

  it("removes its statusLine on uninstall when the user had none", () => {
    const settings = join(tempDir("volley-hooks-install-"), "s.json");
    install(settings);
    install(settings, "--uninstall");
    expect(read(settings) as unknown).toEqual({});
  });
});
