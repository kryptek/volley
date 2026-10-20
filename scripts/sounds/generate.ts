/**
 * Generates the Desk's sound-theme clips with the ElevenLabs Sound Effects API
 * into the untracked review folder, `sounds/review/<theme>/<event>.<n>.<ext>`,
 * for `pick.ts` to promote. Only clips not generated yet are requested
 * (`--theme` / `--event` narrow the run; delete a review file to re-roll it).
 *
 *   ELEVENLABS_API_KEY=… bun scripts/sounds/generate.ts [--theme t]… [--event e]…
 *     [--variants 3] [--dry-run] [--format auto|pcm|mp3] [--concurrency 3]
 *     [--budget <credits> --rate <credits per second>]
 *
 * The key is read from the environment only, never from a flag, and is never
 * printed or logged. `sounds/review/_log.jsonl` gets one line per request:
 * the prompt, the duration, the status and the byte count.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Job, type Prompts, REVIEW_DIR, loadPrompts, plan, planSize } from "./prompts";

export const ENDPOINT = "https://api.elevenlabs.io/v1/sound-generation";
export const PROMPT_INFLUENCE = 0.6;
const PCM = "pcm_44100";
const MP3 = "mp3_44100_128";
const TRIES = 3;

export interface Io {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Backoff wait; tests pass a no-op. */
  sleep: (ms: number) => Promise<void>;
}

export interface Args {
  themes: string[];
  events: string[];
  variants: number;
  dryRun: boolean;
  format: "auto" | "pcm" | "mp3";
  concurrency: number;
  budget?: number;
  rate?: number;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    themes: [],
    events: [],
    variants: 3,
    dryRun: false,
    format: "auto",
    concurrency: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    const num = () => {
      const n = Number(val());
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
      return n;
    };
    if (flag === "--theme") a.themes.push(...val().split(","));
    else if (flag === "--event") a.events.push(...val().split(","));
    else if (flag === "--variants") a.variants = Math.floor(num());
    else if (flag === "--concurrency") a.concurrency = Math.floor(num());
    else if (flag === "--budget") a.budget = num();
    else if (flag === "--rate") a.rate = num();
    else if (flag === "--dry-run") a.dryRun = true;
    else if (flag === "--format") {
      const f = val();
      if (f !== "auto" && f !== "pcm" && f !== "mp3") throw new Error("--format: auto, pcm or mp3");
      a.format = f;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return a;
}

/** A RIFF/WAVE header around raw 16-bit little-endian PCM (the API's `pcm_44100` is stereo). */
export function wav(pcm: Uint8Array, rate = 44100, channels = 2): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

class Abort extends Error {}

interface RunState {
  format: string;
  /** `auto`: PCM until the plan refuses it, then MP3. */
  auto: boolean;
  failed: number;
  done: number;
}

async function generateOne(job: Job, key: string, s: RunState, io: Io, log: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const format = s.format;
    const res = await io.fetch(`${ENDPOINT}?output_format=${format}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text: job.text,
        duration_seconds: job.duration_s,
        prompt_influence: PROMPT_INFLUENCE,
      }),
    });
    const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    appendFileSync(
      log,
      `${JSON.stringify({
        at: new Date().toISOString(),
        theme: job.theme,
        event: job.event,
        variant: job.variant,
        prompt: job.text,
        duration_s: job.duration_s,
        format,
        status: res.status,
        bytes: bytes?.length ?? 0,
      })}\n`,
    );
    if (bytes) {
      const pcm = format.startsWith("pcm_");
      const file = `${job.base}.${pcm ? "wav" : "mp3"}`;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, pcm ? wav(bytes) : bytes);
      s.done++;
      return;
    }
    if (res.status === 401) throw new Abort("401 from ElevenLabs: the API key was refused");
    // The plan does not offer PCM: carry on in MP3.
    if (s.auto && format === PCM && (res.status === 400 || res.status === 403)) {
      s.format = MP3;
      s.auto = false;
      io.err(`PCM output refused (${res.status}); falling back to ${MP3}`);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < TRIES) {
      await io.sleep(1000 * 2 ** attempt);
      continue;
    }
    s.failed++;
    io.err(`${job.theme}/${job.event}.${job.variant}: HTTP ${res.status}`);
    return;
  }
}

export async function run(
  argv: readonly string[],
  io: Io,
  opts: { prompts?: Prompts; reviewDir?: string } = {},
): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  const reviewDir = opts.reviewDir ?? REVIEW_DIR;
  const prompts = opts.prompts ?? loadPrompts();
  let jobs: Job[];
  try {
    jobs = plan(prompts, {
      themes: args.themes,
      events: args.events,
      variants: args.variants,
      reviewDir,
    });
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  const size = planSize(jobs);
  io.out(`generations: ${size.generations}`);
  io.out(`seconds: ${size.seconds}`);
  if (args.rate !== undefined)
    io.out(`credits (estimated): ${Math.ceil(size.seconds * args.rate)}`);
  if (args.dryRun) return 0;
  if (args.budget !== undefined) {
    if (args.rate === undefined) {
      io.err("--budget needs --rate (credits per second)");
      return 2;
    }
    if (size.seconds * args.rate > args.budget) {
      io.err(`over budget: ~${Math.ceil(size.seconds * args.rate)} credits > ${args.budget}`);
      return 3;
    }
  }
  const key = io.env.ELEVENLABS_API_KEY;
  if (!key) {
    io.err("ELEVENLABS_API_KEY is not set: export it for this command only (see sounds/README.md)");
    return 2;
  }
  mkdirSync(reviewDir, { recursive: true });
  const log = join(reviewDir, "_log.jsonl");
  const s: RunState = {
    format: args.format === "mp3" ? MP3 : PCM,
    auto: args.format === "auto",
    failed: 0,
    done: 0,
  };
  const queue = [...jobs];
  let aborted: Error | null = null;
  const worker = async () => {
    for (let job = queue.shift(); job && !aborted; job = queue.shift()) {
      try {
        await generateOne(job, key, s, io, log);
      } catch (e) {
        if (e instanceof Abort) aborted = e;
        else {
          s.failed++;
          io.err(`${job.theme}/${job.event}.${job.variant}: ${(e as Error).message}`);
        }
      }
      if ((s.done + s.failed) % 25 === 0) io.out(`… ${s.done + s.failed}/${jobs.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  if (aborted) {
    io.err((aborted as Error).message);
    return 1;
  }
  io.out(`generated: ${s.done}, failed: ${s.failed}`);
  return s.failed > 0 ? 1 : 0;
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2), {
    env: process.env,
    fetch,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  process.exit(code);
}
