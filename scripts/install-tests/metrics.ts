/**
 * The install tests' results (scripts/install-tests/README.md): what one fresh install cost,
 * checked against the one-command install's targets and rendered for the job's step summary.
 *
 *   bun scripts/install-tests/metrics.ts summary --label <name> --metrics <setup-metrics.json>
 *       --check <check.json> [--yes] [--first-wave] [--total-ms <n>] [--allow-skipped <step>]...
 *       [--layer <n>] [--timing <name>=<ms>]... [--out <metrics.json>]
 *     The table on stdout (and appended to $GITHUB_STEP_SUMMARY); exit 1 when setup's wall time
 *     or the install's end to end is over 15 minutes, setup asked a question under --yes, a
 *     `volley setup --check --json` row is not done (or skipped, for a step --allow-skipped
 *     names), (--first-wave) the test wave did not merge, or a timing with a target
 *     (`TIMING_TARGETS`) is over it. --out writes the run's metrics as JSON.
 *
 *   bun scripts/install-tests/metrics.ts verdict status --boot <epoch s>     (stdin: `volley sub`)
 *   bun scripts/install-tests/metrics.ts verdict ready --name <machine>      (stdin: `volley sub`)
 *   bun scripts/install-tests/metrics.ts verdict wave --status <file> --events <file>
 *       --task <id> --host <machine>
 *   bun scripts/install-tests/metrics.ts verdict wave --status <file> --events <file> --ci none
 *     The VM layers' checks (Layers 2 and 4): exit 0 when volleyd's retained status is `working`
 *     and newer than the boot; when the machine's readiness verdict is ready; when the wave is
 *     complete, its task done and placed on that machine; (--ci none) when the wave on a
 *     repository with no CI is complete, its journal has `ci_mode_detected { mode: "none" }`, no
 *     `ci_pending` and no decision but the wave's own `wave_complete`. Otherwise exit 1, the reason
 *     on stderr.
 *
 *   bun scripts/install-tests/metrics.ts text <file>...
 *     Exit 1 when CLI output a person reads says `undefined`, `NaN`, `[object Object]` or
 *     `null on` (#597's class), each word found on stdout and its file and line on stderr. A file
 *     (or a line) that is JSON is a value, not text, and passes.
 *
 *   bun scripts/install-tests/metrics.ts table --run <run.json> --dir <artifacts>
 *     verify.sh's one table: a row per VM job of install-vm.yml (`gh run view --json jobs` in
 *     run.json), its result, its metrics (the job's artifact under <artifacts>: metrics.json) and
 *     its first failure (failures.md), as Markdown on stdout.
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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";

export const WALL_TARGET_MS = 15 * 60 * 1000;

/** The VM layers' timings that have a target: one over it fails the run. Others are reported. */
export const TIMING_TARGETS: Readonly<Record<string, number>> = {
  /** `volley setup --check` green again after a reboot (Layers 2 and 3). */
  reboot_check_ms: 2 * 60 * 1000,
  /** `volley machine add` to the peer's readiness verdict ready (Layer 4). */
  pair_ready_ms: 10 * 60 * 1000,
};

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
const target = (ms: number) => wall(ms).replace(/ 0 s$/, "");
const TARGET = target(WALL_TARGET_MS);
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
  /** The layer the run belongs to (the heading); 1 when absent. */
  layer?: number;
  /** The VM layers' timings, in milliseconds by name; `TIMING_TARGETS` holds their targets. */
  timings?: Readonly<Record<string, number>>;
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

  for (const [name, ms] of Object.entries(input.timings ?? {})) {
    const max = TIMING_TARGETS[name];
    const ok = max === undefined || ms <= max;
    if (!ok) failures.push(`${name} was ${wall(ms)}, over the ${target(max)} target`);
    row(`\`${name}\``, wall(ms), max === undefined ? "—" : `≤ ${target(max)}`, ok);
  }

  const steps = m.steps.map((s) => `| ${s.name} | ${(s.ms / 1000).toFixed(1)} s | ${s.changes} |`);
  const markdown = [
    `### Layer ${input.layer ?? 1}: ${input.label} ${mark(failures.length === 0)}`,
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
// The VM layers' verdicts: each null when the check holds, else why not.

/** The envelope of the last JSON line `volley sub` printed (`{ topic, envelope }`), or null. */
function lastEnvelope(text: string): Record<string, unknown> | null {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (const l of lines.reverse()) {
    try {
      const e = (JSON.parse(l) as { envelope?: unknown }).envelope;
      if (typeof e === "object" && e !== null) return e as Record<string, unknown>;
    } catch {}
  }
  return null;
}

/** volleyd's retained status, as `volley sub` printed it: `working`, and published after the boot. */
export function statusVerdict(sub: string, bootEpochS: number): string | null {
  const e = lastEnvelope(sub);
  if (e === null) return "no retained status from volleyd";
  if (e.type !== "working") return `volleyd's status is ${String(e.type)}, not working`;
  const at = Date.parse(String(e.wall_time));
  if (!Number.isFinite(at)) return "volleyd's status has no wall_time";
  if (at < bootEpochS * 1000) {
    return `volleyd's status (${String(e.wall_time)}) is older than the boot (${new Date(bootEpochS * 1000).toISOString()})`;
  }
  return null;
}

/** The supervisor's readiness verdict on `name` (`volley/_system/machines/<name>/readiness`). */
export function readyVerdict(sub: string, name: string): string | null {
  const e = lastEnvelope(sub);
  const p = (e?.payload ?? null) as { name?: unknown; ready?: unknown; reasons?: unknown } | null;
  if (p === null) return `no readiness verdict on ${name} yet`;
  if (p.name !== name) return `the readiness verdict is on ${String(p.name)}, not ${name}`;
  if (p.ready === true) return null;
  const reasons = Array.isArray(p.reasons) ? p.reasons.map(String).join("; ") : "";
  return `${name} is not ready${reasons ? ` (${reasons})` : ""}`;
}

/**
 * A wave that ran on a paired machine: `volleyd status <wave> --json` complete with `task` done,
 * and its journal (`volleyd events`, one event per line) placing that task on `host`.
 */
export function waveVerdict(input: {
  status: string;
  events: string;
  task: string;
  host: string;
}): string | null {
  let st: { status?: unknown; tasks?: { id?: unknown; stage?: unknown }[] };
  try {
    st = JSON.parse(input.status);
  } catch {
    return "volleyd status printed no JSON";
  }
  const t = (st.tasks ?? []).find((x) => x.id === input.task);
  if (t === undefined) return `the wave has no task ${input.task}`;
  if (st.status !== "complete" || t.stage !== "done") {
    return `the wave is ${String(st.status)}, ${input.task} is ${String(t.stage)}`;
  }
  const placed = journal(input.events).filter(
    (ev) => ev.type === "task_placed" && (ev.data?.task ?? ev.task) === input.task,
  );
  if (placed.length === 0) return `no task_placed for ${input.task}`;
  const host = placed.at(-1)?.data?.host;
  if (host !== input.host) return `${input.task} was placed on ${String(host)}, not ${input.host}`;
  return null;
}

/** `volleyd events` output (one journal event per line) as events; a line that is not JSON is skipped. */
function journal(
  text: string,
): { type?: unknown; task?: unknown; data?: Record<string, unknown> }[] {
  return text.split("\n").flatMap((l) => {
    try {
      const e = JSON.parse(l) as unknown;
      return typeof e === "object" && e !== null ? [e as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/**
 * A wave on a repository with no CI (#602): complete, its journal saying the mode is `none`, and
 * nothing waited on CI or asked the owner (`wave_complete`'s own decision aside).
 */
export function noCiVerdict(input: { status: string; events: string }): string | null {
  const events = journal(input.events);
  if (events.some((e) => e.type === "ci_pending"))
    return "the journal has ci_pending: the wave waited for CI on a repository with none";
  const asked = events.find(
    (e) => e.type === "decision_opened" && e.data?.kind !== "wave_complete",
  );
  if (asked !== undefined)
    return `the wave asked the owner (${String(asked.data?.kind)}) on a repository with no CI`;
  const modes = events.filter((e) => e.type === "ci_mode_detected").map((e) => e.data?.mode);
  if (!modes.includes("none"))
    return modes.length === 0
      ? 'no ci_mode_detected { mode: "none" } in the journal'
      : `ci_mode_detected says ${modes.map(String).join(", ")}, not none`;
  if (!events.some((e) => e.type === "wave_complete")) {
    let st: { status?: unknown };
    try {
      st = JSON.parse(input.status);
    } catch {
      return "volleyd status printed no JSON";
    }
    return `the wave is ${String(st.status)}, no wave_complete yet`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Text a person reads

/** What CLI output must never say (#597: `coordinator: undefined on undefined`). */
const BROKEN: [word: string, re: RegExp][] = [
  ["undefined", /\bundefined\b/],
  ["NaN", /\bNaN\b/],
  ["[object Object]", /\[object Object\]/],
  ["null on", /\bnull on\b/],
];

/**
 * Each line (1-based) of CLI output that says what a bug renders: the word and the line. A
 * text that is JSON as a whole, and any line that is, is a value and is not read.
 */
export function scanCli(text: string): { line: number; word: string; text: string }[] {
  try {
    JSON.parse(text);
    return [];
  } catch {}
  const hits: { line: number; word: string; text: string }[] = [];
  text.split("\n").forEach((l, i) => {
    try {
      JSON.parse(l);
      return;
    } catch {}
    const word = BROKEN.find(([, re]) => re.test(l))?.[0];
    if (word !== undefined) hits.push({ line: i + 1, word, text: l });
  });
  return hits;
}

// ---------------------------------------------------------------------------------------------
// verify.sh's table

/** install-vm.yml's VM jobs: the job's name, its artifact, the row's label. */
export const VM_JOBS: readonly { job: string; artifact: string; label: string }[] = [
  { job: "Layer 2 (ubuntu-24.04)", artifact: "layer2-ubuntu-24.04", label: "ubuntu-24.04" },
  { job: "Layer 2 (debian-13)", artifact: "layer2-debian-13", label: "debian-13" },
  { job: "Layer 4 (pair)", artifact: "layer4-pair", label: "pair" },
];

/** One job's artifact, as much of it as the job left. */
export interface LayerResult {
  metrics?: { total_ms?: number; timings?: Record<string, number>; setup?: { wall_ms?: number } };
  failures?: string;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/**
 * The table verify.sh prints: per VM job its result (`pass`, else the job's conclusion, or its
 * status while it has none), the metrics row (setup's wall time, the install end to end, each
 * timing) and its first `FAIL:` line.
 */
export function verifyTable(
  jobs: readonly { name?: unknown; status?: unknown; conclusion?: unknown }[],
  results: Readonly<Record<string, LayerResult>>,
): string {
  const rows = VM_JOBS.map(({ job, artifact, label }) => {
    const j = jobs.find((x) => x.name === job);
    const result =
      j === undefined
        ? "missing"
        : j.conclusion === "success"
          ? "pass"
          : String(j.conclusion || j.status || "unknown");
    const r = results[artifact] ?? {};
    const m = r.metrics;
    const parts = [
      ...(m?.setup?.wall_ms !== undefined ? [`setup ${wall(m.setup.wall_ms)}`] : []),
      ...(m?.total_ms !== undefined ? [`install ${wall(m.total_ms)}`] : []),
      ...Object.entries(m?.timings ?? {}).map(([k, ms]) => `${k} ${wall(ms)}`),
    ];
    const first = (r.failures ?? "")
      .split("\n")
      .map((l) => l.replace(/^- /, "").trim())
      .find((l) => l !== "");
    const why =
      first !== undefined
        ? `FAIL: ${first}`
        : result !== "pass" && r.metrics === undefined
          ? "no artifact: the job did not run its script"
          : "";
    return `| ${label} | ${result} | ${cell(parts.join(" · ") || "—")} | ${cell(why)} |`;
  });
  return [
    "| layer | result | metrics | first failure |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/** Each VM job's artifact under `dir` (`<dir>/<artifact>/metrics.json`, `failures.md`). */
export function readResults(dir: string): Record<string, LayerResult> {
  const out: Record<string, LayerResult> = {};
  for (const { artifact } of VM_JOBS) {
    const r: LayerResult = {};
    try {
      r.metrics = JSON.parse(readFileSync(join(dir, artifact, "metrics.json"), "utf8"));
    } catch {}
    try {
      r.failures = readFileSync(join(dir, artifact, "failures.md"), "utf8");
    } catch {}
    out[artifact] = r;
  }
  return out;
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
      layer: { type: "string" },
      timing: { type: "string", multiple: true },
      out: { type: "string" },
    });
    const { label, metrics, check } = values as Record<string, string | undefined>;
    if (label === undefined || metrics === undefined || check === undefined) {
      throw new UsageError("summary needs --label, --metrics and --check");
    }
    const total = values["total-ms"] as string | undefined;
    if (total !== undefined && !/^\d+$/.test(total))
      throw new UsageError("--total-ms takes milliseconds");
    const layer = values.layer as string | undefined;
    if (layer !== undefined && !/^[1-9]$/.test(layer)) throw new UsageError("--layer takes 1..9");
    const timings: Record<string, number> = {};
    for (const t of (values.timing as string[] | undefined) ?? []) {
      const m = /^([a-z][a-z0-9_]*)=(\d+)$/.exec(t);
      if (m?.[1] === undefined) throw new UsageError(`--timing takes <name>=<ms>, not "${t}"`);
      timings[m[1]] = Number(m[2]);
    }
    const setup = readJson(metrics) as SetupMetrics;
    const r = evaluate({
      label,
      metrics: setup,
      check: readJson(check) as CheckReport,
      yes: values.yes === true,
      firstWave: values["first-wave"] === true,
      allowSkipped: (values["allow-skipped"] as string[] | undefined) ?? [],
      ...(total !== undefined ? { totalMs: Number(total) } : {}),
      ...(layer !== undefined ? { layer: Number(layer) } : {}),
      timings,
    });
    process.stdout.write(`${r.markdown}\n`);
    const out = values.out as string | undefined;
    if (out !== undefined) {
      const run = {
        label,
        layer: Number(layer ?? 1),
        ...(total !== undefined ? { total_ms: Number(total) } : {}),
        timings,
        setup,
        failures: r.failures,
      };
      writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
    }
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `${r.markdown}\n`);
    for (const f of r.failures) process.stderr.write(`layer ${layer ?? 1} (${label}): ${f}\n`);
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
  if (verb === "verdict") return verdict(rest);
  if (verb === "table") {
    const { values } = args(rest, { run: { type: "string" }, dir: { type: "string" } });
    const { run, dir } = values as Record<string, string | undefined>;
    if (run === undefined || dir === undefined) throw new UsageError("table needs --run and --dir");
    const view = readJson(run) as {
      jobs?: { name?: unknown; status?: unknown; conclusion?: unknown }[];
    };
    process.stdout.write(`${verifyTable(view.jobs ?? [], readResults(dir))}\n`);
    return 0;
  }
  if (verb === "text") {
    const { positionals } = args(rest, {});
    if (positionals.length === 0) throw new UsageError("text needs a file");
    const words = new Set<string>();
    for (const f of positionals) {
      let content: string;
      try {
        content = readFileSync(f, "utf8");
      } catch (e) {
        throw new InputError(`cannot read ${f}: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const h of scanCli(content)) {
        words.add(h.word);
        process.stderr.write(`${f}:${h.line}: '${h.word}': ${h.text}\n`);
      }
    }
    for (const w of words) process.stdout.write(`${w}\n`);
    return words.size === 0 ? 0 : 1;
  }
  throw new UsageError(
    `unknown command: ${verb ?? "(none)"}; use summary, scan, redact, verdict, text or table`,
  );
}

function verdict(argv: string[]): number {
  const [kind, ...rest] = argv;
  const { values } = args(rest, {
    boot: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    events: { type: "string" },
    task: { type: "string" },
    host: { type: "string" },
    ci: { type: "string" },
  });
  const v = values as Record<string, string | undefined>;
  let why: string | null;
  if (kind === "status") {
    if (v.boot === undefined || !/^\d+$/.test(v.boot))
      throw new UsageError("verdict status needs --boot <epoch seconds>");
    why = statusVerdict(readFileSync(0, "utf8"), Number(v.boot));
  } else if (kind === "ready") {
    if (v.name === undefined) throw new UsageError("verdict ready needs --name");
    why = readyVerdict(readFileSync(0, "utf8"), v.name);
  } else if (kind === "wave" && v.ci !== undefined) {
    if (v.ci !== "none") throw new UsageError("verdict wave --ci takes none");
    if (v.status === undefined || v.events === undefined)
      throw new UsageError("verdict wave --ci none needs --status and --events");
    why = noCiVerdict({
      status: readFileSync(v.status, "utf8"),
      events: existsSync(v.events) ? readFileSync(v.events, "utf8") : "",
    });
  } else if (kind === "wave") {
    if (v.status === undefined || v.events === undefined || v.task === undefined || !v.host)
      throw new UsageError(
        "verdict wave needs --status, --events, --task and --host (or --ci none)",
      );
    why = waveVerdict({
      status: readFileSync(v.status, "utf8"),
      events: existsSync(v.events) ? readFileSync(v.events, "utf8") : "",
      task: v.task,
      host: v.host,
    });
  } else {
    throw new UsageError(`unknown verdict: ${kind ?? "(none)"}; use status, ready or wave`);
  }
  if (why === null) return 0;
  process.stderr.write(`${why}\n`);
  return 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`metrics.ts: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = e instanceof UsageError || e instanceof InputError ? 2 : 1;
  }
}
