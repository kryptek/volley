/**
 * The commands a shell command line would execute, as one string per simple command: the
 * words after quote removal, joined by single spaces. Pure, never throws (an unterminated
 * quote, substitution or heredoc runs to the end of the input).
 *
 * Splits on `;`, `&`, `&&`, `||`, `|`, newlines and `( … )`; `$( … )`, backticks and `<( … )`
 * / `>( … )` (also inside double quotes) contribute their own commands. Drops what the shell
 * would not run as a command: `#` comments, heredoc bodies, redirect targets, leading keywords
 * and `NAME=value` assignments, the arguments of `echo` / `printf`, git's `-m` / `--message`
 * and gh's `--title` / `--body` / `--notes` values. The script of `sh -c` / `bash -c` (and
 * friends) and `eval`'s arguments are split in turn.
 *
 * A heuristic, not a shell: aliases, functions, script files and `case` patterns are not
 * followed.
 */
export function executableSegments(command: string): string[] {
  const out: string[] = [];
  new Lexer(command, out).list(null);
  return out;
}

/** Words that may precede the command name without being it. */
const PREFIX = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "time",
  "exec",
  "command",
  "nohup",
  "env",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Per command name: the options whose value is message text, never a command. */
const MESSAGE_OPTIONS: Record<string, string[]> = {
  git: ["-m", "--message"],
  gh: ["-t", "--title", "-b", "--body", "--notes"],
};
/** Ends an unquoted word (besides whitespace). */
const METACHARS = new Set([";", "&", "|", "<", ">", "(", ")", "\n"]);

/** One simple command's words, rendered into `out` (plus any nested scripts). */
function render(words: string[], out: string[]): void {
  let k = 0;
  while (k < words.length && (PREFIX.has(words[k] ?? "") || ASSIGNMENT.test(words[k] ?? ""))) k++;
  const argv = words.slice(k);
  const first = argv[0];
  if (first === undefined) return;
  const name = first.slice(first.lastIndexOf("/") + 1);
  if (name === "echo" || name === "printf") {
    out.push(first);
    return;
  }
  if (name === "eval") {
    out.push(...executableSegments(argv.slice(1).join(" ")));
    return;
  }
  if (SHELLS.has(name)) {
    const c = argv.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/i.test(w));
    if (c > 0) {
      out.push(first);
      out.push(...executableSegments(argv[c + 1] ?? ""));
      return;
    }
  }
  const messageOptions = MESSAGE_OPTIONS[name];
  if (messageOptions !== undefined) {
    const kept: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const w = argv[i] ?? "";
      if (messageOptions.includes(w)) i++;
      else if (!messageOptions.some((o) => w.startsWith(o.startsWith("--") ? `${o}=` : o)))
        kept.push(w);
    }
    out.push(kept.join(" "));
    return;
  }
  out.push(argv.join(" "));
}

class Lexer {
  private i = 0;
  private readonly heredocs: { delimiter: string; stripTabs: boolean }[] = [];

  constructor(
    private readonly src: string,
    private readonly out: string[],
  ) {}

  /** Parses commands until `close` (consumed) or the end of the input. */
  list(close: ")" | "`" | null): void {
    const { src } = this;
    let words: string[] = [];
    let word: string | null = null;
    let redirectTarget = false;
    let depth = 0;
    const endWord = () => {
      if (word !== null) {
        if (redirectTarget) redirectTarget = false;
        else if (word !== "") words.push(word);
      }
      word = null;
    };
    const endCommand = () => {
      endWord();
      render(words, this.out);
      words = [];
    };
    while (this.i < src.length) {
      const c = src[this.i] ?? "";
      const next = src[this.i + 1];
      if (c === "`" && close === "`") {
        this.i++;
        endCommand();
        return;
      }
      if (c === ")") {
        this.i++;
        if (depth === 0 && close === ")") {
          endCommand();
          return;
        }
        if (depth > 0) depth--;
        endCommand();
      } else if (c === " " || c === "\t") {
        endWord();
        this.i++;
      } else if (c === "\n") {
        endCommand();
        this.i++;
        this.skipHeredocBodies();
      } else if (c === "\\") {
        if (next !== "\n") word = (word ?? "") + (next ?? "");
        this.i += 2;
      } else if (c === "#" && word === null) {
        const nl = src.indexOf("\n", this.i);
        this.i = nl === -1 ? src.length : nl;
      } else if (c === "'") {
        word = (word ?? "") + this.singleQuoted();
      } else if (c === '"') {
        word = (word ?? "") + this.doubleQuoted();
      } else if (c === "$" && next === "(") {
        this.i += 2;
        this.list(")");
        word = word ?? "";
      } else if (c === "$" && next === "'") {
        this.i++;
        word = (word ?? "") + this.singleQuoted(true);
      } else if (c === "`") {
        this.i++;
        this.list("`");
        word = word ?? "";
      } else if ((c === "<" || c === ">") && next === "(") {
        this.i += 2;
        this.list(")");
        word = word ?? "";
      } else if (c === "<" || c === ">" || (c === "&" && next === ">")) {
        // A redirection: an fd number before it and the target after it are not arguments.
        if (word !== null && /^\d+$/.test(word)) word = null;
        endWord();
        if (src.startsWith("<<<", this.i)) {
          this.i += 3;
        } else if (src.startsWith("<<", this.i)) {
          this.i += 2;
          const stripTabs = src[this.i] === "-";
          if (stripTabs) this.i++;
          this.heredocs.push({ delimiter: this.heredocDelimiter(), stripTabs });
          continue;
        } else {
          this.i++;
          while (this.i < src.length && ">&|".includes(src[this.i] ?? "")) this.i++;
        }
        redirectTarget = true;
      } else if (c === ";" || c === "&" || c === "|") {
        endCommand();
        this.i++;
      } else if (c === "(") {
        depth++;
        endCommand();
        this.i++;
      } else {
        word = (word ?? "") + c;
        this.i++;
      }
    }
    endCommand();
  }

  /** At an opening `'`: the quoted text (`$'…'` honours backslash escapes). */
  private singleQuoted(ansiC = false): string {
    const { src } = this;
    let s = "";
    this.i++;
    while (this.i < src.length && src[this.i] !== "'") {
      if (ansiC && src[this.i] === "\\") this.i++;
      s += src[this.i] ?? "";
      this.i++;
    }
    this.i++;
    return s;
  }

  /** At an opening `"`: the quoted text; substitutions inside it are parsed as commands. */
  private doubleQuoted(): string {
    const { src } = this;
    let s = "";
    this.i++;
    while (this.i < src.length && src[this.i] !== '"') {
      const c = src[this.i];
      if (c === "\\" && '$`"\\\n'.includes(src[this.i + 1] ?? "")) {
        if (src[this.i + 1] !== "\n") s += src[this.i + 1];
        this.i += 2;
      } else if (c === "$" && src[this.i + 1] === "(") {
        this.i += 2;
        this.list(")");
      } else if (c === "`") {
        this.i++;
        this.list("`");
      } else {
        s += c;
        this.i++;
      }
    }
    this.i++;
    return s;
  }

  /** After `<<` / `<<-`: the delimiter word, quotes removed. */
  private heredocDelimiter(): string {
    const { src } = this;
    while (src[this.i] === " " || src[this.i] === "\t") this.i++;
    let d = "";
    while (this.i < src.length) {
      const c = src[this.i] ?? "";
      if (c === " " || c === "\t" || METACHARS.has(c)) break;
      if (c === "'") d += this.singleQuoted();
      else if (c === '"') d += this.doubleQuoted();
      else if (c === "\\") {
        d += src[this.i + 1] ?? "";
        this.i += 2;
      } else {
        d += c;
        this.i++;
      }
    }
    return d;
  }

  /** After a newline: skips the bodies of the heredocs opened on the line just ended. */
  private skipHeredocBodies(): void {
    const { src } = this;
    for (const { delimiter, stripTabs } of this.heredocs.splice(0)) {
      while (this.i < src.length) {
        const nl = src.indexOf("\n", this.i);
        const end = nl === -1 ? src.length : nl;
        const line = src.slice(this.i, end);
        this.i = end + 1;
        if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
      }
    }
  }
}
