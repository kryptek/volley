import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sign-in copy (SPEC §4.6.11): the code-page link works from any device, so the sign-in
 * sheet and Add Claude account's sign-in step never send the owner to a localhost page, a remote
 * desktop or a terminal, outside the two places that are about exactly that: the "Terminal
 * instead" disclosure and the "Open here instead" shortcut's label.
 */

const source = (file: string) =>
  readFileSync(path.resolve(__dirname, "../src/settings", file), "utf-8");
const FORBIDDEN = /localhost|on this machine|remote desktop|tmux attach/i;

describe("the sign-in copy", () => {
  it("PeerSigninSheet.tsx, outside Terminal instead and the Open here instead label", () => {
    const src = source("PeerSigninSheet.tsx");
    const start = src.indexOf("function TerminalInstead(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    const rest = (src.slice(0, start) + src.slice(end)).replace(
      "Open here instead (browser on the supervisor’s machine)",
      "",
    );
    expect(rest.match(FORBIDDEN)).toBeNull();
  });

  it("ClaudeAccounts.tsx's sign-in step", () => {
    const src = source("ClaudeAccounts.tsx");
    const start = src.indexOf('<Step title="Sign in"');
    expect(start).toBeGreaterThan(-1);
    const step = src.slice(start, src.indexOf("</Step>", start));
    expect(step.match(FORBIDDEN)).toBeNull();
  });
});
