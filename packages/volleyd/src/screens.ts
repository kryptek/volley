/**
 * Pre-hook screen classification. Screens are read only while a spawn waits for the hooks'
 * SessionStart signal — once the hooks run they are the source of truth. Each class maps to one
 * mechanical action in verify.ts:
 *
 *   trust_dialog   Claude Code's folder-trust prompt     → decision repo_untrusted
 *   update_prompt  a shell/tool "update? [Y/n]" prompt   → Enter, then one relaunch
 *   login          Claude Code asking for a login        → decision unknown_screen
 *   credit_exhausted  a usage-limit / credit prompt     → decision unknown_screen (pre-hook);
 *                  on a silent registered agent: decision model_switch (liveness.ts, recovery.ts)
 *   working        Claude Code is up (hooks silent)      → decision unknown_screen
 *   shell_prompt   a bare shell prompt, nothing typed    → decision unknown_screen (after an
 *                  answered update prompt: the one place the launch command is typed again)
 *   empty          nothing on screen                     → decision unknown_screen
 *   unknown        anything else                         → decision unknown_screen
 */
export type ScreenClass =
  | "trust_dialog"
  | "update_prompt"
  | "login"
  | "credit_exhausted"
  | "working"
  | "shell_prompt"
  | "empty"
  | "unknown";

const PATTERNS: [ScreenClass, RegExp[]][] = [
  [
    "trust_dialog",
    [
      /do you trust the files in this folder/i,
      /is this a project you (created|trust)/i,
      /yes, i trust this folder/i,
    ],
  ],
  [
    "login",
    [
      /select login method/i,
      /please run \/login/i,
      /invalid api key/i,
      /oauth token (has )?expired/i,
      /paste code here if prompted/i,
    ],
  ],
  [
    "update_prompt",
    [
      /would you like to (update|check for updates)/i,
      /update (now|available)[^\n]*\[y\/n\]/i,
      /\[y\/n\][^\n]*update/i,
    ],
  ],
  // Before `working`: the credit prompt is drawn above Claude Code's own status bar.
  [
    "credit_exhausted",
    [
      /claude usage limit reached/i,
      /you(?:'|’)ve hit your (?:usage )?limit/i,
      /\/upgrade to increase your usage limit/i,
      /credit balance is too low/i,
      /out of (?:usage )?credits/i,
      /stop and wait for (?:the )?limit to reset/i,
    ],
  ],
  ["working", [/esc to interrupt/i, /bypass permissions on/i, /welcome to claude code/i, /⏵⏵/]],
];

/** A shell waiting for input: the last non-empty line ends in a prompt sign, nothing typed. */
const SHELL_PROMPT = /[$%#❯➜λ]\s*$/;

export function classifyScreen(text: string | null): ScreenClass {
  if (text === null || text.trim() === "") return "empty";
  for (const [cls, res] of PATTERNS) if (res.some((re) => re.test(text))) return cls;
  const last = text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .at(-1);
  return last !== undefined && SHELL_PROMPT.test(last) ? "shell_prompt" : "unknown";
}

/**
 * The model shown in Claude Code's status line, as a model id: a literal `claude-…` id, or a
 * display name like `Opus 5.5` → `claude-opus-5-5`. Null when none is visible. The fallback
 * model source when the hooks report `model_source: "unknown"`.
 */
export function modelFromScreen(text: string | null): string | null {
  if (text === null) return null;
  const lines = text.split("\n").reverse(); // the status line is at the bottom
  for (const line of lines) {
    const id = /\bclaude-(?:opus|sonnet|haiku|fable)-[0-9][a-z0-9-]*\b/i.exec(line);
    if (id !== null) return id[0].toLowerCase();
    const name = /\b(Opus|Sonnet|Haiku|Fable)\s+([0-9]+)(?:\.([0-9]+))?\b/.exec(line);
    if (name !== null) {
      const [, family, major, minor] = name;
      return `claude-${(family as string).toLowerCase()}-${major}${minor !== undefined ? `-${minor}` : ""}`;
    }
  }
  return null;
}
