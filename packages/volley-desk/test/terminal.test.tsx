import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScreenPayload } from "../src/store/types";
import { Terminal, lineClass } from "../src/windows/agent/Terminal";

const shot = (lines: string[]): ScreenPayload => ({
  lines,
  captured_at: "2026-10-18T12:00:00Z",
  workspace: "workspace:3",
  hash: "abc123",
  source: "cmux",
});

describe("Terminal", () => {
  it("classes command, ok and bad lines", () => {
    const { container } = render(
      <Terminal
        screen={shot([
          "⏺ Bash(npx vitest run src/chip-mapper.test.ts)",
          '  ⎿  ✓ maps closed_paid → "Paid" (3 ms)',
          '     ✗ maps legacy "CLSD" alias → "Closed"',
          "⏺ The legacy alias isn’t in the lookup. Adding it with a test.",
        ])}
        stale={false}
      />,
    );
    const lines = [...container.querySelectorAll(".tl")];
    expect(lines).toHaveLength(4);
    expect(lines[0]).toHaveClass("tl-cmd");
    expect(lines[1]).toHaveClass("tl-ok");
    expect(lines[2]).toHaveClass("tl-bad");
    expect(lines[3]).not.toHaveClass("tl-cmd", "tl-ok", "tl-bad");
    expect(container.querySelector(".term-caret")).not.toBeNull();
    expect(screen.queryByText("stale")).toBeNull();
  });

  it.each([
    ["⏺ gh pr checks 18", "tl-cmd"],
    ["⏺ git rebase origin/release/x", "tl-cmd"],
    ["⏺ Update(src/chip-mapper.ts)", "tl-cmd"],
    ["  ⎿  CONFLICT (content): Merge conflict in test/query-plan.test.ts", "tl-bad"],
    ["  ⎿  Tests run: 412, Failures: 0  (2m12s)", ""],
    ["  ⎿  Error: Cannot find module 'x'", "tl-bad"],
    ["     ✓ integration    6m10s", "tl-ok"],
    ["⏺ Published merge-ready evidence. Done.", ""],
  ])("%s → %s", (line, cls) => {
    expect(lineClass(line)).toBe(cls);
  });

  it("shows the stale marker when the screen is stale", () => {
    const { container } = render(<Terminal screen={shot(["⏺ Read(ISSUE.md)"])} stale />);
    expect(screen.getByText("stale")).toBeInTheDocument();
    expect(container.querySelector(".term")).toHaveClass("term--stale");
  });

  it("shows a placeholder when there is no screen yet", () => {
    const { container } = render(<Terminal screen={null} stale={false} />);
    expect(screen.getByText("no screen yet")).toBeInTheDocument();
    expect(container.querySelector(".tl")).toBeNull();
  });
});
