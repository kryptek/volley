import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyScreen, modelFromScreen } from "../src/screens";
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
