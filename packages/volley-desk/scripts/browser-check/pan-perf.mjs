// Pan performance on a phone, and the desktop glass left alone (#295).
//  - phone: an emulated iPhone (390 × 844, DPR 3, touch) at 4× CPU throttling drags empty
//    canvas in 60 steps; p50 / p95 / max frame time from requestAnimationFrame deltas during the
//    drag, the elements with a computed backdrop-filter and the .glass-surface nodes
//  - desktop: 1440 × 900, mouse, reduced motion; the same backdrop-filter count and a
//    screenshot of the first window (its sha256, to compare before and after)
// Runs on the demo (`?demo=1`, no broker needed). Writes <out>/pan-perf-<tag>.json and the
// desktop crop <out>/pan-perf-<tag>-window.png.
//   node pan-perf.mjs <out dir> [tag]
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP, DESK_URL, PHONE, launch, outDir } from "./lib.mjs";

const out = outDir();
const tag = process.argv[3] ?? "after";
const LOOK = { bg: "none", narr: "plain", tethers: false, autoArrange: true };
const b = await launch();

async function open(options) {
  const ctx = await b.newContext(options);
  await ctx.addInitScript((look) => {
    localStorage.setItem("volley-desk-look", JSON.stringify(look));
  }, LOOK);
  const page = await ctx.newPage();
  const url = new URL(DESK_URL);
  url.searchParams.set("demo", "1");
  await page.goto(url.href);
  const signIn = page.getByRole("button", { name: "Sign in" });
  if (await signIn.isVisible().catch(() => false)) await signIn.click();
  await page.locator(".world section.win").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500); // the demo settles and auto-arrange places the windows
  return { ctx, page };
}

/** Elements whose computed backdrop-filter is not `none`, and the GlassSurface nodes. */
const surfaces = (page) =>
  page.evaluate(() => {
    const backdrop = [...document.querySelectorAll("*")].filter((e) => {
      const s = getComputedStyle(e);
      const v = s.backdropFilter || s.webkitBackdropFilter || "none";
      return v !== "none";
    });
    return {
      lite: matchMedia(
        "(hover: none) and (pointer: coarse), (prefers-reduced-transparency: reduce)",
      ).matches,
      windows: document.querySelectorAll(".world section.win").length,
      backdrop: backdrop.length,
      backdropElements: backdrop.map(
        (e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`,
      ),
      glassSurface: document.querySelectorAll(".glass-surface").length,
    };
  });

/** A screen point on empty canvas (the stage or the world layer, not a window or the chrome). */
const emptyPoint = (page) =>
  page.evaluate(() => {
    for (let y = 120; y < innerHeight - 140; y += 12)
      for (let x = 12; x < innerWidth - 12; x += 12) {
        const el = document.elementFromPoint(x, y);
        if (el && (el.classList.contains("stage") || el.classList.contains("world")))
          return { x, y };
      }
    return null;
  });

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? null;
};
const round = (n) => (n === null ? null : Math.round(n * 10) / 10);

async function phone() {
  const { ctx, page } = await open({
    viewport: PHONE,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const at = await emptyPoint(page);
  if (!at) throw new Error("no empty canvas to drag");
  await page.evaluate(() => {
    window.__frames = [];
    const loop = (t) => {
      window.__frames.push(t);
      window.__raf = requestAnimationFrame(loop);
    };
    window.__raf = requestAnimationFrame(loop);
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) await page.mouse.move(at.x + i * 3, at.y + i * 4);
  await page.mouse.up();
  const ts = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__frames;
  });
  const deltas = ts.slice(1).map((t, i) => t - ts[i]);
  const result = {
    drag: { from: at, steps: 60, frames: deltas.length },
    frameMs: {
      p50: round(pct(deltas, 50)),
      p95: round(pct(deltas, 95)),
      max: round(Math.max(...deltas)),
    },
    ...(await surfaces(page)),
  };
  await ctx.close();
  return result;
}

async function desktop() {
  const { ctx, page } = await open({ viewport: DESKTOP, reducedMotion: "reduce" });
  const counts = await surfaces(page);
  const box = await page.locator(".world section.win").first().boundingBox();
  const png = await page.screenshot({ clip: box });
  const file = join(out, `pan-perf-${tag}-window.png`);
  writeFileSync(file, png);
  await ctx.close();
  return {
    ...counts,
    window: { box, png: file, sha256: createHash("sha256").update(png).digest("hex") },
  };
}

const report = { tag, url: DESK_URL, phone: await phone(), desktop: await desktop() };
await b.close();
writeFileSync(join(out, `pan-perf-${tag}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
