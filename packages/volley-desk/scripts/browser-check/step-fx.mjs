// The current-step effects (#366): what each of the nine costs, and that each is still under
// reduced motion. For every effect (`look.fx`):
//  - phone: an emulated iPhone (390 × 844, DPR 3, touch) at 4× CPU throttling; frame times from
//    requestAnimationFrame deltas for 3 s with the pointer still (the effect's idle cost), then
//    during the 60-step pan of pan-perf.mjs (#295); p50 / p95 / max for both, and a crop of the
//    first agent window
//  - desktop: 1440 × 900, the same without throttling, and the crop
//  - reduced motion (desktop): two screenshots of the current step 400 ms apart, byte-equal
// Budget: phone idle p95 < 20 ms, phone pan p95 < 33 ms (the #295 bar). An effect over it on the
// phone gets the coarse-pointer fallback in stepfx.css. Runs on the demo (`?demo=1`, no broker).
// Writes <out>/step-fx-<tag>.json and <out>/step-fx-<tag>-<fx>-<phone|desktop>.png; effects named
// after the tag measure only those.
//   node step-fx.mjs <out dir> [tag] [fx...]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP, DESK_URL, PHONE, launch, outDir } from "./lib.mjs";

const out = outDir();
const tag = process.argv[3] ?? "after";
const ALL = ["glint", "pulse", "aurora", "scan", "ember", "liquid", "circuit", "prism", "classic"];
const FX = process.argv.length > 4 ? process.argv.slice(4) : ALL;
const BUDGET = { idleP95: 20, panP95: 33 };
const b = await launch();

async function open(fx, options) {
  const ctx = await b.newContext(options);
  const look = {
    bg: "none",
    narr: "plain",
    tethers: false,
    autoArrange: true,
    theme: "volley",
    fx,
  };
  await ctx.addInitScript((l) => {
    localStorage.setItem("volley-desk-look", JSON.stringify(l));
  }, look);
  const page = await ctx.newPage();
  const url = new URL(DESK_URL);
  url.searchParams.set("demo", "1");
  await page.goto(url.href);
  const signIn = page.getByRole("button", { name: "Sign in" });
  if (await signIn.isVisible().catch(() => false)) await signIn.click();
  await page.locator(".world section.win .pipe").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500); // the demo settles and auto-arrange places the windows
  return { ctx, page };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? null;
};
const round = (n) => (n === null ? null : Math.round(n * 10) / 10);
const stats = (deltas) => ({
  frames: deltas.length,
  p50: round(pct(deltas, 50)),
  p95: round(pct(deltas, 95)),
  max: round(deltas.length ? Math.max(...deltas) : null),
});

const startFrames = (page) =>
  page.evaluate(() => {
    window.__frames = [];
    const loop = (t) => {
      window.__frames.push(t);
      window.__raf = requestAnimationFrame(loop);
    };
    window.__raf = requestAnimationFrame(loop);
  });
const stopFrames = async (page) => {
  const ts = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__frames;
  });
  return ts.slice(1).map((t, i) => t - ts[i]);
};

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

/**
 * The first agent window (the one with a pipeline) at scale 1: the demo fits every window on
 * screen, so the world layer is moved to put that window top-left for the shot, then put back.
 */
async function agentCrop(page, file) {
  const win = page.locator(".world section.win:has(.pipe)").first();
  const was = await win.evaluate((el) => {
    const world = el.closest(".world");
    const prev = world.style.transform;
    const x = Number.parseFloat(el.style.left) || 0;
    const y = Number.parseFloat(el.style.top) || 0;
    world.style.transform = `translate(${12 - x}px, ${80 - y}px) scale(1)`;
    return prev;
  });
  await page.waitForTimeout(300);
  const box = await win.boundingBox();
  if (box) writeFileSync(file, await page.screenshot({ clip: box }));
  await win.evaluate((el, prev) => {
    el.closest(".world").style.transform = prev;
  }, was);
  await page.waitForTimeout(300);
  return box ? file : null;
}

async function measure(fx, where) {
  const phone = where === "phone";
  const { ctx, page } = await open(
    fx,
    phone
      ? { viewport: PHONE, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
      : { viewport: DESKTOP },
  );
  if (phone) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  const png = await agentCrop(page, join(out, `step-fx-${tag}-${fx}-${where}.png`));
  const at = await emptyPoint(page);
  if (!at) throw new Error(`${fx} ${where}: no empty canvas to drag`);
  await page.mouse.move(at.x, at.y);
  await startFrames(page);
  await page.waitForTimeout(3000);
  const idle = stats(await stopFrames(page));
  await startFrames(page);
  await page.mouse.down();
  for (let i = 1; i <= 60; i++) await page.mouse.move(at.x + i * 3, at.y + i * 4);
  await page.mouse.up();
  const pan = stats(await stopFrames(page));
  await ctx.close();
  return { idle, pan, png };
}

/** Under reduced motion the current step is its first keyframe: two shots 400 ms apart match. */
async function still(fx) {
  const { ctx, page } = await open(fx, { viewport: DESKTOP, reducedMotion: "reduce" });
  const cur = page.locator(".world .pipe li.fx-cur").first();
  const a = await cur.screenshot();
  await page.waitForTimeout(400);
  const c = await cur.screenshot();
  await ctx.close();
  return a.equals(c);
}

const effects = {};
for (const fx of FX) {
  const phone = await measure(fx, "phone");
  const desktop = await measure(fx, "desktop");
  const reducedStill = await still(fx);
  const withinBudget = phone.idle.p95 < BUDGET.idleP95 && phone.pan.p95 < BUDGET.panP95;
  effects[fx] = { phone, desktop, reducedStill, withinBudget };
  console.error(
    `${fx}: phone idle p95 ${phone.idle.p95} ms, pan p95 ${phone.pan.p95} ms; desktop idle p95 ${desktop.idle.p95} ms, pan p95 ${desktop.pan.p95} ms; still ${reducedStill}; ${withinBudget ? "within budget" : "OVER BUDGET"}`,
  );
}
const report = { tag, url: DESK_URL, budget: BUDGET, effects };
await b.close();
writeFileSync(join(out, `step-fx-${tag}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
