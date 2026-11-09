/**
 * How a GitHub issue becomes a wave-file task: its id (the title's task tag, else `i<N>`) and
 * its dependencies (the body's `Depends on:` line). Shared by volley-issues' `wave-from-issues`
 * (a wave's first version) and `volleyd add` (a task a later version adds), so an id or a
 * dependency is derived by one rule. Pure.
 */

/** One issue as `gh issue view <n> --json number,title,body` prints it. */
export interface IssueInput {
  number: number;
  title: string;
  body: string;
}

/** Optional markdown emphasis around the label (`**Depends on:**`, `_deps_:`). */
const EMPH = String.raw`(?:\*\*|__|[*_\`])?`;

/** A `deps:` line (line start or list item, colon required); group 1 is the text after it. */
const DEPS_LINE = new RegExp(
  String.raw`^\s*(?:[-*+]\s+)?${EMPH}\s*deps\s*${EMPH}\s*:\s*${EMPH}(.*)$`,
  "i",
);

/**
 * A `Depends on` label anywhere on a line, emphasis allowed, colon optional (group 1 is the
 * colon when present). The text after it is the clause's candidate.
 */
const DEPENDS_LABEL = new RegExp(
  String.raw`(?<!\w)${EMPH}\s*depends\s+on\b\s*${EMPH}\s*(:)?\s*${EMPH}`,
  "gi",
);

/** A `Blocks:` label (the inverse edge, never read here): one way a clause ends. */
const BLOCKS_LABEL = new RegExp(String.raw`(?<!\w)${EMPH}\s*blocks\s*${EMPH}\s*:`, "iy");

/** A reference at the start of the text (after whitespace): `;` before one separates, not ends. */
const LEADING_REF = /^\s*(?:https?:\/\/github\.com\/|(?:[\w.-]+\/[\w.-]+)?#\d)/i;

/**
 * Where the clause starting at `text` ends: at a `Blocks:` label, or a sentence break (`.`, `;`
 * or `!` followed by whitespace or the end of the line) outside parentheses and backtick spans,
 * else at the end of the line. A `;` followed by a reference separates two references instead.
 */
function clauseEnd(text: string): number {
  let depth = 0;
  let code = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === "`") code = !code;
    if (code) continue;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (depth > 0) continue;
    BLOCKS_LABEL.lastIndex = k;
    if (BLOCKS_LABEL.test(text)) return k;
    if ((c === "." || c === ";" || c === "!") && /^(?:\s|$)/.test(text.slice(k + 1, k + 2))) {
      if (c === ";" && LEADING_REF.test(text.slice(k + 1))) continue;
      return k;
    }
  }
  return text.length;
}

/**
 * Whether the `Depends on` label at `at` sits in an inline code span that quotes more than the
 * label itself (`` `Depends on: #N` `` in prose is an example, not a clause; `` `Depends on`: ``
 * is emphasis).
 */
function quoted(line: string, at: number): boolean {
  // A code span opens with a run of backticks and closes at the next run of the same length.
  const runs = [...line.matchAll(/`+/g)].map((r) => ({ at: r.index, len: r[0].length }));
  for (let k = 0; k < runs.length; k++) {
    const open = runs[k] as { at: number; len: number };
    const close = runs.slice(k + 1).find((r) => r.len === open.len);
    if (close === undefined) continue;
    if (open.at < at && at < close.at) {
      return !/^\s*depends\s+on\s*:?\s*$/i.test(line.slice(open.at + open.len, close.at));
    }
    k = runs.indexOf(close);
  }
  return false;
}

/** A markdown list item; group 1 is its text. */
const LIST_ITEM = /^\s*[-*+]\s+(.*)$/;

/**
 * An issue reference: a GitHub issue URL (`https://github.com/owner/repo/issues/N`), or `#N`
 * optionally repo-qualified (`owner/repo#N`).
 */
export const ISSUE_REF =
  /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\b|(?:\b([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;

/** Dependency-line text that declares no dependencies (after parentheticals and punctuation). */
const NONE = new Set(["none", "nothing", "n/a", "-", "—"]);

/**
 * A task tag at the start of an issue title (`O0: …`, `T3b — …`, `D10 - …`); group 1 is the tag.
 * Every tag it matches fits the wave-file task-id grammar.
 */
export const TITLE_TAG = /^([A-Z]{1,3}\d{1,3}[a-z]?)\s*[:—–-]/;

/**
 * Product, format and numeronym names that fit the tag grammar but name a subject, not a task
 * (`S3: upload fails`). A title starting with one keeps the `i<N>` fallback id.
 */
export const NOT_TAGS = new Set([
  "S3",
  "EC2",
  "K8s",
  "MP3",
  "MP4",
  "UTF8",
  "H264",
  "X11",
  "V8",
  "ES5",
  "ES6",
  "CSS3",
  "MD5",
  "I18n",
  "L10n",
  "A11y",
]);

/** The wave-file task id for an issue: its title's task tag, else `i<number>`. */
export function taskIdFor(issue: number, title?: string): string {
  const tag = typeof title === "string" ? TITLE_TAG.exec(title)?.[1] : undefined;
  return tag !== undefined && !NOT_TAGS.has(tag) ? tag : `i${issue}`;
}

/**
 * Task ids for a set of issues (unique numbers), never two that differ only in case (volleyd
 * rejects those), nor one that differs only in case from an id in `taken` (the wave's existing
 * tasks, which never change). Issues whose tags collide, with each other, with a fallback id or
 * with a taken id, fall back to `i<N>`, which is unique, with a warning naming them. A fallback
 * id that is itself taken is an error.
 */
export function assignTaskIds(
  issues: IssueInput[],
  taken: Iterable<string> = [],
): { ids: Map<number, string>; warnings: string[] } {
  const ids = new Map(issues.map((i) => [i.number, taskIdFor(i.number, i.title)]));
  const held = new Map([...taken].map((id) => [id.toLowerCase(), id]));
  const warnings: string[] = [];
  for (;;) {
    const owners = new Map<string, number[]>();
    for (const [n, id] of ids) {
      const key = id.toLowerCase();
      owners.set(key, [...(owners.get(key) ?? []), n]);
    }
    const clash = [...owners.entries()].find(([key, ns]) => ns.length > 1 || held.has(key));
    if (clash === undefined) return { ids, warnings };
    const [key, ns] = clash;
    const tagged = ns.filter((n) => ids.get(n) !== `i${n}`);
    const existing = held.get(key);
    if (tagged.length === 0) {
      throw new Error(
        `task id '${existing}' is already taken in the wave, so #${ns[0]} has no id to fall back to (give it a title tag)`,
      );
    }
    const named = [
      ...(existing !== undefined ? [`${existing} (already in the wave)`] : []),
      ...ns.map((n) => `#${n}`),
    ];
    warnings.push(
      `title tag '${ids.get(tagged[0] ?? 0)}' would name more than one task (${named.join(", ")}); using ${tagged.map((n) => `i${n}`).join(", ")} instead (give them distinct title tags to keep tag ids)`,
    );
    for (const n of tagged) ids.set(n, `i${n}`);
  }
}

/**
 * The issues named on the body's dependency clauses. A `Depends on` clause may sit anywhere on a
 * line, its colon optional: without one it is a clause only when a reference follows before it
 * ends (otherwise it is prose and ignored). It runs from the label to the first sentence break or
 * `Blocks:` label; text before the label and after the end is ignored. A `deps:` line opens its
 * line (or list item) and needs its colon. `declared: false` means there is no clause at all (as
 * opposed to `Depends on: none` / `nothing`). An empty label reads the list items on the lines
 * that follow. A reference to another repository is an error (a wave's tasks all live in one
 * repository; `repoSlug` names it), and so is any text in a clause that is neither a reference
 * nor a none-word: a dependency is never silently dropped.
 */
export function parseDependsOn(
  body: string,
  repoSlug?: string,
): { declared: boolean; refs: number[] } {
  let declared = false;
  const refs: number[] = [];
  /** Read the references in `text` (from `line`, 1-based `lineNo`); anything else is an error. */
  const read = (text: string, line: string, lineNo: number) => {
    let found = 0;
    for (const [ref, urlRepo, urlN, repo, n] of text.matchAll(ISSUE_REF)) {
      const slug = urlRepo ?? repo;
      if (slug !== undefined && slug.toLowerCase() !== repoSlug?.toLowerCase()) {
        throw new Error(
          `cross-repository dependency ${ref} is not supported${repoSlug === undefined ? " (pass the repository's owner/repo if it is this one)" : ""}`,
        );
      }
      const num = Number(urlN ?? n);
      if (!refs.includes(num)) refs.push(num);
      found++;
    }
    const rest = text
      .replace(ISSUE_REF, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\band\b|&/gi, " ");
    if (rest.replace(/[\s,;.*_`]+/g, "") === "" && found > 0) return;
    const leftover = rest.replace(/^[\s,;.*_`]+|[\s,;.*_`]+$/g, "").replace(/\s+/g, " ");
    throw new Error(
      `unparseable dependency line '${line.trim()}' on line ${lineNo}: ${found > 0 ? "after the references, " : ""}'${leftover}' remains (write it as 'Depends on: #N, #M' or 'Depends on: none')`,
    );
  };
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    /** The text of each clause on this line. */
    const clauses: string[] = [];
    const deps = DEPS_LINE.exec(raw);
    // A `Depends on` clause may follow a `deps:` clause on the same line: scan past its end.
    let from = 0;
    if (deps !== null) {
      const text = deps[1] ?? "";
      const end = clauseEnd(text);
      clauses.push(text.slice(0, end));
      from = raw.length - text.length + end;
    }
    DEPENDS_LABEL.lastIndex = from;
    for (let m = DEPENDS_LABEL.exec(raw); m !== null; m = DEPENDS_LABEL.exec(raw)) {
      const after = raw.slice(m.index + m[0].length);
      const end = clauseEnd(after);
      const text = after.slice(0, end);
      const colon = m[1] !== undefined;
      DEPENDS_LABEL.lastIndex = m.index + m[0].length + Math.max(end, 1);
      if (quoted(raw, m.index + m[0].search(/depends/i))) {
        DEPENDS_LABEL.lastIndex = m.index + m[0].length;
        continue;
      }
      // Without its colon the label is a clause only when a reference follows it.
      if (!colon && !new RegExp(ISSUE_REF.source, "i").test(text.replace(/\([^)]*\)/g, " ")))
        continue;
      clauses.push(text);
    }
    /** The line after this one's last list item (an empty label reads the items below it). */
    let next = i + 1;
    for (const clause of clauses) {
      declared = true;
      const text = clause.trim();
      const bare = text
        .replace(/\([^)]*\)/g, "")
        .replace(/[\s.,;:!*_`]+/g, "")
        .toLowerCase();
      if (NONE.has(bare)) continue;
      if (bare !== "") {
        read(text, raw, i + 1);
        continue;
      }
      // Empty label: the references are the list items that follow (blank lines allowed before).
      let j = next;
      while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
      let items = 0;
      for (; j < lines.length; j++) {
        const item = LIST_ITEM.exec(lines[j] ?? "");
        if (item === null) break;
        read(item[1] ?? "", lines[j] ?? "", j + 1);
        items++;
      }
      if (items === 0) {
        throw new Error(
          `empty dependency line '${raw.trim()}' (list the issues on it or as '- #N' items below it, or write 'none')`,
        );
      }
      next = j;
    }
    i = next - 1;
  }
  return { declared, refs };
}

/** An issue as a command line names it: `N`, `#N`, or an issue URL. */
const ISSUE_ARG = /^#?([1-9]\d*)$/;
const ISSUE_URL = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?$/i;

/**
 * The issue number `text` names: `602`, `#602`, or an issue URL of the repository `slug`
 * (`owner/repo`, compared case-insensitively). Another repository's URL, a URL when the
 * repository is unknown, and anything else are errors.
 */
export function parseIssueArg(text: string, slug?: string): number {
  const n = ISSUE_ARG.exec(text);
  if (n !== null) return Number(n[1]);
  const url = ISSUE_URL.exec(text);
  if (url === null) {
    throw new Error(`'${text}' is not an issue (give its number, #N, or its issue URL)`);
  }
  if (slug === undefined) {
    throw new Error(
      `cannot tell whether ${text} is in this wave's repository (its GitHub name is unknown): give the issue number`,
    );
  }
  if (url[1]?.toLowerCase() !== slug.toLowerCase()) {
    throw new Error(`${text} is an issue of ${url[1]}, not of this wave's repository ${slug}`);
  }
  return Number(url[2]);
}
