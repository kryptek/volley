import { DAEMON_DEFAULTS } from "../config-defaults";
import { answerTextRefusal, mintHandoffToken, mintPickerToken } from "../fence";
import type { Host } from "../hosts/host";
import type { InboxItem } from "./inbox";
import {
  type Key,
  type PickerWant,
  choiceFor,
  keysFor,
  matches,
  parsePicker,
  parseReview,
  promptIdle,
  questionOnScreen,
} from "./picker";

/**
 * Carrying out an inbox answer in the session it is about (SPEC §4.6.18): read the screen, check
 * it still shows what the item asks, then press the keys, each behind a fence token minted for
 * exactly this item version and answer. Resolves with why it was not done (the item stays open),
 * or null once the keys are sent. A read that fails or shows something else refuses; keys that
 * fail half-way reject (the hooks report what the session then did).
 */

export interface CarryDeps {
  host: Host;
  workspace: string;
  /** A bounded screen read (null: unreadable). */
  readScreen: (workspace: string) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
}

/** The picker an item describes, or why its answer cannot be selected from a screen. */
function wantOf(item: InboxItem): PickerWant | string {
  const questions = item.source.questions;
  if (Array.isArray(questions) && questions.length > 1)
    return `a picker with ${questions.length} questions: answer it in its terminal`;
  if (item.options === undefined || item.options.length === 0)
    return "a picker without options: answer it in its terminal";
  return { question: item.question, options: item.options, multi: item.multi === true };
}

/** A screen read that failed: the session (or its workspace) may be gone. */
export const SCREEN_UNREADABLE = "the session's screen cannot be read: it may have ended";

async function press(d: CarryDeps, keys: readonly Key[], item: InboxItem): Promise<void> {
  const text = keys.find((k): k is { text: string } => typeof k === "object")?.text;
  const picker = mintPickerToken({
    item_id: item.id,
    version: item.version,
    keys: keys.filter((k): k is Exclude<Key, { text: string }> => typeof k === "string"),
    ...(text !== undefined ? { text } : {}),
  });
  for (const k of keys) {
    if (typeof k === "string") await d.host.sendKeys(d.workspace, k, { picker });
    else await d.host.sendText(d.workspace, k.text, { picker });
  }
}

/** Select `answer` in the item's picker by keystroke, after the screen showed that picker. */
export async function carryPicker(
  d: CarryDeps,
  item: InboxItem,
  answer: string,
): Promise<string | null> {
  const want = wantOf(item);
  if (typeof want === "string") return want;
  const screen = await d.readScreen(d.workspace);
  if (screen === null) return SCREEN_UNREADABLE;
  const parsed = parsePicker(screen);
  if (parsed === null || !matches(parsed, want)) return "picker not on screen";
  const keys = keysFor(parsed, choiceFor(answer, want));
  if (keys === null) return `the picker cannot take '${answer}'`;
  // The fence refuses bad Other text too; checked first so the Desk gets plain words.
  const text = keys.find((k): k is { text: string } => typeof k === "object")?.text;
  const why = text !== undefined ? answerTextRefusal(text) : null;
  if (why !== null) return `an Other answer must be one line of plain text, not ${why}`;
  await press(d, keys, item);
  if (!parsed.multi) return null;
  // Multi-select: Submit opens a review screen, which takes one more Enter.
  for (let i = 0; i < DAEMON_DEFAULTS.picker_review_reads; i++) {
    if (i > 0) await d.sleep(DAEMON_DEFAULTS.picker_review_gap_ms);
    const review = parseReview(await d.readScreen(d.workspace));
    if (review !== null) {
      await press(d, review, item);
      return null;
    }
  }
  throw new Error(
    "the picker's review screen did not appear after Submit; the toggles and Submit were pressed, so finish it in its terminal",
  );
}

/** Type the reply into the session's idle prompt, below the question it asked, and submit it. */
export async function carryHandoff(
  d: CarryDeps,
  item: InboxItem,
  answer: string,
): Promise<string | null> {
  // The fence refuses these too; checked first so the Desk gets plain words, not fence wording.
  const why = answerTextRefusal(answer);
  if (why !== null) return `a reply must be one line of plain text, not ${why}`;
  const screen = await d.readScreen(d.workspace);
  if (screen === null) return SCREEN_UNREADABLE;
  if (!promptIdle(screen)) return "prompt not idle";
  if (!questionOnScreen(screen, item.question)) return "the question is not on screen";
  const handoff = mintHandoffToken({ item_id: item.id, version: item.version, text: answer });
  await d.host.sendText(d.workspace, answer, { handoff });
  await d.host.sendKeys(d.workspace, "Enter");
  return null;
}
