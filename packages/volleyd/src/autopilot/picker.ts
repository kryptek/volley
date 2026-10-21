/**
 * Screen-verified keystroke selection in a Claude Code `AskUserQuestion` picker (the needs-you
 * inbox's `picker` items, SPEC §4.6.18). Pure: the daemon reads the screen, these functions say
 * whether it still shows the item's picker and which keys select an answer, and the host adapter
 * presses them (each key behind the fence's PickerToken).
 *
 * What the spike found (Claude Code 2.1, driven by hand in tmux; scripts/spike-picker.ts is the
 * re-runnable cmux version):
 *   - The picker is drawn below a rule: a header chip line (` ☐ Fruit`; multi-select
 *     `←  ☐ Toppings  ✔ Submit  →`), the question, then numbered rows `  1. Apple`, each option's
 *     description indented below it. After the options comes the free-text row
 *     (`Type something.`; once typed into, it shows the text), then for multi-select an unnumbered
 *     `Submit` row, a rule, `Chat about this`, and the footer `Enter to select · ↑/↓ to navigate`.
 *   - The highlighted row is the one whose first column is `❯` (the others start with a space).
 *     The prompt echoed above the picker starts with `❯` too, so only rows below the header count.
 *     Multi-select rows carry a checkbox, `[ ]` or `[✔]`.
 *   - `Down` stops at the last row and `Up` at the first (no wrap). Keys sent back to back, with
 *     no delay between them, all land.
 *   - Single-select: `Enter` picks the highlighted row and closes the picker.
 *   - Other: on the free-text row the text is typed straight in (no `Enter` first); `Enter` then
 *     submits it. In a multi-select picker typing checks the row.
 *   - Multi-select: `Space` (or `Enter`) toggles the highlighted row; the answer is submitted from
 *     the `Submit` row with `Enter`, which opens a review screen (`Review your answers`, rows
 *     `Submit answers` / `Cancel`, the first highlighted) that takes one more `Enter`.
 *   - Claude Code reports a multi-select answer as the labels joined with `, `.
 */

/** A key the host adapter presses, or text it types (`{ text }`). */
export type Key = "Up" | "Down" | "Space" | "Enter" | { text: string };

export interface PickerRow {
  label: string;
  highlighted: boolean;
  /** Multi-select only: the checkbox is ticked. */
  checked?: boolean;
}

/** What the screen shows of a picker, or null when it shows none. */
export interface ParsedPicker {
  /** The question, its wrapped lines joined with single spaces. */
  question: string;
  multi: boolean;
  options: PickerRow[];
  /** The free-text row: `Type something` until typed into, then the text. */
  other: PickerRow;
  /** Multi-select's `Submit` row. */
  submit: { highlighted: boolean } | null;
  /** `Chat about this`, below the rule. */
  chat: { highlighted: boolean } | null;
}

/** What to select: option labels, and free text for the Other row. */
export interface PickerChoice {
  labels: string[];
  other?: string;
}

/** The picker an inbox item expects (its question, options and multi flag). */
export interface PickerWant {
  question: string;
  options: readonly { label: string }[];
  multi?: boolean;
}

const FOOTER = /Enter to select.*to navigate/;
const HEADER = /^\s*(?:←\s+)?[☐☒]\s+\S/;
const ROW = /^([❯ ]) (\d+)\. (.*)$/;
const SUBMIT = /^([❯ ])\s+Submit$/;
const RULE = /^─{10,}/;
const CHECKBOX = /^\[(.)\] (.*)$/;
const PROMPT = "❯";

/** The screen's lines, non-breaking spaces read as spaces, trailing blanks cut. */
const linesOf = (screen: string): string[] =>
  screen.split("\n").map((l) => l.replaceAll(" ", " ").trimEnd());

/** The index of the last element matching `pred`, or -1. */
function lastIndex<T>(xs: readonly T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i] as T)) return i;
  return -1;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export function parsePicker(screen: string | null): ParsedPicker | null {
  if (screen === null) return null;
  const lines = linesOf(screen);
  const f = lastIndex(lines, (l) => FOOTER.test(l));
  if (f < 0) return null;
  const h = lastIndex(lines.slice(0, f), (l) => HEADER.test(l));
  if (h < 0) return null;
  const question: string[] = [];
  const choices: PickerRow[] = [];
  let submit: ParsedPicker["submit"] = null;
  let chat: ParsedPicker["chat"] = null;
  let ruled = false;
  for (const line of lines.slice(h + 1, f)) {
    if (RULE.test(line)) {
      ruled = true;
      continue;
    }
    const row = ROW.exec(line);
    if (row !== null) {
      const highlighted = row[1] === PROMPT;
      if (ruled) {
        chat = { highlighted };
        continue;
      }
      const box = CHECKBOX.exec(row[3] ?? "");
      choices.push(
        box !== null
          ? { label: box[2] ?? "", highlighted, checked: box[1] !== " " }
          : { label: row[3] ?? "", highlighted },
      );
      continue;
    }
    const sub = SUBMIT.exec(line);
    if (sub !== null && !ruled && choices.length > 0) {
      submit = { highlighted: sub[1] === PROMPT };
      continue;
    }
    if (choices.length === 0 && line.trim() !== "") question.push(line.trim());
  }
  const other = choices.at(-1);
  if (other === undefined || choices.length < 2 || question.length === 0) return null;
  const options = choices.slice(0, -1);
  const multi = choices.some((c) => c.checked !== undefined);
  const lit = [...choices, submit, chat].filter((r) => r?.highlighted).length;
  if (lit !== 1) return null;
  return { question: question.join(" "), multi, options, other, submit, chat };
}

/** The screen still shows the item's picker: its question's first line and labels, in order. */
export function matches(p: ParsedPicker | null, want: PickerWant): boolean {
  if (p === null || p.multi !== (want.multi ?? false)) return false;
  const first = collapse(want.question.split("\n")[0] ?? "");
  if (first === "" || !collapse(p.question).startsWith(first)) return false;
  return (
    p.options.length === want.options.length &&
    p.options.every((o, i) => o.label === want.options[i]?.label)
  );
}

/** The rows the cursor moves through, top to bottom, and where it is now. */
function navigation(p: ParsedPicker): {
  rows: number;
  cursor: number;
  other: number;
  submit: number;
} {
  const other = p.options.length;
  const submit = p.submit !== null ? other + 1 : -1;
  const chat = (submit >= 0 ? submit : other) + 1;
  const cursor = p.options.findIndex((o) => o.highlighted);
  const at =
    cursor >= 0
      ? cursor
      : p.other.highlighted
        ? other
        : p.submit?.highlighted === true
          ? submit
          : chat;
  return { rows: chat + 1, cursor: at, other, submit };
}

const move = (from: number, to: number): Key[] =>
  Array<Key>(Math.abs(to - from)).fill(to > from ? "Down" : "Up");

/**
 * The keys that select `choice` from where the cursor is, or null when the picker cannot take it:
 * a label it does not show, not exactly one answer on a single-select, or an Other row that
 * already holds typed text.
 */
export function keysFor(p: ParsedPicker, choice: PickerChoice): Key[] | null {
  const index = choice.labels.map((l) => p.options.findIndex((o) => o.label === l));
  if (index.some((i) => i < 0)) return null;
  const typed = choice.other !== undefined && choice.other !== "";
  if (typed && p.other.label !== "Type something" && p.other.label !== "Type something.")
    return null;
  const nav = navigation(p);
  const keys: Key[] = [];
  let at = nav.cursor;
  const goTo = (row: number) => {
    keys.push(...move(at, row));
    at = row;
  };
  if (!p.multi) {
    if (index.length + (typed ? 1 : 0) !== 1) return null;
    if (typed) {
      goTo(nav.other);
      keys.push({ text: choice.other as string }, "Enter");
    } else {
      goTo(index[0] as number);
      keys.push("Enter");
    }
    return keys;
  }
  if (index.length === 0 && !typed) return null;
  // An Other row already ticked would be reported too, and Space on the free-text row is not
  // screen-verified to untick it: refused, so the terminal answers it.
  if (!typed && p.other.checked === true) return null;
  const want = new Set(index);
  p.options.forEach((o, i) => {
    if ((o.checked === true) === want.has(i)) return;
    goTo(i);
    keys.push("Space");
  });
  if (typed) {
    goTo(nav.other);
    keys.push({ text: choice.other as string });
  }
  goTo(nav.submit);
  keys.push("Enter");
  return keys;
}

/**
 * An inbox answer as a selection: a label, else free text; for multi-select the labels joined
 * with `, ` (how Claude Code reports them), whatever is not a label being the free text. The
 * longest run of parts that is a label wins, so a label holding `, ` itself is matched whole.
 */
export function choiceFor(answer: string, want: PickerWant): PickerChoice {
  const labels = want.options.map((o) => o.label);
  if (labels.includes(answer)) return { labels: [answer] };
  if (!want.multi) return { labels: [], other: answer };
  const parts = answer.split(", ").map((s) => s.trim());
  const picked: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < parts.length; ) {
    let end = parts.length;
    while (end > i && !labels.includes(parts.slice(i, end).join(", "))) end--;
    if (end > i) {
      picked.push(parts.slice(i, end).join(", "));
      i = end;
    } else {
      if (parts[i] !== "") rest.push(parts[i] as string);
      i++;
    }
  }
  return rest.length === 0 ? { labels: picked } : { labels: picked, other: rest.join(", ") };
}

/** Multi-select's review screen: the keys that press `Submit answers`, or null when not shown. */
export function parseReview(screen: string | null): Key[] | null {
  if (screen === null) return null;
  const lines = linesOf(screen);
  const r = lastIndex(lines, (l) => l.trim() === "Review your answers");
  if (r < 0) return null;
  const rows = lines
    .slice(r + 1)
    .map((l) => ROW.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  const submit = rows.findIndex((m) => m[3] === "Submit answers");
  const cursor = rows.findIndex((m) => m[1] === PROMPT);
  if (submit < 0 || cursor < 0) return null;
  return [...move(cursor, submit), "Enter"];
}

/** Letters and digits only, lowercased: what survives wrapping, indents and markdown rendering. */
const bare = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The session's screen shows `question` (its last non-empty line) above its last prompt: the
 * idle prompt is the one that asked, not another session's holding the same workspace ref.
 * A short last line ("Proceed?") is a weak identity check on its own; the daemon's workspace
 * holder check is what guards the ref.
 */
export function questionOnScreen(screen: string | null, question: string): boolean {
  if (screen === null) return false;
  const want = bare(
    question
      .split("\n")
      .filter((l) => l.trim() !== "")
      .at(-1) ?? "",
  );
  if (want === "") return false;
  const lines = linesOf(screen);
  const i = lastIndex(lines, (l) => l.startsWith(PROMPT));
  return bare(lines.slice(0, Math.max(i, 0)).join("")).includes(want);
}

/**
 * Claude Code waits at an empty prompt: the last input box (`❯` alone between two rules) and no
 * turn running (`esc to interrupt`). A handoff reply is typed only then.
 */
export function promptIdle(screen: string | null): boolean {
  if (screen === null || /esc to interrupt/i.test(screen)) return false;
  const lines = linesOf(screen);
  const i = lastIndex(lines, (l) => l.startsWith(PROMPT));
  if (i < 1 || lines[i]?.trim() !== PROMPT) return false;
  if (lines.slice(i).some((l) => FOOTER.test(l))) return false;
  return RULE.test(lines[i - 1] ?? "") && RULE.test(lines[i + 1] ?? "");
}
