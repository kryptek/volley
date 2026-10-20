import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOUND_EVENTS, SOUND_EVENT_IDS } from "volley-desk/sounds-events";
import { THEMES } from "volley-desk/sounds-themes";
import { ENDPOINT, type Io, run, wav } from "./generate";
import { composePrompt, loadPrompts, parsePrompts, plan, planSize } from "./prompts";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "volley-sounds-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const prompts = loadPrompts();

describe("prompts.yaml", () => {
  test("has a prompt for exactly the catalogue's events, with matching severities", () => {
    expect(prompts.events.map((e) => e.id).sort()).toEqual([...SOUND_EVENT_IDS].sort());
    for (const e of prompts.events)
      expect(e.severity).toBe(SOUND_EVENTS[e.id as keyof typeof SOUND_EVENTS].severity);
  });

  test("has exactly the Desk's themes, with the same labels and briefs", () => {
    expect(prompts.themes.map((t) => [t.id, t.label, t.brief])).toEqual(
      THEMES.map((t) => [t.id, t.label, t.brief]),
    );
  });

  test("every duration is 0.5–1.5 s and every base prompt under ~20 words", () => {
    for (const e of prompts.events) {
      expect(e.duration_s).toBeGreaterThanOrEqual(0.5);
      expect(e.duration_s).toBeLessThanOrEqual(1.5);
      expect(e.base_prompt.split(/\s+/).length).toBeLessThanOrEqual(20);
    }
  });

  test("rejects a duration out of range or an unknown severity, naming the path", () => {
    const bad = (events: string) =>
      `severity_suffix: { failure: a, neutral: b, success: c, attention: d }\nthemes: []\nevents: ${events}`;
    expect(() =>
      parsePrompts(bad("[{ id: x, severity: neutral, duration_s: 0.3, base_prompt: p }]")),
    ).toThrow("events[0].duration_s");
    expect(() =>
      parsePrompts(bad("[{ id: x, severity: loud, duration_s: 1, base_prompt: p }]")),
    ).toThrow("events[0].severity");
  });

  test("a prompt is base_prompt, style_suffix, severity_suffix", () => {
    const theme = prompts.themes[0];
    const event = prompts.events.find((e) => e.id === "agent_complete");
    if (!theme || !event) throw new Error("fixture");
    expect(composePrompt(prompts, theme, event)).toBe(
      `${event.base_prompt}, ${theme.style_suffix}, ${prompts.severity_suffix.success}`,
    );
  });
});

describe("plan", () => {
  test("a full run is every theme × event × 3 variants", () => {
    const jobs = plan(prompts, { variants: 3, reviewDir: temp() });
    expect(jobs).toHaveLength(THEMES.length * SOUND_EVENT_IDS.length * 3);
    expect(planSize(jobs).generations).toBe(1008);
  });

  test("skips clips already in the review folder and narrows by theme and event", () => {
    const dir = temp();
    mkdirSync(join(dir, "arcade"), { recursive: true });
    writeFileSync(join(dir, "arcade", "ui_click.2.wav"), "x");
    const jobs = plan(prompts, {
      themes: ["arcade"],
      events: ["ui_click"],
      variants: 3,
      reviewDir: dir,
    });
    expect(jobs.map((j) => j.variant)).toEqual([1, 3]);
    expect(() => plan(prompts, { themes: ["nope"], variants: 1, reviewDir: dir })).toThrow(
      "unknown theme",
    );
  });
});

const KEY = "sk_test_never_printed_0123456789";

function harness(responses: (url: string, body: Record<string, unknown>) => Response) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const io: Io = {
    env: { ELEVENLABS_API_KEY: KEY },
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body, headers: new Headers(init.headers) });
      return responses(url, body);
    }) as unknown as typeof fetch,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    sleep: async () => {},
  };
  return { io, out, err, calls };
}

const ok = () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });

describe("generate (fetch mocked)", () => {
  test("--dry-run prints the generation count and seconds and makes no request", async () => {
    const h = harness(ok);
    const code = await run(["--dry-run"], h.io, { reviewDir: temp() });
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.out[0]).toBe("generations: 1008");
    expect(h.out[1]).toMatch(/^seconds: \d+(\.\d)?$/);
  });

  test("without ELEVENLABS_API_KEY it exits 2 with a one-line hint and no request", async () => {
    const h = harness(ok);
    h.io.env = {};
    const code = await run(["--theme", "arcade", "--event", "ui_click"], h.io, {
      reviewDir: temp(),
    });
    expect(code).toBe(2);
    expect(h.calls).toHaveLength(0);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain("ELEVENLABS_API_KEY");
  });

  test("each request carries text, duration, prompt influence and the output format", async () => {
    const h = harness(ok);
    const dir = temp();
    const code = await run(["--theme", "glass", "--event", "ui_drop", "--variants", "1"], h.io, {
      reviewDir: dir,
    });
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    const [c] = h.calls;
    expect(c?.url).toBe(`${ENDPOINT}?output_format=pcm_44100`);
    expect(c?.headers.get("xi-api-key")).toBe(KEY);
    expect(c?.body).toEqual({
      text: expect.stringContaining("setting an object down"),
      duration_seconds: 0.5,
      prompt_influence: 0.6,
    });
    // PCM is wrapped as a WAV file.
    const file = readFileSync(join(dir, "glass", "ui_drop.1.wav"));
    expect(file.subarray(0, 4).toString()).toBe("RIFF");
    expect(file.length).toBe(44 + 4);
  });

  test("falls back to MP3 when the plan refuses PCM", async () => {
    const h = harness((url) =>
      url.includes("pcm_") ? new Response("tier", { status: 403 }) : ok(),
    );
    const dir = temp();
    const code = await run(
      ["--theme", "glass", "--event", "ui_drop", "--variants", "2", "--concurrency", "1"],
      h.io,
      { reviewDir: dir },
    );
    expect(code).toBe(0);
    expect(existsSync(join(dir, "glass", "ui_drop.1.mp3"))).toBe(true);
    expect(existsSync(join(dir, "glass", "ui_drop.2.mp3"))).toBe(true);
  });

  test("retries a 429 with backoff, up to three tries", async () => {
    let n = 0;
    const h = harness(() => (++n < 3 ? new Response("", { status: 429 }) : ok()));
    const code = await run(["--theme", "glass", "--event", "ui_drop", "--variants", "1"], h.io, {
      reviewDir: temp(),
    });
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(3);

    let m = 0;
    const g = harness(() => {
      m++;
      return new Response("", { status: 503 });
    });
    const failed = await run(["--theme", "glass", "--event", "ui_drop", "--variants", "1"], g.io, {
      reviewDir: temp(),
    });
    expect(failed).toBe(1);
    expect(m).toBe(3);
  });

  test("a 401 aborts the run", async () => {
    const h = harness(() => new Response("", { status: 401 }));
    const code = await run(["--theme", "glass", "--variants", "1", "--concurrency", "1"], h.io, {
      reviewDir: temp(),
    });
    expect(code).toBe(1);
    expect(h.calls).toHaveLength(1);
  });

  test("refuses a run over --budget", async () => {
    const h = harness(ok);
    const code = await run(["--budget", "100", "--rate", "20"], h.io, { reviewDir: temp() });
    expect(code).toBe(3);
    expect(h.calls).toHaveLength(0);
  });

  test("the key never reaches the log, stdout or stderr", async () => {
    const h = harness((_, body) =>
      body.duration_seconds === 0.5 ? ok() : new Response("", { status: 500 }),
    );
    const dir = temp();
    await run(["--theme", "minimal", "--event", "ui_click,wave_start", "--variants", "1"], h.io, {
      reviewDir: dir,
    });
    const log = readFileSync(join(dir, "_log.jsonl"), "utf8");
    expect(log.trim().split("\n").length).toBeGreaterThanOrEqual(2);
    expect(log).not.toContain(KEY);
    expect(log).not.toContain("xi-api-key");
    expect([...h.out, ...h.err].join("\n")).not.toContain(KEY);
  });

  test("the source reads the key only from the environment and never logs headers", () => {
    const src = readFileSync(join(import.meta.dir, "generate.ts"), "utf8");
    expect(src.match(/ELEVENLABS_API_KEY/g)?.length).toBeGreaterThan(0);
    expect(src).toContain("io.env.ELEVENLABS_API_KEY");
    expect(src).not.toMatch(/console\.\w+\([^)]*headers/);
    expect(src).not.toMatch(/--key|--api-key/);
  });
});

describe("wav", () => {
  test("wraps 16-bit stereo PCM in a 44-byte header", () => {
    const w = wav(new Uint8Array(10));
    const v = new DataView(w.buffer);
    expect(w.length).toBe(54);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(44100 * 4);
    expect(v.getUint32(40, true)).toBe(10);
  });
});
