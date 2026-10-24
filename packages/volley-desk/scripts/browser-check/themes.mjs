// The theme token layer (#365) and the light tone (#368). On the demo (`?demo=1`, no broker),
// with the look `{ bg: "none", narr: "plain", tethers: false, autoArrange: true, theme, icons }`
// and reduced motion, at desktop (1440 × 900) and phone (390 × 844, touch): screenshot the first
// agent window, the first wave window, the dock, the Needs you window, the Settings window on
// General and on Appearance, and (without `?demo`) the sign-in card; record the computed
// `--ground`, `--t-acc` and `--ink` on <html>. A light theme (Material Lighter) runs once with
// the Clawd characters and once with the classic ring. On each view axe-core's `color-contrast`
// rule runs in the page (jsdom cannot measure colour) and `text-contrast.mjs` measures every
// text element against the pixels under it; both report offenders by selector with the ratio. Writes
// <out>/theme-<theme>[-classic]-<device>-<what>-<tag>.png and <out>/themes-<tag>.json (with each
// crop's sha256). Run with theme `volley` before and after a change to the token layer: every
// crop is byte-equal. The sign-in card shows only when the dev server has no credentials of its
// own (no `VITE_VOLLEY_*` sign-in): otherwise it is skipped.
//   node themes.mjs <out dir> [tag] [theme...]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DESKTOP, DESK_URL, PHONE, launch, outDir } from "./lib.mjs";
import { canvasTextContrast, textContrast } from "./text-contrast.mjs";

const out = outDir();
const tag = process.argv[3] ?? "after";
// Volley always runs: it is the baseline the other themes' offenders are compared with.
const themes = [...new Set(["volley", ...process.argv.slice(4)])];
const b = await launch();
const report = {};

const LIGHT = new Set(["lighter"]);
// axe-core from the workspace (volley-desk's dev dependency), injected into each page.
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** axe's `color-contrast` offenders on the page: selector, ratio, colours and text. */
async function contrastAudit(page) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: ["color-contrast"] });
    return r.violations.flatMap((v) =>
      v.nodes.map((n) => {
        const d = n.any[0]?.data ?? {};
        return {
          target: n.target.join(" "),
          ratio: d.contrastRatio,
          fg: d.fgColor,
          bg: d.bgColor,
          text: (n.html ?? "").slice(0, 120),
        };
      }),
    );
  });
}

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function open(theme, icons, viewport, device, demo) {
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
    { bg: "none", narr: "plain", tethers: false, autoArrange: true, theme, icons },
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

const runs = themes.flatMap((theme) =>
  (LIGHT.has(theme) ? ["clawd", "classic"] : ["clawd"]).map((icons) => [theme, icons]),
);
let violations = 0;
let measured = 0;
for (const [theme, icons] of runs) {
  const name = icons === "clawd" ? theme : `${theme}-${icons}`;
  for (const [device, viewport] of [
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ]) {
    const r = { shots: {}, contrast: {} };
    const shot = async (what, locator) => {
      const path = join(out, `theme-${name}-${device}-${what}-${tag}.png`);
      await locator.screenshot({ path, animations: "disabled" });
      r.shots[what] = sha(path);
    };
    // The canvas window by window at 1:1; a Settings view or the sign-in card on its own.
    const audit = async (what, page, root) => {
      const axe = await contrastAudit(page);
      const { checked, bad } = await (root ? textContrast(page, root) : canvasTextContrast(page));
      violations += axe.length;
      measured += bad.length;
      r.contrast[what] = { axe, checked, measured: bad };
    };
    const { ctx, page } = await open(theme, icons, viewport, device, true);
    await page.clock.runFor(1000);
    await page.locator(".world section.win").first().waitFor({ timeout: 30000 });
    await page.clock.runFor(2500); // the demo settles and auto-arrange places the windows
    r.tokens = await tokens(page);
    r.dataTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
    const agent = page.locator(
      ".world section.win:has(.win-bar .clawd-sprite, .win-bar .status-mark)",
    );
    await shot("agent", agent.first());
    await shot(
      "wave",
      page
        .locator(".world section.win:not(:has(.win-bar .clawd-sprite, .win-bar .status-mark))")
        .first(),
    );
    await shot("dock", page.locator(".dock-wrap"));
    // The Needs you window opens with the Desk.
    await shot("needs-you", page.getByRole("region", { name: "Needs you", exact: true }));
    await audit("canvas", page);
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
    await audit("settings-general", page, '[role="dialog"][aria-label="Settings"]');
    await section("Appearance").click();
    await page.clock.runFor(400);
    await shot("settings-appearance", dialog);
    await audit("settings-appearance", page, '[role="dialog"][aria-label="Settings"]');
    await ctx.close();

    const signin = await open(theme, icons, viewport, device, false);
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
      await audit("signin", signin.page, ".signin-card");
      r.signinTokens = await tokens(signin.page);
    } else {
      r.shots.signin = "skipped: the dev server signed in on its own";
    }
    await signin.ctx.close();
    report[`${name}-${device}`] = r;
  }
}
await b.close();
// What each theme adds to Volley's own offenders (the brand and status colours stay the same on
// every theme, so text that misses AA on them misses it on Volley too): the gate is none.
const key = (b) => `${b.path}|${b.text}`;
const added = {};
for (const [run, r] of Object.entries(report)) {
  const device = run.slice(run.lastIndexOf("-") + 1);
  const base = report[`volley-${device}`];
  if (run.startsWith("volley-")) continue;
  if (!base) throw new Error(`${run}: no volley-${device} baseline to compare with`);
  for (const [what, c] of Object.entries(r.contrast)) {
    const known = new Set((base.contrast[what]?.measured ?? []).map(key));
    const extra = c.measured.filter((b) => !known.has(key(b)));
    if (extra.length > 0) added[`${run} ${what}`] = extra;
  }
}
report.addedOverVolley = added;
writeFileSync(join(out, `themes-${tag}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
const addedCount = Object.values(added).reduce((n, l) => n + l.length, 0);
console.log(
  `axe color-contrast violations: ${violations}; measured text below AA: ${measured}; beyond Volley's own: ${addedCount}`,
);
if (violations > 0 || addedCount > 0) process.exitCode = 1;
