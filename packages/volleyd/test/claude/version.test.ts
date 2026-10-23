import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeService } from "../../src/claude/service";
import { fakeExec } from "../helpers/fake-exec";
import { tempDir } from "../helpers/tmp";

/** The Claude Code version a seeded profile records (`lastOnboardingVersion`, #400). */
describe("ClaudeService.claudeVersion", () => {
  const service = (exec: ReturnType<typeof fakeExec>["exec"]) => {
    const base = tempDir("volleyd-version-");
    return new ClaudeService({
      root: join(base, "claude"),
      primaryJson: join(base, ".claude.json"),
      exec,
      publish: async () => {},
      journal: async () => {},
      log: () => {},
    });
  };

  it("asks `claude --version` once while it answers", async () => {
    const fx = fakeExec().on(["claude", "--version"], { stdout: "2.0.14 (Claude Code)\n" });
    const s = service(fx.exec);
    expect(await s.claudeVersion()).toBe("2.0.14");
    expect(await s.claudeVersion()).toBe("2.0.14");
    expect(fx.argvs(["claude", "--version"])).toHaveLength(1);
  });

  it("a failed lookup is not cached: the next seed asks again", async () => {
    let fail = true;
    const fx = fakeExec().on(["claude", "--version"], () =>
      fail ? { code: 1 } : { stdout: "2.0.15 (Claude Code)\n" },
    );
    const s = service(fx.exec);
    expect(await s.claudeVersion()).toBeUndefined();
    fail = false;
    expect(await s.claudeVersion()).toBe("2.0.15");
  });
});
