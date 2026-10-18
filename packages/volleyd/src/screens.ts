/**
 * Pre-hook screen classification. Screens are read only while a spawn waits for the hooks'
 * SessionStart signal — once the hooks run they are the source of truth. Each class maps to one
 * mechanical action in verify.ts:
 *
 *   trust_dialog   Claude Code's folder-trust prompt     → decision repo_untrusted
 *   update_prompt  a shell/tool "update? [Y/n]" prompt   → Enter, then one relaunch
 *   login          Claude Code asking for a login        → decision unknown_screen
 *   working        Claude Code is up (hooks silent)      → decision unknown_screen
 *   empty          nothing on screen                     → decision unknown_screen
 *   unknown        anything else (e.g. a bare shell)     → decision unknown_screen
 */
export type ScreenClass =
  | "trust_dialog"
  | "update_prompt"
  | "login"
  | "working"
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
  ["working", [/esc to interrupt/i, /bypass permissions on/i, /welcome to claude code/i, /⏵⏵/]],
];

export function classifyScreen(text: string | null): ScreenClass {
  if (text === null || text.trim() === "") return "empty";
  for (const [cls, res] of PATTERNS) if (res.some((re) => re.test(text))) return cls;
  return "unknown";
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
