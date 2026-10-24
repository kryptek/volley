import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * No account surface tells the owner to run the doctor (#498): a card missing data asks volleyd
 * (`claude_prime`) and says `reading…`. Copy and comments alike, in the Desk, the CLI and the
 * Desk README's Claude accounts bullet.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf-8");

describe("the account surfaces never mention the doctor", () => {
  for (const file of [
    "../src/settings/ClaudeAccounts.tsx",
    "../src/settings/RemoveAccountSheet.tsx",
    "../src/store/claude.ts",
    "../../volley-cli/src/claude/groups.ts",
    "../../volley-cli/src/claude/balance.ts",
    "../../volley-cli/src/commands/claude.ts",
  ]) {
    it(file.replace(/^(\.\.\/)+/, ""), () => {
      expect(read(file)).not.toMatch(/doctor/i);
    });
  }

  it("the Desk README's Settings › Claude accounts bullet", () => {
    const bullet = read("../README.md")
      .split("\n")
      .find((l) => l.startsWith("- **Settings › Claude accounts"));
    expect(bullet).toBeDefined();
    expect(bullet).not.toMatch(/doctor/i);
  });
});
