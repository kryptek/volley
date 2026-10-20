// Window-style audit: the same 3 panels in every window style at desktop width.
//  - box: each panel's bounding box equals the default (glass) style's: no added frame or padding
//  - overflow: hovering a panel (with the tilt) adds no scrollbars to the window or its wrappers
//  - under-body: fast pointer circles over a panel paint nothing under its body (no glow / pinwheel)
//    (reduced motion: no tilt, so the body pixels before and after are comparable)
// Run against a Desk seeded by seed-waves.mjs (re-seed first: the wave goes stale). Writes
// <out>/window-styles-<tag>.json and one screenshot per style and panel; sheet.mjs lays them out.
//   node styles-audit.mjs <out dir> [tag]
import { writeFileSync } from "node:fs";
import { DESK_URL, launch, outDir } from "./lib.mjs";

const out = outDir();
const tag = process.argv[3] ?? "after";
const CHROMES = ["glass", "liquid", "spotlight", "glow", "solid"];
const PANELS = ["release-c", "release-c · T1 · implementer", "Wave coordinators"];
const VP = { width: 1600, height: 1000 };
const b = await launch();

async function open(chrome, reducedMotion) {
  const ctx = await b.newContext({ viewport: VP, reducedMotion });
  await ctx.addInitScript((c) => {
    localStorage.setItem(
      "volley-desk-look",
      JSON.stringify({ chrome: c, bg: "none", narr: "plain", tethers: false, autoArrange: true }),
    );
  }, chrome);
  const page = await ctx.newPage();
  await page.goto(DESK_URL);
  await page.getByRole("button", { name: "Sign in" }).click();
  for (const name of PANELS)
    await page.getByRole("region", { name, exact: true }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500); // the replay settles and auto-arrange places the windows
  return { ctx, page };
}

const panel = (page, name) => page.getByRole("region", { name, exact: true });

/** Every element in the window whose content overflows its box (a scrollbar shows). */
const overflowing = (loc) =>
  loc.evaluate((root) =>
    [root, ...root.querySelectorAll("*")]
      .filter((e) => {
        const o = getComputedStyle(e);
        const scrolls = /(auto|scroll)/.test(o.overflow + o.overflowX + o.overflowY);
        return (
          scrolls && (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)
        );
      })
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`),
  );

async function circles(page, box) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const r = Math.min(box.width, box.height) * 0.42;
  for (let k = 0; k < 3 * 48; k++) {
    const a = (k / 48) * 2 * Math.PI;
    await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

/** Mean RGB of small patches across the panel body (screen pixels). */
async function bodyPixels(page, name) {
  const body = await panel(page, name).locator(".win-body").first().boundingBox();
  const pts = [
    [0.5, 0.5],
    [0.3, 0.35],
    [0.7, 0.35],
    [0.3, 0.7],
    [0.7, 0.7],
  ];
  const out = [];
  for (const [fx, fy] of pts) {
    const clip = {
      x: body.x + body.width * fx - 6,
      y: body.y + body.height * fy - 6,
      width: 12,
      height: 12,
    };
    const png = await page.screenshot({ clip });
    out.push(
      await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const m = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) m[j] += d[i + j];
        return m.map((v) => v / (d.length / 4));
      }, png.toString("base64")),
    );
  }
  return out;
}

const report = {};
for (const chrome of CHROMES) {
  const r = {};
  report[chrome] = r;
  // Pass 1: motion on (the hover tilts the window).
  {
    const { ctx, page } = await open(chrome, "no-preference");
    for (const name of PANELS) {
      const p = panel(page, name);
      const box = await p.boundingBox();
      const before = await overflowing(p);
      await circles(page, box);
      await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2);
      await page.waitForTimeout(400);
      const after = await overflowing(p);
      r[name] = {
        box: { w: Math.round(box.width), h: Math.round(box.height) },
        newOverflow: after.filter((x) => !before.includes(x)),
      };
      const pad = 44;
      await page.screenshot({
        path: `${out}/style-${tag}-${chrome}-${PANELS.indexOf(name)}.png`,
        clip: {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: Math.min(box.width + 2 * pad, VP.width - Math.max(0, box.x - pad)),
          height: Math.min(box.height + 2 * pad, VP.height - Math.max(0, box.y - pad)),
        },
      });
      await page.mouse.move(2, VP.height - 2);
      await page.waitForTimeout(900);
    }
    await ctx.close();
  }
  // Pass 2: reduced motion (no tilt), so body pixels before and after the circles compare.
  {
    const { ctx, page } = await open(chrome, "reduce");
    for (const name of PANELS) {
      await page.mouse.move(2, VP.height - 2);
      await page.waitForTimeout(900);
      const quiet = await bodyPixels(page, name);
      const box = await panel(page, name).boundingBox();
      await circles(page, box);
      const hot = await bodyPixels(page, name);
      r[name].underBodyDelta = Math.round(
        Math.max(...quiet.map((q, i) => Math.max(...q.map((v, j) => Math.abs(v - hot[i][j]))))),
      );
    }
    await ctx.close();
  }
}
const base = report.glass;
for (const chrome of CHROMES) {
  for (const name of PANELS) {
    const x = report[chrome][name];
    x.sameBoxAsDefault = x.box.w === base[name].box.w && Math.abs(x.box.h - base[name].box.h) <= 1;
  }
}
writeFileSync(`${out}/window-styles-${tag}.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
await b.close();
