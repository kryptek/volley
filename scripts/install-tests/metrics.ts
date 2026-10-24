/**
 * Layer 1's results (scripts/install-tests/README.md): what one fresh install cost, checked
 * against the one-command install's targets and rendered for the job's step summary.
 *
 *   bun scripts/install-tests/metrics.ts summary --label <name> --metrics <setup-metrics.json>
 *       --check <check.json> [--yes] [--first-wave] [--total-ms <n>] [--allow-skipped <step>]...
 *     The table on stdout (and appended to $GITHUB_STEP_SUMMARY); exit 1 when setup's wall time
 *     or the install's end to end is over 15 minutes, setup asked a question under --yes, a
 *     `volley setup --check --json` row is not done (or skipped, for a step --allow-skipped
 *     names), or (--first-wave) the test wave did not merge.
 *
 *   bun scripts/install-tests/metrics.ts scan [--secrets <credentials.json>]... <log>...
 *     Exit 1 when a log line holds token- or password-shaped text or one of the secrets in the
 *     credentials files; names the file and line, never the secret. A missing log is skipped.
 *
 *   bun scripts/install-tests/metrics.ts redact [--secrets <credentials.json>]...
 *     stdin to stdout with those secrets and token-shaped text replaced, for a transcript the job
 *     prints.
 *
 * Exit 2 on a usage error.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { type ParseArgsConfig, parseArgs } from "node:util";

export const WALL_TARGET_MS = 15 * 60 * 1000;

/** What `$VOLLEYD_HOME/setup-metrics.json` holds (packages/volley-cli/src/setup/metrics.ts). */
export interface SetupMetrics {
  wall_ms: number;
  questions: number;
  sign_ins: number;
  sudo_prompts: number;
  steps: { name: string; ms: number; changes: number }[];
  first_wave?: { wall_ms: number; pr: string | null; merged: boolean };
}

/** What `volley setup --check --json` prints (packages/volley-cli/src/setup/check.ts). */
export interface CheckReport {
  version: string;
  steps: {
    name: string;
    title: string;
    status: string;
    changes: string[];
    blocked?: string;
    skipped?: string;
  }[];
}

export interface Evaluation {
  failures: string[];
  markdown: string;
}

/** `<m> m <s> s`, as `volley setup` prints it. */
const wall = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} m ${s % 60} s`;
};
const TARGET = wall(WALL_TARGET_MS).replace(/ 0 s$/, "");
const mark = (ok: boolean) => (ok ? "✅" : "❌");

export function evaluate(input: {
  label: string;
  metrics: SetupMetrics;
  check: CheckReport;
  /** Setup ran under `--yes`: any question it asked is a failure. */
  yes: boolean;
  /** A test wave must have run and merged. */
  firstWave: boolean;
  /** The install end to end (install.sh through the last setup run), when the job timed it. */
  totalMs?: number;
  /** Steps whose row may be skipped on this platform (`--no-lan` on a Mac skips the phone). */
  allowSkipped?: readonly string[];
}): Evaluation {
  const { metrics: m, check } = input;
  const failures: string[] = [];
  const rows: string[] = [];
  const row = (what: string, value: string, target: string, ok: boolean) =>
    rows.push(`| ${what} | ${value} | ${target} | ${mark(ok)} |`);

  const wallOk = m.wall_ms <= WALL_TARGET_MS;
  if (!wallOk) failures.push(`setup took ${wall(m.wall_ms)}, over the ${TARGET} target`);
  row("Setup wall time", wall(m.wall_ms), `≤ ${TARGET}`, wallOk);

  if (input.totalMs !== undefined) {
    const ok = input.totalMs <= WALL_TARGET_MS;
    if (!ok) {
      failures.push(
        `the install took ${wall(input.totalMs)} end to end, over the ${TARGET} target`,
      );
    }
    row("Install, end to end", wall(input.totalMs), `≤ ${TARGET}`, ok);
  }

  if (input.yes) {
    const ok = m.questions === 0;
    if (!ok) {
      failures.push(
        `setup asked ${m.questions} question${m.questions === 1 ? "" : "s"} under --yes`,
      );
    }
    row("Questions (`--yes`)", String(m.questions), "0", ok);
  } else {
    row("Questions", String(m.questions), "—", true);
  }
  row("Sign-ins", String(m.sign_ins), "—", true);
  row("Sudo prompts", String(m.sudo_prompts), "—", true);

  const w = m.first_wave;
  if (input.firstWave || w !== undefined) {
    const ok = w?.merged === true;
    if (input.firstWave && w === undefined) failures.push("no test wave ran");
    else if (input.firstWave && !ok) failures.push("the test wave did not merge");
    row(
      "Test wave",
      w === undefined
        ? "did not run"
        : `${w.merged ? "merged" : "not merged"} in ${wall(w.wall_ms)}`,
      input.firstWave ? "merged" : "—",
      ok || !input.firstWave,
    );
  }

  const allowed = input.allowSkipped ?? [];
  const done = check.steps.filter((s) => s.status === "done").length;
  const skipped = check.steps.filter((s) => s.status === "skipped" && allowed.includes(s.name));
  let checkOk = true;
  for (const s of check.steps) {
    if (s.status === "done" || skipped.includes(s)) continue;
    checkOk = false;
    const why = s.blocked ?? s.skipped ?? s.changes.join("; ");
    failures.push(`\`volley setup --check\`: ${s.name} is ${s.status}${why ? ` (${why})` : ""}`);
  }
  row(
    "`--check`",
    `${done}/${check.steps.length} done${skipped.length > 0 ? `, ${skipped.length} skipped (allowed: ${skipped.map((s) => s.name).join(", ")})` : ""}`,
    "all done",
    checkOk,
  );

  const steps = m.steps.map((s) => `| ${s.name} | ${(s.ms / 1000).toFixed(1)} s | ${s.changes} |`);
  const markdown = [
    `### Layer 1: ${input.label} ${mark(failures.length === 0)}`,
    "",
    "| Metric | Value | Target | |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    ...(steps.length > 0 ? ["| Step | Time | Changes |", "| --- | --- | --- |", ...steps, ""] : []),
    ...(failures.length > 0 ? ["**Failed:**", "", ...failures.map((f) => `- ${f}`), ""] : []),
  ].join("\n");
  return { failures, markdown };
}

// ---------------------------------------------------------------------------------------------
// Secrets

/**
 * What a log must never hold: volley-cli's scrub patterns (peer/doctor.ts: Anthropic keys, GitHub
 * tokens) and a password field with a value. The bare 40-hex pattern is left out: a log is full of
 * commit SHAs. The broker passwords themselves come from the credentials files (`secretsFrom`).
 */
const TOKENS: [kind: string, re: RegExp][] = [
  ["an Anthropic key", /sk-ant-[A-Za-z0-9_-]+/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]+/],
  // A one-time admin token or sign-in link's (volley-cli's auth-accounts.ts).
  ["a Volley token", /\bvly_[a-z]+_[0-9a-f]{8}_[0-9a-f]{32}\b/],
];
const PATTERNS: [kind: string, re: RegExp][] = [
  ...TOKENS,
  ["a password field", /"password"\s*:\s*"[^"]+"|\bpassword=[^\s&"']+/i],
];
/**
 * A broker password's shape (24 random bytes, base64url): what `redact` also replaces, for one
 * shown once and kept nowhere (the Desk's). Too common a shape for `scan`.
 */
const PASSWORD_SHAPE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g;

/** A secret shorter than this is never matched literally (it would match ordinary text). */
const MIN_SECRET = 8;

/** Every `password` / `token` string in a credentials file's JSON, in order, deduplicated. */
export function secretsFrom(json: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === "string" && /password|token|secret/i.test(k) && x.length >= MIN_SECRET) {
          if (!out.includes(x)) out.push(x);
        } else walk(x);
      }
    }
  };
  walk(json);
  return out;
}

/** Each line (1-based) holding a secret, and what kind; never the secret itself. */
export function scanText(text: string, secrets: readonly string[]) {
  const hits: { line: number; kind: string }[] = [];
  text.split("\n").forEach((l, i) => {
    const kind = secrets.some((s) => l.includes(s))
      ? "a known secret"
      : PATTERNS.find(([, re]) => re.test(l))?.[0];
    if (kind !== undefined) hits.push({ line: i + 1, kind });
  });
  return hits;
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length))
    out = out.split(s).join("[redacted]");
  for (const [, re] of TOKENS) out = out.replace(new RegExp(re.source, "g"), "[redacted]");
  return out.replace(PASSWORD_SHAPE, "[redacted]");
}

// ---------------------------------------------------------------------------------------------
// The command

class UsageError extends Error {}
/** A --secrets file scan or redact cannot read: exit 2, never 1 (scan's "a log holds a secret"). */
class InputError extends Error {}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function args(argv: string[], options: NonNullable<ParseArgsConfig["options"]>) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

const secretsOf = (files: unknown) =>
  ((files as string[] | undefined) ?? []).flatMap((f) =>
    existsSync(f) ? secretsFrom(readSecrets(f)) : [],
  );

function readSecrets(path: string): unknown {
  try {
    return readJson(path);
  } catch (e) {
    throw new InputError(e instanceof Error ? e.message : String(e));
  }
}

function main(argv: string[]): number {
  const [verb, ...rest] = argv;
  if (verb === "summary") {
    const { values } = args(rest, {
      label: { type: "string" },
      metrics: { type: "string" },
      check: { type: "string" },
      yes: { type: "boolean" },
      "first-wave": { type: "boolean" },
      "allow-skipped": { type: "string", multiple: true },
      "total-ms": { type: "string" },
    });
    const { label, metrics, check } = values as Record<string, string | undefined>;
    if (label === undefined || metrics === undefined || check === undefined) {
      throw new UsageError("summary needs --label, --metrics and --check");
    }
    const total = values["total-ms"] as string | undefined;
    if (total !== undefined && !/^\d+$/.test(total))
      throw new UsageError("--total-ms takes milliseconds");
    const r = evaluate({
      label,
      metrics: readJson(metrics) as SetupMetrics,
      check: readJson(check) as CheckReport,
      yes: values.yes === true,
      firstWave: values["first-wave"] === true,
      allowSkipped: (values["allow-skipped"] as string[] | undefined) ?? [],
      ...(total !== undefined ? { totalMs: Number(total) } : {}),
    });
    process.stdout.write(`${r.markdown}\n`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `${r.markdown}\n`);
    for (const f of r.failures) process.stderr.write(`layer 1 (${label}): ${f}\n`);
    return r.failures.length === 0 ? 0 : 1;
  }
  if (verb === "scan") {
    const { values, positionals } = args(rest, { secrets: { type: "string", multiple: true } });
    const secrets = secretsOf(values.secrets);
    let scanned = 0;
    let found = 0;
    for (const log of positionals.filter((p) => existsSync(p))) {
      scanned++;
      for (const h of scanText(readFileSync(log, "utf8"), secrets)) {
        found++;
        process.stderr.write(`${log}:${h.line}: ${h.kind}\n`);
      }
    }
    if (found > 0) return 1;
    process.stdout.write(`no secrets in ${scanned} log${scanned === 1 ? "" : "s"}\n`);
    return 0;
  }
  if (verb === "redact") {
    const { values } = args(rest, { secrets: { type: "string", multiple: true } });
    process.stdout.write(redact(readFileSync(0, "utf8"), secretsOf(values.secrets)));
    return 0;
  }
  throw new UsageError(`unknown command: ${verb ?? "(none)"}; use summary, scan or redact`);
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`metrics.ts: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = e instanceof UsageError || e instanceof InputError ? 2 : 1;
  }
}
