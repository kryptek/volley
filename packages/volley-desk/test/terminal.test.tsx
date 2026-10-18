import { fireEvent, render, screen } from "@testing-library/react";
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

/** jsdom has no layout: give `el` a fixed scroll geometry and a writable `scrollTop`. */
function layout(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  let top = el.scrollTop;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
  });
}

/** The user scrolls `el` to `to`. */
function scrollTo(el: HTMLElement, to: number) {
  el.scrollTop = to;
  fireEvent.scroll(el);
}

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
    expect(lines[3]).toHaveClass("tl-cmd");
    expect(container.querySelector(".caret")).toHaveTextContent("▍");
    expect(screen.queryByText("stale")).toBeNull();
  });

  it.each([
    ["⏺ gh pr checks 18", "tl-cmd"],
    ["⏺ git rebase origin/release/x", "tl-cmd"],
    ["⏺ Update(src/chip-mapper.ts)", "tl-cmd"],
    ["  ⎿  CONFLICT (content): Merge conflict in test/query-plan.test.ts", "tl-bad"],
    ["  ⎿  Tests run: 412, Failures: 0  (2m12s)", ""],
    ["     ✓ integration    6m10s", "tl-ok"],
    ["⏺ Published merge-ready evidence. Done.", "tl-cmd"],
    ["  ⎿  queued: position 2 of 2", ""],
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

  describe("auto-scroll", () => {
    const first = shot(["⏺ Read(ISSUE.md)"]);
    const next = { ...shot(["⏺ Read(ISSUE.md)", "⏺ Bash(bun run test)"]), hash: "def456" };

    function setup() {
      const r = render(<Terminal screen={first} stale={false} />);
      const el = r.container.querySelector(".term") as HTMLElement;
      layout(el, 1000, 200);
      return { ...r, el };
    }

    it("follows a new capture while the reader is at the bottom", () => {
      const { el, rerender } = setup();
      scrollTo(el, 800);
      rerender(<Terminal screen={next} stale={false} />);
      expect(el.scrollTop).toBe(800);
      layout(el, 1400, 200);
      rerender(<Terminal screen={{ ...next, hash: "ghi789" }} stale={false} />);
      expect(el.scrollTop).toBe(1200);
    });

    it("does not yank a reader who scrolled up, on a re-render or a new capture", () => {
      const { el, rerender } = setup();
      scrollTo(el, 300);
      // A re-render with the same capture (the window's 2 s clock tick).
      rerender(<Terminal screen={first} stale={false} />);
      expect(el.scrollTop).toBe(300);
      rerender(<Terminal screen={next} stale={false} />);
      expect(el.scrollTop).toBe(300);
    });

    it("resumes following once the reader scrolls back to the bottom", () => {
      const { el, rerender } = setup();
      scrollTo(el, 300);
      scrollTo(el, 800);
      layout(el, 1400, 200);
      rerender(<Terminal screen={next} stale={false} />);
      expect(el.scrollTop).toBe(1200);
    });
  });
});
