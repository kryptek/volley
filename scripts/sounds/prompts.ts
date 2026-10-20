/**
 * The pure half of the sound-theme pipeline: parse and check
 * `sounds/prompts.yaml`, compose a clip's prompt, and plan which
 * (theme, event, variant) clips a generation run still needs. No network, no
 * key; `generate.ts` does the I/O.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Severity = "failure" | "neutral" | "success" | "attention";

export interface ThemePrompt {
  id: string;
  label: string;
  brief: string;
  style_suffix: string;
}

export interface EventPrompt {
  id: string;
  severity: Severity;
  duration_s: number;
  base_prompt: string;
}

export interface Prompts {
  severity_suffix: Record<Severity, string>;
  themes: ThemePrompt[];
  events: EventPrompt[];
}

export const ROOT = join(import.meta.dir, "..", "..");
export const PROMPTS_FILE = join(ROOT, "sounds", "prompts.yaml");
export const REVIEW_DIR = join(ROOT, "sounds", "review");
export const PUBLIC_SOUNDS = join(ROOT, "packages", "volley-desk", "public", "sounds");

/** The API's shortest clip; the longest a Desk sound may be. */
export const MIN_DURATION_S = 0.5;
export const MAX_DURATION_S = 1.5;

const SEVERITIES: readonly Severity[] = ["failure", "neutral", "success", "attention"];

const str = (v: unknown, where: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${where}: expected a string`);
  return v;
};

/** Parses and checks the prompt file; throws with the offending path. */
export function parsePrompts(text: string): Prompts {
  const raw = Bun.YAML.parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") throw new Error("prompts: not a mapping");
  const sev = raw.severity_suffix as Record<string, unknown> | undefined;
  const severity_suffix = Object.fromEntries(
    SEVERITIES.map((s) => [s, str(sev?.[s], `severity_suffix.${s}`)]),
  ) as Record<Severity, string>;
  if (!Array.isArray(raw.themes)) throw new Error("themes: expected a list");
  if (!Array.isArray(raw.events)) throw new Error("events: expected a list");
  const themes = raw.themes.map((t: Record<string, unknown>, i: number) => ({
    id: str(t?.id, `themes[${i}].id`),
    label: str(t?.label, `themes[${i}].label`),
    brief: str(t?.brief, `themes[${i}].brief`),
    style_suffix: str(t?.style_suffix, `themes[${i}].style_suffix`),
  }));
  const events = raw.events.map((e: Record<string, unknown>, i: number) => {
    const severity = e?.severity as Severity;
    if (!SEVERITIES.includes(severity)) throw new Error(`events[${i}].severity: unknown`);
    const d = e?.duration_s;
    if (typeof d !== "number" || d < MIN_DURATION_S || d > MAX_DURATION_S)
      throw new Error(`events[${i}].duration_s: ${MIN_DURATION_S}–${MAX_DURATION_S} s`);
    return {
      id: str(e?.id, `events[${i}].id`),
      severity,
      duration_s: d,
      base_prompt: str(e?.base_prompt, `events[${i}].base_prompt`),
    };
  });
  return { severity_suffix, themes, events };
}

export function loadPrompts(file = PROMPTS_FILE): Prompts {
  return parsePrompts(readFileSync(file, "utf8"));
}

export function composePrompt(p: Prompts, theme: ThemePrompt, event: EventPrompt): string {
  return `${event.base_prompt}, ${theme.style_suffix}, ${p.severity_suffix[event.severity]}`;
}

export interface Job {
  theme: string;
  event: string;
  variant: number;
  text: string;
  duration_s: number;
  /** Where the clip goes, without its extension. */
  base: string;
}

export interface PlanOptions {
  themes?: readonly string[];
  events?: readonly string[];
  variants: number;
  reviewDir: string;
  /** The extensions a generated clip may have; one present means that clip is done. */
  exts?: readonly string[];
}

/** Review files for a clip, `<dir>/<theme>/<event>.<n>`. */
export const reviewBase = (dir: string, theme: string, event: string, n: number) =>
  join(dir, theme, `${event}.${n}`);

/** Every (theme, event, variant) clip not yet in the review folder, narrowed by theme / event. */
export function plan(p: Prompts, o: PlanOptions): Job[] {
  const exts = o.exts ?? ["wav", "mp3"];
  for (const t of o.themes ?? [])
    if (!p.themes.some((x) => x.id === t)) throw new Error(`unknown theme: ${t}`);
  for (const e of o.events ?? [])
    if (!p.events.some((x) => x.id === e)) throw new Error(`unknown event: ${e}`);
  const jobs: Job[] = [];
  for (const theme of p.themes) {
    if (o.themes?.length && !o.themes.includes(theme.id)) continue;
    for (const event of p.events) {
      if (o.events?.length && !o.events.includes(event.id)) continue;
      for (let n = 1; n <= o.variants; n++) {
        const base = reviewBase(o.reviewDir, theme.id, event.id, n);
        if (exts.some((x) => existsSync(`${base}.${x}`))) continue;
        jobs.push({
          theme: theme.id,
          event: event.id,
          variant: n,
          text: composePrompt(p, theme, event),
          duration_s: event.duration_s,
          base,
        });
      }
    }
  }
  return jobs;
}

/** The plan's size: requests and billed seconds. */
export function planSize(jobs: readonly Job[]): { generations: number; seconds: number } {
  const seconds = jobs.reduce((s, j) => s + j.duration_s, 0);
  return { generations: jobs.length, seconds: Math.round(seconds * 10) / 10 };
}
