import { spawn } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import pkg from "../../package.json";
import { volleydHome } from "../auth/context";
import { BUG_DEFAULTS, type BugDeps, type BugExec, gatherReport } from "../bug/gather";
import { identityOf, redactReport } from "../bug/redact";
import { BUG_REPO, newIssueUrl, renderReport, titleOf, trimToLimit } from "../bug/report";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { openUrl } from "../open-url";

/**
 * `volley bug`: gather the diagnostics, redact them, show the exact text, and only on a yes open
 * a GitHub issue (through `gh` when it is signed in, else the bug form in a browser with the
 * report saved beside the person). No `--yes`: a person reads the text before it leaves. Changes
 * nothing on the machine; never needs the daemon, the broker or sudo.
 */

const HELP = `Usage: volley bug [options]

Gathers this machine's diagnostics (version, install method, setup --check, peer doctor, volleyd
status, the wave's last journal events, the service logs), redacts them (tokens, credentials,
e-mails, your user, hostnames, IPs, repository names), prints the exact text, then asks before
opening a GitHub issue on ${BUG_REPO}. Answering no, or a non-interactive run, writes the report
to ./volley-bug-<stamp>.md instead.

Options:
  -m, --message <text>  What happened (without it, a terminal asks one line)
  --wave <name>         The wave to report on (default: the one whose journal is newest)
  --events <n>          Journal events to include (default ${BUG_DEFAULTS.events})
  --lines <n>           Lines of each log to include (default ${BUG_DEFAULTS.lines})
  --file [path]         Write the report (default ./volley-bug-<stamp>.md) and stop: no question
  --keep-repos          Keep repository names (redacted by default)
  -h, --help            Show this help
`;

const OPTIONS = {
  message: { type: "string", short: "m" },
  wave: { type: "string" },
  events: { type: "string" },
  lines: { type: "string" },
  file: { type: "string" },
  "keep-repos": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export interface BugCommandDeps extends BugDeps {
  /** One line from the person; null when nobody can answer. */
  ask: (prompt: string) => Promise<string | null>;
  open: (url: string) => Promise<boolean>;
  /** Where `volley-bug-<stamp>.md` lands. */
  cwd: string;
}

export interface BugArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export function bug(args: BugArgs): Promise<ExitCode> {
  return runBug(args, realBugDeps(args.env));
}

const DEFAULT_FILE = Symbol("default file");

/** `YYYYMMDD-HHMMSS` (UTC). */
const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/-|:/g, "")
    .replace("T", "-");

const count = (flag: string, v: string | undefined, dflt: number): number | string => {
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 10_000
    ? n
    : `--${flag} must be a whole number in 0..10000`;
};

export async function runBug({ argv, io }: BugArgs, deps: BugCommandDeps): Promise<ExitCode> {
  // `--file` takes an optional path: alone (or before another option) it means the default name.
  const args = argv.flatMap((a, i) =>
    a === "--file" && (argv[i + 1] === undefined || argv[i + 1]?.startsWith("-") === true)
      ? ["--file", ""]
      : [a],
  );
  let v: { [K in keyof typeof OPTIONS]?: string | boolean };
  try {
    v = parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    io.stderr(`volley bug: ${e instanceof Error ? e.message : String(e)}\n\n${HELP}`);
    return EXIT.USAGE;
  }
  if (v.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const events = count("events", v.events as string | undefined, BUG_DEFAULTS.events);
  const lines = count("lines", v.lines as string | undefined, BUG_DEFAULTS.lines);
  for (const n of [events, lines]) {
    if (typeof n === "string") {
      io.stderr(`volley bug: ${n}\n`);
      return EXIT.USAGE;
    }
  }
  const keepRepos = v["keep-repos"] === true;
  const file: string | typeof DEFAULT_FILE | undefined =
    v.file === undefined ? undefined : v.file === "" ? DEFAULT_FILE : (v.file as string);
  const interactive = deps.isTTY && file === undefined;

  let message = typeof v.message === "string" ? v.message : "";
  if (message === "" && interactive) {
    message = (await deps.ask("What happened? (one line; Enter to leave it for the issue) ")) ?? "";
  }

  io.stderr("volley bug: gathering the diagnostics (each probe at most 20 s)…\n");
  const g = await gatherReport(deps, {
    ...(typeof v.wave === "string" ? { wave: v.wave } : {}),
    events: events as number,
    lines: lines as number,
  });
  const id = identityOf({ ...deps, volleydHome: volleydHome(deps.env, deps.home), ...g.identity });
  const redact = (s: string) => redactReport(s, id, { keepRepos });
  // The title and the browser page's fields are redacted in the report's own pass, so a
  // `[repo-1]` names the same repository everywhere.
  const SEP = "\n\u0000\n";
  const extras = [
    titleOf({ message, firstFailure: g.firstFailure, version: g.version }),
    message,
    g.header,
    ...g.failures,
  ];
  let redactedExtras = extras;
  const report = trimToLimit(
    g,
    (x) => {
      const parts = redact([...extras, renderReport(x, { message, keepRepos })].join(SEP)).split(
        SEP,
      );
      redactedExtras = parts.slice(0, extras.length);
      return parts.slice(extras.length).join(SEP);
    },
    BUG_DEFAULTS.body_max,
  );
  const [title = "", redactedMessage = "", header = "", ...failures] = redactedExtras;
  io.stdout(report.endsWith("\n") ? report : `${report}\n`);

  const defaultPath = join(deps.cwd, `volley-bug-${stamp(deps.now())}.md`);
  const save = (path: string): boolean => {
    try {
      writeFileSync(path, report);
      return true;
    } catch (e) {
      io.stderr(
        `volley bug: cannot write ${path}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return false;
    }
  };
  const saved = (path: string): ExitCode => {
    if (!save(path)) return EXIT.ERROR;
    io.stdout(
      `\nThe report is in ${path}: read it, then paste it into a new issue at https://github.com/${BUG_REPO}/issues/new?template=bug.yml\n`,
    );
    return EXIT.OK;
  };

  if (file !== undefined)
    return saved(file === DEFAULT_FILE ? defaultPath : resolve(deps.cwd, file));
  if (!interactive) return saved(defaultPath);

  io.stdout(
    g.ghSignedIn
      ? `\ngh is signed in as ${g.identity.ghLogin ?? "your account"}: a yes opens the issue with it.\n`
      : "\ngh is not signed in: a yes opens a browser page and the report is saved beside you.\n",
  );
  const answer = (await deps.ask("Open a GitHub issue with exactly this text? [y/N] ")) ?? "";
  if (!/^y(es)?$/i.test(answer.trim())) return saved(defaultPath);

  if (g.ghSignedIn) {
    const dir = mkdtempSync(join(tmpdir(), "volley-bug-"));
    try {
      const body = join(dir, "report.md");
      writeFileSync(body, report);
      const r = await deps.exec(
        [
          "gh",
          "issue",
          "create",
          "--repo",
          BUG_REPO,
          "--label",
          "bug",
          "--title",
          title,
          "--body-file",
          body,
        ],
        { timeoutMs: 60_000 },
      );
      if (r.code === 0) {
        io.stdout(`${r.stdout.trim()}\n`);
        return EXIT.OK;
      }
      io.stderr(
        `volley bug: \`gh issue create\` failed (exit ${r.code}): ${redact((r.stderr || r.stdout).trim())}\n`,
      );
      saved(defaultPath);
      return EXIT.ERROR;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!save(defaultPath)) return EXIT.ERROR;
  const url = newIssueUrl({
    title,
    message: redactedMessage,
    header,
    failures,
    file: defaultPath.split("/").pop() as string,
  });
  const opened = await deps.open(url);
  io.stdout(
    `\nThe report is in ${defaultPath}. ${opened ? "A browser page opened on the bug form" : "Open this page"}: paste the file's contents into its Report box.\n${opened ? "" : `${url}\n`}`,
  );
  return EXIT.OK;
}

// ---------------------------------------------------------------------------------------------
// The real machine
// ---------------------------------------------------------------------------------------------

const READ_MAX = 4 * 1024 * 1024;

/** At most the last 4 MB of `path` (a log can be large): the tail is what a report wants. */
function readTail(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const n = Math.min(size, READ_MAX);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const realExec: BugExec = (argv, opts = {}) =>
  new Promise((done) => {
    const [cmd, ...rest] = argv;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd as string, rest, { stdio: ["ignore", "pipe", "pipe"] });
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : null;
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.once("error", (e) => {
      if (timer !== null) clearTimeout(timer);
      done({ code: 127, stdout, stderr: e.message });
    });
    child.once("close", (code) => {
      if (timer !== null) clearTimeout(timer);
      done({ code: code ?? 1, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
    });
  });

export function realBugDeps(env: Record<string, string | undefined>): BugCommandDeps {
  const cliDir = dirname(new URL(import.meta.url).pathname).replace(/\/commands$/, "");
  const checkout = resolve(cliDir, "..", "..", "..");
  const bun = process.execPath;
  return {
    exec: realExec,
    home: env.HOME ?? userInfo().homedir,
    env,
    platform: process.platform,
    arch: arch(),
    now: () => new Date(),
    readFile: readTail,
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return null;
      }
    },
    mtimeMs: (path) => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return null;
      }
    },
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    hostname: () => hostname(),
    username: () => userInfo().username,
    cliDir,
    version: pkg.version,
    volley: [bun, join(cliDir, "cli.ts")],
    volleyd: [bun, join(checkout, "packages", "volleyd", "src", "cli.ts")],
    cwd: process.cwd(),
    ask: async (prompt) => {
      if (process.stdin.isTTY !== true) return null;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(prompt)).trim();
      } finally {
        rl.close();
      }
    },
    open: openUrl,
  };
}
