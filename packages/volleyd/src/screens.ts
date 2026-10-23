import { DAEMON_DEFAULTS } from "./config-defaults";

/**
 * Pre-hook screen classification. Screens are read only while a spawn waits for the hooks'
 * SessionStart signal — once the hooks run they are the source of truth. Each class maps to one
 * mechanical action in verify.ts:
 *
 *   trust_dialog   Claude Code's folder-trust prompt     → decision repo_untrusted
 *   first_run_theme, first_run_security, bypass_consent
 *                  Claude Code's first-run screens (theme picker, security notice, bypass-
 *                  permissions confirmation): a profile never prepared (#400) → the profile is
 *                  seeded and relaunched once; again → decision unknown_screen, in plain words
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
  | "first_run_theme"
  | "first_run_security"
  | "bypass_consent"
  | "update_prompt"
  | "login"
  | "credit_exhausted"
  | "working"
  | "shell_prompt"
  | "empty"
  | "unknown";

const PATTERNS: [ScreenClass, RegExp[]][] = [
  // First: the theme picker and the security notice sit under Claude Code's welcome banner,
  // which `working` matches too.
  ["first_run_theme", [/choose the text style that looks best/i, /syntax theme:.*ctrl\+t/i]],
  ["first_run_security", [/security notes:/i, /due to prompt injection risks/i]],
  ["bypass_consent", [/running in bypass permissions mode/i, /yes, i accept/i]],
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

/** The first-run screens, by what the owner sees: `theme picker` and so on. */
export const FIRST_RUN_SCREENS = {
  first_run_theme: "theme picker",
  first_run_security: "security notice",
  bypass_consent: "bypass-permissions confirmation",
} as const;
export type FirstRunScreen = keyof typeof FIRST_RUN_SCREENS;

export const isFirstRunScreen = (c: ScreenClass): c is FirstRunScreen =>
  Object.hasOwn(FIRST_RUN_SCREENS, c);

/** A screen class in plain words for a decision: a first-run screen's name, else the class. */
export function screenWords(c: ScreenClass): string {
  return isFirstRunScreen(c) ? FIRST_RUN_SCREENS[c] : c;
}

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

/**
 * The session's last output, for a decision that says why an agent did not start: its last
 * non-blank screen lines, joined, cut to a readable length; null when nothing is on screen.
 */
export function lastOutput(screen: string | null): string | null {
  const lines = (screen ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(-DAEMON_DEFAULTS.decision_output_lines);
  if (lines.length === 0) return null;
  const text = lines.join(" ");
  const max = DAEMON_DEFAULTS.decision_output_chars;
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

/**
 * ` Last output: “…”.`, or what an empty screen means, for a decision's question. `out` is
 * `lastOutput(screen)`.
 */
export function lastOutputNote(out: string | null, remote: boolean): string {
  return out !== null
    ? ` Last output: “${out}”.`
    : ` There is nothing on screen: its session may have ended at once${remote ? " (on a remote machine, check that claude and bun are on its non-interactive ssh PATH)" : ""}.`;
}

/** Claude Code's status bar count of background work, e.g. `· 2 shells still running`. */
const SHELLS_RUNNING = /\b(\d+)\s+(?:background\s+)?(?:shells?|tasks?)\s+(?:still\s+)?running\b/i;

/**
 * How many background shells the footer (the lines from Claude Code's input box down, see
 * `screenFooter`) says are still running: 0 when the footer says none, null without a footer.
 */
export function shellsRunning(footer: readonly string[]): number | null {
  if (footer.length === 0) return null;
  for (const line of footer) {
    const m = SHELLS_RUNNING.exec(line);
    if (m !== null) return Number(m[1]);
  }
  return 0;
}
