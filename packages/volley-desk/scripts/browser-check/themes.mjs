// The theme token layer (#365) and the palettes (#369). On the demo (`?demo=1`, no broker), with
// the look `{ bg: "none", narr: "plain", tethers: false, autoArrange: true, theme }` and reduced
// motion, at desktop (1440 × 900) and phone (390 × 844, touch): screenshot the first agent
// window, the dock, the first wave window, the Settings window on General and on Appearance, and
// (without `?demo`) the sign-in card; record the computed `--ground`, `--t-acc` and `--ink` on
// <html>. For any theme but Volley, at desktop (the phone draws the lite fills), the centre
// check: the first agent window's own background at the open point nearest its centre (the
// commonest colour of a 9 × 9 patch) is the theme's `--panel-solid` at the glass fill's 42 % and
// `--win2` at the gradient's 32 % over `--ground`, ± 8 per channel, so a dark literal the themed
// block missed shows up as a miss. Writes <out>/theme-<theme>-<device>-<what>-<tag>.png and
// <out>/themes-<tag>.json (with each crop's sha256). Run with theme `volley` before and after a
// change to the token layer: every crop but Appearance (which gained the Theme group) is
// byte-equal. The sign-in card shows only when the dev server has no credentials of its own (no
// `VITE_VOLLEY_*` sign-in): otherwise it is skipped.
//   node themes.mjs <out dir> [tag] [theme...]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP, DESK_URL, PHONE, launch, outDir } from "./lib.mjs";

const out = outDir();
const tag = process.argv[3] ?? "after";
const themes = process.argv.length > 4 ? process.argv.slice(4) : ["volley"];
const b = await launch();
const report = {};

const hex = (c) => {
  const h = c.trim().replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
};
const over = (under, top, a) => under.map((u, i) => Math.round(top[i] * a + u * (1 - a)));

/** The window's own background nearest its centre (a point where nothing inside it paints). */
async function centre(page, win) {
  const at = await win.evaluate((w) => {
    const r = w.querySelector(".win-inner").getBoundingClientRect();
    const own = (el) => el?.matches(".win-inner, .win-depth, .win-body, .win-edge");
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    let best = null;
    for (let dy = -r.height / 2 + 12; dy < r.height / 2 - 12; dy += 4) {
      for (let dx = -r.width / 2 + 12; dx < r.width / 2 - 12; dx += 4) {
        const ok = [-4, 0, 4].every((oy) =>
          [-4, 0, 4].every((ox) => own(document.elementFromPoint(cx + dx + ox, cy + dy + oy))),
        );
        const d = dx * dx + dy * dy;
        if (ok && (!best || d < best.d)) best = { x: cx + dx, y: cy + dy, d };
      }
    }
    return best;
  });
  if (!at) return { pass: false, note: "no open body point" };
  const clip = { x: at.x - 4, y: at.y - 4, width: 9, height: 9 };
  const png = await page.screenshot({ clip, animations: "disabled", scale: "css" });
  const got = await page.evaluate(
    async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const n = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const k = `${d[i]},${d[i + 1]},${d[i + 2]}`;
        n.set(k, (n.get(k) ?? 0) + 1);
      }
      return [...n.entries()]
        .sort((a, b) => b[1] - a[1])[0][0]
        .split(",")
        .map(Number);
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );
  const v = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      ["--ground", "--panel-solid", "--win2"].map((p) => [p, s.getPropertyValue(p).trim()]),
    );
  });
  const want = over(
    over(hex(v["--ground"]), hex(v["--panel-solid"]), 0.42),
    hex(v["--win2"]),
    0.32,
  );
  const delta = Math.max(...got.map((g, i) => Math.abs(g - want[i])));
  return { at: [Math.round(at.x), Math.round(at.y)], got, want, delta, pass: delta <= 8 };
}

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function open(theme, viewport, device, demo) {
  const ctx = await b.newContext({
    viewport,
    deviceScaleFactor: 2,
    hasTouch: device === "phone",
    isMobile: device === "phone",
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(
    (look) => {
      localStorage.setItem("volley-desk-look", JSON.stringify(look));
    },
    { bg: "none", narr: "plain", tethers: false, autoArrange: true, theme },
  );
  const page = await ctx.newPage();
  // A fixed clock: the demo's feed, timestamps and sprites are the same on every run.
  await page.clock.install({ time: new Date("2026-10-24T12:00:00Z") });
  const url = new URL(DESK_URL);
  if (demo) url.searchParams.set("demo", "1");
  await page.goto(url.href);
  return { ctx, page };
}

const tokens = (page) =>
  page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      ["--ground", "--t-acc", "--ink"].map((p) => [p, s.getPropertyValue(p).trim()]),
    );
  });

for (const theme of themes) {
  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ]) {
    const r = { shots: {} };
    const shot = async (what, locator) => {
      const path = join(out, `theme-${theme}-${device}-${what}-${tag}.png`);
      await locator.screenshot({ path, animations: "disabled" });
      r.shots[what] = sha(path);
    };
    const { ctx, page } = await open(theme, viewport, device, true);
    await page.clock.runFor(1000);
    await page.locator(".world section.win").first().waitFor({ timeout: 30000 });
    await page.clock.runFor(2500); // the demo settles and auto-arrange places the windows
    r.tokens = await tokens(page);
    r.dataTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
    const agent = page.locator(
      ".world section.win:has(.win-bar .clawd-sprite, .win-bar .status-mark)",
    );
    await shot("agent", agent.first());
    if (theme !== "volley" && device === "desktop") r.centre = await centre(page, agent.first());
    await shot("dock", page.locator(".dock-wrap .dock"));
    await shot(
      "wave",
      page
        .locator(".world section.win:not(:has(.win-bar .clawd-sprite, .win-bar .status-mark))")
        .first(),
    );
    await page.locator(".dock-wrap").getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.waitFor();
    const section = (name) =>
      dialog
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name, exact: true });
    await section("General")
      .click()
      .catch(() => {});
    await page.clock.runFor(400);
    await shot("settings-general", dialog);
    await section("Appearance").click();
    await page.clock.runFor(400);
    await shot("settings-appearance", dialog);
    await ctx.close();

    const signin = await open(theme, viewport, device, false);
    const card = signin.page.locator(".signin-card");
    await signin.page.clock.runFor(1000);
    if (
      await card.waitFor({ timeout: 8000 }).then(
        () => true,
        () => false,
      )
    ) {
      await signin.page.clock.runFor(800);
      await shot("signin", card);
      r.signinTokens = await tokens(signin.page);
    } else {
      r.shots.signin = "skipped: the dev server signed in on its own";
    }
    await signin.ctx.close();
    report[`${theme}-${device}`] = r;
  }
}
await b.close();
writeFileSync(join(out, `themes-${tag}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
const misses = Object.entries(report).filter(([, r]) => r.centre && !r.centre.pass);
for (const [key, r] of misses) console.error(`centre check missed: ${key} ${JSON.stringify(r.centre)}`);
if (misses.length) process.exitCode = 1;
