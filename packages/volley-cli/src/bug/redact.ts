import { join } from "node:path";
import { scrub } from "../peer/doctor";

/**
 * `volley bug`'s redaction: a pure, ordered rule table applied to the whole rendered report as
 * the last step, so no section escapes it. Aggressive by default: tokens and secrets first, then
 * this machine's identity (e-mails, the user, home paths, hostnames, IPs, the GitHub login),
 * then repository names (`--keep-repos` keeps those). Every rule is idempotent and leaves its
 * placeholders (`[user]`, `[host]`, …) alone, so redacting a report twice changes nothing.
 */

/** What identifies this machine and its person: every value a report must not carry. */
export interface Identity {
  /** `$SUDO_USER`, `$USER`, the OS's: each redacted as a whole word. */
  users: string[];
  home: string | null;
  /** Hostnames (long and short), the private network's name and address, the paired name. */
  hosts: string[];
  ghLogin: string | null;
  /** The git identity's name(s). */
  gitNames: string[];
  /** Every repository slug (`owner/name`) known here. */
  repos: string[];
}

export interface IdentityDeps {
  env: Record<string, string | undefined>;
  home: string;
  volleydHome: string;
  hostname: () => string;
  username: () => string;
  readFile: (path: string) => string | null;
  ghLogin?: string | null;
  gitNames?: string[];
  repos?: string[];
  /** Other machines' names the gatherer found. */
  hosts?: string[];
}

const uniq = (xs: readonly (string | null | undefined)[]): string[] => [
  ...new Set(xs.filter((x): x is string => typeof x === "string" && x.trim() !== "")),
];

function json(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Slugs a value holds: a slug string, `{ slug }` / `{ repo }` objects, arrays of either. */
function slugsIn(v: unknown): string[] {
  if (typeof v === "string") return SLUG.test(v) ? [v] : [];
  if (Array.isArray(v)) return v.flatMap(slugsIn);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return [...slugsIn(o.slug), ...slugsIn(o.repo)];
  }
  return [];
}

/**
 * This machine's identity, from the environment, the OS and setup.json / peer.json (their
 * network record, machine name and repositories only); `ghLogin`, `gitNames` and `repos` come
 * from what the gatherer already resolved. A missing or damaged file adds nothing.
 */
export function identityOf(deps: IdentityDeps): Identity {
  let osUser: string | null = null;
  try {
    osUser = deps.username();
  } catch {}
  const host = deps.hostname();
  const short = host.split(".")[0] ?? host;
  const setup = json(deps.readFile(join(deps.volleydHome, "setup.json")));
  const network = (setup.network ?? {}) as Record<string, unknown>;
  const peer = json(deps.readFile(join(deps.home, ".volley", "peer.json")));
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    users: uniq([deps.env.SUDO_USER, deps.env.USER, osUser]),
    home: deps.home !== "" ? deps.home : null,
    hosts: uniq([
      host,
      short,
      str(network.name),
      str(network.name)?.replace(/\.$/, ""),
      str(network.address),
      str(peer.name),
      ...(deps.hosts ?? []),
    ]).filter((h) => h !== "localhost"),
    ghLogin: deps.ghLogin ?? null,
    gitNames: uniq(deps.gitNames ?? []),
    repos: uniq([...slugsIn(peer.repos), ...(deps.repos ?? [])]),
  };
}

export interface RedactOptions {
  keepRepos: boolean;
}

interface Rule {
  name: string;
  apply: (text: string, id: Identity, state: RepoNumbers) => string;
}

/** The repository numbers handed out so far, in first-seen order. */
type RepoNumbers = Map<string, string>;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A placeholder this module writes: `[user]`, `[repo-2]`, `[redacted]`… */
const PLACEHOLDER = /\[[a-z][a-z0-9-]*\]/g;

/** Apply `fn` to the text between placeholders only: no rule rewrites another's output. */
function outside(text: string, fn: (s: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** `value` as a whole word (not inside a longer name), case-insensitively. */
const word = (value: string) => new RegExp(`(?<![\\w.-])${esc(value)}(?![\\w-])`, "gi");

/**
 * An identity value as a word that a hyphen may join to others: `claude-login-<host>` and
 * `coord-<user>` carry it as much as a sentence does (`<user>s` does not).
 */
const ident = (value: string) => new RegExp(`(?<![\\w.])${esc(value)}(?!\\w)`, "gi");

const SECRET_KEY = "[A-Za-z_]*(?:password|passwd|secret|token|api_key|apikey)";

const TOKEN_RULES: [RegExp, string][] = [
  // A one-time token keeps its id: it is how the token is found in the journal.
  [/\bvly_([a-z]+)_([0-9A-Za-z]+)_[A-Za-z0-9_-]+/g, "vly_$1_$2_[redacted]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]"],
  [/\b(Authorization:\s*(?:Bearer|Basic|token)\s+)[^\s"']+/gi, "$1[redacted]"],
  [/\b(Bearer\s+)(?!\[)[^\s"']+/g, "$1[redacted]"],
  // A login in a URL (mqtt://, ws(s)://, https://…).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+(?::[^\s/@"']*)?@/gi, "$1[user]:[redacted]@"],
  // JSON fields: "password": "…".
  [new RegExp(`("${SECRET_KEY}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi"), '$1"[redacted]"'],
  // YAML fields: password: … (a value on the line).
  [
    new RegExp(`^(\\s*(?:-\\s+)?${SECRET_KEY}\\s*:[ \\t]+)(?![ \\t]*$)\\S.*$`, "gim"),
    '$1"[redacted]"',
  ],
  // key=value in URLs, queries, argv and env.
  [new RegExp(`\\b(${SECRET_KEY}|code|state|key)=[^\\s&"'#,;]+`, "gi"), "$1=[redacted]"],
  [/(--(?:password|token|secret))(\s+|=)(?!-)\S+/gi, "$1$2[redacted]"],
];

const LOOPBACK_V4 = (ip: string) => ip.startsWith("127.") || ip === "0.0.0.0";

function redactIps(s: string): string {
  const v4 = s.replace(/(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.]*\d)/g, (m) =>
    m.split(".").every((o) => Number(o) <= 255) && !LOOPBACK_V4(m) ? "[ip]" : m,
  );
  return v4.replace(/(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi, (m) => {
    const colons = m.split(":").length - 1;
    const isIp = (m.includes("::") || colons === 7) && /[0-9a-f]/i.test(m);
    return isIp && m !== "::1" ? "[ip]" : m;
  });
}

const RULES: Rule[] = [
  {
    name: "tokens",
    apply: (text) => {
      let t = scrub(text);
      for (const [re, to] of TOKEN_RULES) t = t.replace(re, to);
      return t;
    },
  },
  {
    name: "e-mails",
    apply: (text) =>
      outside(text, (s) =>
        s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"),
      ),
  },
  {
    name: "user",
    apply: (text, id) =>
      outside(text, (s) => {
        let t = s;
        if (id.home !== null && id.home !== "/") {
          t = t.replace(new RegExp(`${esc(id.home)}(?=/|\\b|$)`, "g"), "~");
        }
        t = t.replace(/\/(?:Users|home)\/(?!Shared\b|linuxbrew\b)[^/\s"':]+/g, "~");
        if (id.ghLogin !== null) t = t.replace(ident(id.ghLogin), "[gh-user]");
        for (const n of [...id.gitNames].sort((a, b) => b.length - a.length)) {
          t = t.replace(ident(n), "[user]");
        }
        for (const u of id.users) t = t.replace(ident(u), "[user]");
        return t;
      }),
  },
  {
    name: "host",
    apply: (text, id) =>
      outside(text, (s) => {
        let t = s.replace(/(?<![\w.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b\.?/gi, "[host]");
        // A computer named after its owner: `sams-macbook-pro`, `Dana's MacBook Air`.
        t = t.replace(
          /(?<![\w.])[A-Za-z0-9]+(?:'s|s)?[- ](?:macbook(?:[- ](?:pro|air))?|imac|mac[- ]mini|mac[- ]studio|mbp)(?![\w])/gi,
          "[host]",
        );
        // A known name cut short (the doctor caps a detail at 200 characters): `<prefix>…`.
        t = t.replace(/(?<![\w.])([\w.-]{6,})…/g, (m, cut: string) =>
          id.hosts.some((h) => h.toLowerCase().startsWith(cut.toLowerCase())) ? "[host]…" : m,
        );
        for (const h of [...id.hosts].sort((a, b) => b.length - a.length)) {
          t = t.replace(ident(h), "[host]");
        }
        return t;
      }),
  },
  { name: "ips", apply: (text) => outside(text, redactIps) },
  {
    name: "repos",
    apply: (text, id, numbers) => {
      const slugs = id.repos
        .map((slug) => ({ slug, at: text.search(word(slug)) }))
        .filter((x) => x.at >= 0)
        .sort((a, b) => a.at - b.at);
      for (const { slug } of slugs) {
        if (!numbers.has(slug)) numbers.set(slug, `[repo-${numbers.size + 1}]`);
      }
      return outside(text, (s) => {
        let t = s;
        for (const slug of [...id.repos].sort((a, b) => b.length - a.length)) {
          const n = numbers.get(slug);
          if (n === undefined) continue;
          t = t.replace(word(slug), n);
          // Its bare name as a path segment: the clone (`~/repos/<name>`).
          const name = slug.split("/")[1] as string;
          t = t.replace(new RegExp(`(?<=/)${esc(name)}(?![\\w.-])`, "g"), n);
        }
        // The bare owner: a private repository's owner is often a company's name.
        const owners = uniq(id.repos.map((s) => s.split("/")[0]));
        for (const o of owners) t = t.replace(word(o), "[repo-owner]");
        return t;
      });
    },
  },
];

/** The redaction list the report's footer names (`--keep-repos` drops `repos`). */
export const redactedList = (opts: RedactOptions) =>
  RULES.map((r) => r.name).filter((n) => !(opts.keepRepos && n === "repos"));

/** `text` with every rule applied, in order. */
export function redactReport(text: string, id: Identity, opts: RedactOptions): string {
  const numbers: RepoNumbers = new Map();
  return RULES.filter((r) => !(opts.keepRepos && r.name === "repos")).reduce(
    (t, r) => r.apply(t, id, numbers),
    text,
  );
}
