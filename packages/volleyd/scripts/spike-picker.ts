#!/usr/bin/env bun
/**
 * Spike (run by hand, never by CI): screen-verified keystroke selection in a live Claude Code
 * `AskUserQuestion` picker, through the fenced `exec` only (`cmux read-screen`, `cmux send-key`,
 * `cmux send`). It reads the workspace's screen, prints the parsed picker and the keys that would
 * select the answer; with `--send` it presses them, behind a PickerToken, exactly as volleyd does
 * for an inbox answer (src/autopilot/carry.ts). Its findings head src/autopilot/picker.ts; the
 * screens it saw are test/fixtures/screens/picker-*.txt.
 *
 *   bun scripts/spike-picker.ts --workspace <ref>                     # parse, print
 *   bun scripts/spike-picker.ts --workspace <ref> --select <answer>   # + the keys it would send
 *   bun scripts/spike-picker.ts --workspace <ref> --select <answer> --send
 *
 * `<answer>` is an option label, labels joined with `, ` (multi-select), or free text (Other).
 */
import { parseArgs } from "node:util";
import { carryPicker } from "../src/autopilot/carry";
import type { InboxItem } from "../src/autopilot/inbox";
import { choiceFor, keysFor, parsePicker } from "../src/autopilot/picker";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { exec } from "../src/exec";
import { LocalCmuxHost } from "../src/hosts/local-cmux";

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    select: { type: "string" },
    send: { type: "boolean", default: false },
  },
});
const workspace = values.workspace;
if (workspace === undefined) {
  console.error("usage: spike-picker.ts --workspace <ref> [--select <answer> [--send]]");
  process.exit(2);
}

const host = new LocalCmuxHost(exec);
const readScreen = (ws: string) => host.readScreen(ws, DAEMON_DEFAULTS.screen_lines);
const screen = await readScreen(workspace);
const parsed = parsePicker(screen);
console.log(JSON.stringify({ picker: parsed }, null, 2));
if (parsed === null) {
  console.log("no picker on screen");
  process.exit(1);
}
if (values.select === undefined) process.exit(0);

const want = { question: parsed.question, options: parsed.options, multi: parsed.multi };
const keys = keysFor(parsed, choiceFor(values.select, want));
console.log(JSON.stringify({ keys }));
if (keys === null || !values.send) process.exit(keys === null ? 1 : 0);

// The item volleyd would hold for this picker: what the screen shows is what it expects.
const item: InboxItem = {
  id: "p-spike-toolu_spike",
  kind: "picker",
  version: 1,
  owner_only: true,
  agent_id: "spike",
  title: "spike",
  question: parsed.question,
  options: parsed.options.map((o) => ({ label: o.label })),
  allow_other: true,
  multi: parsed.multi,
  pointers: {},
  opened_at: new Date().toISOString(),
  source: {},
};
const refused = await carryPicker(
  { host, workspace, readScreen, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  item,
  values.select,
);
console.log(refused === null ? "sent" : `refused: ${refused}`);
console.log(
  parsePicker(await readScreen(workspace)) === null ? "picker closed" : "picker still open",
);
