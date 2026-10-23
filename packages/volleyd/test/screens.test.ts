import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyScreen, modelFromScreen, screenWords, shellsRunning } from "../src/screens";
import { FIXTURES } from "./helpers/fake-host";

const screen = (name: string) => readFileSync(join(FIXTURES, "screens", name), "utf-8");

describe("classifyScreen", () => {
  it.each([
    ["update-prompt.txt", "update_prompt"],
    ["login.txt", "login"],
    ["blank.txt", "empty"],
    ["trust-dialog.txt", "trust_dialog"],
    ["working.txt", "working"],
    ["shell-prompt.txt", "shell_prompt"],
    ["credit-exhausted.txt", "credit_exhausted"],
    ["first-run-theme.txt", "first_run_theme"],
    ["first-run-security.txt", "first_run_security"],
    ["bypass-consent.txt", "bypass_consent"],
  ])("%s → %s", (file, cls) => {
    expect(classifyScreen(screen(file))).toBe(cls);
  });

  it("a bare shell prompt is the last line ending in a prompt sign; a typed command is not", () => {
    expect(classifyScreen("Last login: today\n~/wt $ \n\n")).toBe("shell_prompt");
    expect(classifyScreen("~/wt ❯ ")).toBe("shell_prompt");
    expect(classifyScreen("~/wt %   bash .volley/launch.sh")).toBe("unknown");
    expect(classifyScreen("[oh-my-zsh] Would you like to update? [Y/n]")).toBe("update_prompt");
  });

  it("an unreadable screen is empty", () => {
    expect(classifyScreen(null)).toBe("empty");
  });
});

describe("screenWords", () => {
  it("names Claude Code's first-run screens in plain words", () => {
    expect(screenWords("first_run_theme")).toBe("theme picker");
    expect(screenWords("first_run_security")).toBe("security notice");
    expect(screenWords("bypass_consent")).toBe("bypass-permissions confirmation");
  });

  it("a running session's own text is not a first-run screen", () => {
    expect(classifyScreen(screen("working.txt"))).toBe("working");
    expect(
      classifyScreen("● I picked the dark mode theme for the docs\n⏵⏵ bypass permissions on"),
    ).toBe("working");
  });
});

describe("modelFromScreen", () => {
  it("reads the status line's model display name as a model id", () => {
    expect(modelFromScreen(screen("working.txt"))).toBe("claude-opus-5-5");
  });

  it("reads a literal model id", () => {
    expect(modelFromScreen("… model: claude-sonnet-5-5 …")).toBe("claude-sonnet-5-5");
  });

  it("is null when no model is visible", () => {
    expect(modelFromScreen(screen("shell-prompt.txt"))).toBeNull();
    expect(modelFromScreen(null)).toBeNull();
  });
});

describe("shellsRunning", () => {
  it("reads the status bar's count of background shells or tasks", () => {
    expect(shellsRunning(["  ⏵⏵ bypass permissions on · 1 shell still running"])).toBe(1);
    expect(shellsRunning(["3 background tasks running"])).toBe(3);
    expect(shellsRunning(["· 2 shells running   Opus 5.5"])).toBe(2);
  });

  it("is 0 for a readable footer without one, and null without a footer", () => {
    expect(shellsRunning(["  ⏵⏵ running tests (shift+tab to cycle)"])).toBe(0);
    expect(shellsRunning([])).toBeNull();
  });
});
