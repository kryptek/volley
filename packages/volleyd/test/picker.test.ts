import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ParsedPicker,
  choiceFor,
  keysFor,
  matches,
  parsePicker,
  parseReview,
  promptIdle,
} from "../src/autopilot/picker";

const SCREENS = new URL("./fixtures/screens/", import.meta.url).pathname;
const screen = (name: string) => readFileSync(`${SCREENS}${name}.txt`, "utf-8");
const parsed = (name: string) => parsePicker(screen(name)) as ParsedPicker;

const fruit = {
  question: "Which fruit do you want?",
  options: [{ label: "Apple" }, { label: "Banana" }, { label: "Cherry" }],
};
const toppings = {
  question: "Which toppings do you want?",
  options: [{ label: "Cheese" }, { label: "Olives" }, { label: "Peppers" }],
  multi: true,
};

describe("parsePicker (screens captured from a real Claude Code AskUserQuestion picker)", () => {
  it("single-select: question, options in order, the highlighted row, the Other row", () => {
    expect(parsePicker(screen("picker-single"))).toEqual({
      question: "Which fruit do you want?",
      multi: false,
      options: [
        { label: "Apple", highlighted: true },
        { label: "Banana", highlighted: false },
        { label: "Cherry", highlighted: false },
      ],
      other: { label: "Type something.", highlighted: false },
      submit: null,
      chat: { highlighted: false },
    });
  });

  it("the prompt echoed above the picker (also drawn with ❯) is not a picker row", () => {
    expect(parsed("picker-single").options.filter((o) => o.highlighted)).toHaveLength(1);
  });

  it("multi-select: checkboxes, and the Submit row", () => {
    const p = parsed("picker-multi");
    expect(p.multi).toBe(true);
    expect(p.options).toEqual([
      { label: "Cheese", highlighted: true, checked: false },
      { label: "Olives", highlighted: false, checked: false },
      { label: "Peppers", highlighted: false, checked: false },
    ]);
    expect(p.other).toEqual({ label: "Type something", highlighted: false, checked: false });
    expect(p.submit).toEqual({ highlighted: false });
  });

  it("the Other row highlighted, and once typed into (it shows the text)", () => {
    expect(parsed("picker-other").other).toEqual({ label: "Type something.", highlighted: true });
    expect(parsed("picker-other-typed").other).toEqual({ label: "teal please", highlighted: true });
    expect(parsed("picker-multi-other").other).toEqual({
      label: "anchovies",
      highlighted: true,
      checked: true,
    });
  });

  it("no picker: the idle prompt, the review screen, nothing", () => {
    expect(parsePicker(screen("picker-gone"))).toBeNull();
    expect(parsePicker(screen("picker-review"))).toBeNull();
    expect(parsePicker(screen("claude-session"))).toBeNull();
    expect(parsePicker(null)).toBeNull();
    expect(parsePicker("")).toBeNull();
  });

  it("a non-breaking space after the row marker reads as a space", () => {
    const nbsp = screen("picker-single").replace("❯ 1. Apple", "❯ 1. Apple");
    expect(parsePicker(nbsp)?.options[0]).toEqual({ label: "Apple", highlighted: true });
  });
});

describe("matches", () => {
  it("the same picker: the question's first line and every option label, in order", () => {
    expect(matches(parsePicker(screen("picker-single")), fruit)).toBe(true);
    expect(matches(parsePicker(screen("picker-multi")), toppings)).toBe(true);
    expect(
      matches(parsePicker(screen("picker-single")), {
        ...fruit,
        question: "Which fruit do you want?\nmore",
      }),
    ).toBe(true);
  });

  it("another picker, another order, single vs multi, or no picker at all", () => {
    expect(matches(parsePicker(screen("picker-gone")), fruit)).toBe(false);
    expect(matches(parsePicker(screen("picker-single")), toppings)).toBe(false);
    expect(
      matches(parsePicker(screen("picker-single")), {
        ...fruit,
        options: [{ label: "Banana" }, { label: "Apple" }, { label: "Cherry" }],
      }),
    ).toBe(false);
    expect(
      matches(parsePicker(screen("picker-single")), { ...fruit, question: "Which fruit?" }),
    ).toBe(false);
    expect(matches(parsePicker(screen("picker-single")), { ...fruit, multi: true })).toBe(false);
  });
});

describe("keysFor", () => {
  it("single-select: Down × k from the highlighted row, then Enter", () => {
    expect(keysFor(parsed("picker-single"), { labels: ["Banana"] })).toEqual(["Down", "Enter"]);
    expect(keysFor(parsed("picker-single"), { labels: ["Apple"] })).toEqual(["Enter"]);
    expect(keysFor(parsed("picker-single"), { labels: ["Cherry"] })).toEqual([
      "Down",
      "Down",
      "Enter",
    ]);
  });

  it("Up from a row below the choice (Down does not wrap)", () => {
    expect(keysFor(parsed("picker-other"), { labels: ["Red"] })).toEqual(["Up", "Up", "Enter"]);
  });

  it("Other: to the Other row, the text typed straight in, Enter", () => {
    expect(keysFor(parsed("picker-single"), { labels: [], other: "durian" })).toEqual([
      "Down",
      "Down",
      "Down",
      { text: "durian" },
      "Enter",
    ]);
  });

  it("multi-select: Space on each row to toggle, then the Submit row and Enter", () => {
    expect(keysFor(parsed("picker-multi"), { labels: ["Cheese", "Peppers"] })).toEqual([
      "Space",
      "Down",
      "Down",
      "Space",
      "Down",
      "Down",
      "Enter",
    ]);
  });

  it("multi-select: rows already checked are left alone, wrongly checked ones unchecked", () => {
    // Cheese checked, cursor on the Other row (typed: checked).
    const p = parsed("picker-multi-other");
    expect(
      keysFor(
        { ...p, other: { ...p.other, checked: false, label: "Type something" } },
        {
          labels: ["Olives"],
        },
      ),
    ).toEqual(["Up", "Up", "Up", "Space", "Down", "Space", "Down", "Down", "Down", "Enter"]);
  });

  it("multi-select with Other text: typing checks the Other row", () => {
    expect(keysFor(parsed("picker-multi"), { labels: ["Cheese"], other: "anchovies" })).toEqual([
      "Space",
      "Down",
      "Down",
      "Down",
      { text: "anchovies" },
      "Down",
      "Enter",
    ]);
  });

  it("null: a label the picker does not show, two labels on a single-select, an Other row already typed into", () => {
    expect(keysFor(parsed("picker-single"), { labels: ["Durian"] })).toBeNull();
    expect(keysFor(parsed("picker-single"), { labels: ["Apple", "Banana"] })).toBeNull();
    expect(keysFor(parsed("picker-single"), { labels: [] })).toBeNull();
    expect(keysFor(parsed("picker-other-typed"), { labels: [], other: "x" })).toBeNull();
  });
});

describe("choiceFor (an inbox answer → what to select)", () => {
  it("single-select: a label, else free text", () => {
    expect(choiceFor("Banana", fruit)).toEqual({ labels: ["Banana"] });
    expect(choiceFor("durian please", fruit)).toEqual({ labels: [], other: "durian please" });
  });

  it("multi-select: labels joined with ', ' (as Claude Code reports them), the rest is free text", () => {
    expect(choiceFor("Cheese, Peppers", toppings)).toEqual({ labels: ["Cheese", "Peppers"] });
    expect(choiceFor("Cheese, anchovies", toppings)).toEqual({
      labels: ["Cheese"],
      other: "anchovies",
    });
  });
});

describe("parseReview (multi-select: the review screen after Submit)", () => {
  it("Submit answers highlighted: Enter", () => {
    expect(parseReview(screen("picker-review"))).toEqual(["Enter"]);
  });

  it("Cancel highlighted: Up, then Enter", () => {
    const s = screen("picker-review")
      .replace("❯ 1. Submit answers", "  1. Submit answers")
      .replace("  2. Cancel", "❯ 2. Cancel");
    expect(parseReview(s)).toEqual(["Up", "Enter"]);
  });

  it("null when no review screen is shown", () => {
    expect(parseReview(screen("picker-multi"))).toBeNull();
    expect(parseReview(screen("picker-gone"))).toBeNull();
  });
});

describe("promptIdle (a handoff reply is typed only into an idle, empty prompt)", () => {
  it("the empty input box after a turn ended", () => {
    expect(promptIdle(screen("picker-gone"))).toBe(true);
  });

  it("not while working, at a picker, with text already typed, or with nothing on screen", () => {
    expect(promptIdle(screen("claude-session"))).toBe(false);
    expect(promptIdle(screen("picker-single"))).toBe(false);
    expect(promptIdle(screen("picker-gone").replace(/^❯$/m, "❯ half a sentence"))).toBe(false);
    expect(promptIdle(null)).toBe(false);
  });
});
