/** A terminal prompt that does not echo what is typed: a password, a pasted sign-in code. */

/** What the hidden prompt has read so far: the value, and an escape sequence being skipped. */
export interface HiddenInput {
  value: string;
  /** Inside ESC (`esc`), ESC [ … (`csi`) or ESC O x (`ss3`): an arrow or function key. */
  skip: "" | "esc" | "csi" | "ss3";
}

/**
 * Feed typed text to the hidden prompt: Enter ends it, Backspace edits, Ctrl-C cancels, Ctrl-D
 * gives up; an arrow or function key (an escape sequence) adds nothing. Null while it goes on.
 */
export function hiddenKeys(state: HiddenInput, text: string): "enter" | "cancel" | "eof" | null {
  for (const ch of text) {
    if (state.skip === "esc") {
      state.skip = ch === "[" ? "csi" : ch === "O" ? "ss3" : "";
      continue;
    }
    if (state.skip === "ss3") {
      state.skip = "";
      continue;
    }
    if (state.skip === "csi") {
      // Parameters and intermediates until the final byte (@ to ~).
      if (ch >= "@" && ch <= "~") state.skip = "";
      continue;
    }
    if (ch === "\r" || ch === "\n") return "enter";
    if (ch === "\u0003") return "cancel";
    if (ch === "\u0004") return "eof";
    if (ch === "\u001b") state.skip = "esc";
    else if (ch === "\u007f" || ch === "\b") state.value = state.value.slice(0, -1);
    else if (ch >= " ") state.value += ch;
  }
  return null;
}

/**
 * Read one line from the terminal without echoing it (raw mode; see `hiddenKeys`). Null when
 * stdin is not a terminal, on Ctrl-D, or once `signal` aborts; Ctrl-C rejects ("cancelled").
 */
export function askHidden(
  prompt: string,
  signal?: AbortSignal,
  cancelled = "cancelled (Ctrl-C): nothing was stored",
): Promise<string | null> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true || signal?.aborted === true) return Promise.resolve(null);
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    const state: HiddenInput = { value: "", skip: "" };
    const stop = () => {
      stdin.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onAbort = () => {
      stop();
      resolve(null);
    };
    const onData = (d: Buffer) => {
      const end = hiddenKeys(state, d.toString("utf-8"));
      if (end === null) return;
      stop();
      if (end === "cancel") reject(new Error(cancelled));
      else resolve(end === "enter" ? state.value : null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
