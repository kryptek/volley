// The theme token layer (#365), the light tone (#368) and the palettes (#369). On the demo
// (`?demo=1`, no broker), with the look `{ bg: "none", narr: "plain", tethers: false,
// autoArrange: true, theme, icons }` and reduced motion, at desktop (1440 × 900) and phone
// (390 × 844, touch): screenshot the first agent window, the first wave window, the dock, the
// Needs you window, the Settings window on General and on Appearance, and (without `?demo`) the
// sign-in card; record the computed `--ground`, `--t-acc` and `--ink` on <html>. A light theme
// (Material Lighter) runs once with the Clawd characters and once with the classic ring. On each
// view axe-core's `color-contrast` rule runs in the page (jsdom cannot measure colour) and
// `text-contrast.mjs` measures every text element against the pixels under it; both report
// offenders by selector with the ratio. For any theme but Volley, at desktop (the phone draws the
// lite fills), the centre check: the first agent window's own background at the open point
// nearest its centre (the commonest colour of a 9 × 9 patch) is the theme's `--panel-solid` at
// the glass fill's 42 % and `--win2` at the gradient's 32 % over `--ground`, ± 8 per channel, so
// a dark literal the themed block missed shows up as a miss. Writes
// <out>/theme-<theme>[-classic]-<device>-<what>-<tag>.png and <out>/themes-<tag>.json (with each
// crop's sha256). Run with theme `volley` before and after a change to the token layer: every
// crop is byte-equal. The sign-in card shows only when the dev server has no credentials of its
// own (no `VITE_VOLLEY_*` sign-in): otherwise it is skipped.
//   node themes.mjs <out dir> [tag] [theme...]
//
// `--matrix` (#370) is the release run: every theme (or the ones named) × the current-step
// effects Glint, Aurora, Liquid and Classic × desktop and phone, with motion on. Each cell records
// the computed `--ground`, `--t-acc` and `--cur1`, crops the whole Desk (desktop), the first agent
// window, a running wave window (status-chip), the ended one (onboarding, brought back with
// Show), Settings › Appearance (and its Current step cards at desktop) and the sign-in card, and
// counts axe's
// `color-contrast` violations on the canvas, Appearance and the sign-in card. Then the
// still-frame pass: reduced motion, Volley and Material Lighter × all nine effects, two shots of
// the current step 400 ms apart, byte-equal. Writes <out>/matrix-<tag>.json, the sheet
// <out>/matrix-<tag>.html (one row per theme, one column per effect × device, the crops beside
// it) and <out>/matrix-<theme>-<fx>-<device>-<what>-<tag>.png; fails on any violation, a missing
// cell or crop, or a step that moves under reduced motion.
//   node themes.mjs <out dir> [tag] --matrix [theme...]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DESKTOP, DESK_URL, PHONE, launch, outDir } from "./lib.mjs";
import { canvasTextContrast, textContrast } from "./text-contrast.mjs";

const out = outDir();
const MATRIX = process.argv.includes("--matrix");
const args = process.argv.slice(3).filter((a) => a !== "--matrix");
const tag = args[0] ?? "after";
// Volley always runs: it is the baseline the other themes' offenders are compared with.
const themes = [...new Set(["volley", ...args.slice(1)])];
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

async function open(theme, icons, viewport, device, demo, { fx, reducedMotion = "reduce" } = {}) {
  const ctx = await b.newContext({
    viewport,
    deviceScaleFactor: 2,
    hasTouch: device === "phone",
    isMobile: device === "phone",
    reducedMotion,
  });
  await ctx.addInitScript(
    (look) => {
      localStorage.setItem("volley-desk-look", JSON.stringify(look));
    },
    {
      bg: "none",
      narr: "plain",
      tethers: false,
      autoArrange: true,
      theme,
      icons,
      ...(fx ? { fx } : {}),
    },
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

// ---------------------------------------------------------------- the release matrix (#370)

// `THEME_LABEL` in src/look/themes.ts, in the picker's order.
const ALL_THEMES = [
  "volley",
  "oceanic",
  "darker",
  "palenight",
  "deepocean",
  "lighter",
  "dracula",
  "nightowl",
  "onedark",
  "github",
  "monokai",
  "solarized",
];
const MATRIX_FX = ["glint", "aurora", "liquid", "classic"];
// `STEP_FX` in src/look/useLook.ts: the still-frame pass runs every one.
const ALL_FX = [
  "glint",
  "pulse",
  "aurora",
  "scan",
  "ember",
  "liquid",
  "circuit",
  "prism",
  "classic",
];
const STILL_THEMES = ["volley", "lighter"];
const DEVICES = [
  ["desktop", DESKTOP],
  ["phone", PHONE],
];
const RUNNING_WAVE = "status-chip";
const ENDED_WAVE = "onboarding";

/** Run `jobs` (functions returning promises) `n` at a time. */
async function pool(jobs, n) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]();
    }),
  );
}

const matrixTokens = (page) =>
  page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      ["--ground", "--t-acc", "--cur1"].map((p) => [p, s.getPropertyValue(p).trim()]),
    );
  });

/** One cell: a theme, an effect, a device, with motion on. */
async function matrixCell(theme, fx, device, viewport) {
  const cell = { crops: {}, violations: 0, offenders: {} };
  const shot = async (what, locator) => {
    const path = join(out, `matrix-${theme}-${fx}-${device}-${what}-${tag}.png`);
    try {
      await locator.screenshot({ path, animations: "disabled", timeout: 10000 });
      cell.crops[what] = path;
    } catch (e) {
      cell.crops[what] = null;
      cell.errors = [...(cell.errors ?? []), `${what}: ${e.message.split("\n")[0]}`];
    }
  };
  const audit = async (what, page) => {
    const axe = await contrastAudit(page);
    cell.violations += axe.length;
    if (axe.length > 0) cell.offenders[what] = axe;
  };
  const opts = { fx, reducedMotion: "no-preference" };
  const { ctx, page } = await open(theme, "clawd", viewport, device, true, opts);
  await page.clock.runFor(1000);
  await page.locator(".world section.win").first().waitFor({ timeout: 30000 });
  await page.clock.runFor(2500); // the demo settles and auto-arrange places the windows
  cell.tokens = await matrixTokens(page);
  if (device === "desktop") await shot("desk", page);
  const agent = page.locator(
    ".world section.win:has(.win-bar .clawd-sprite, .win-bar .status-mark)",
  );
  await shot("agent", agent.first());
  await shot("wave-running", page.getByRole("region", { name: RUNNING_WAVE, exact: true }));
  await audit("canvas", page);
  // The ended wave folds under the coordinators' Ended group: Show puts it back and fits to it.
  // The fit can leave the list off-screen on a phone: click it where it is.
  const coords = page.getByRole("region", { name: "Wave coordinators" });
  await coords.getByRole("button", { name: /^Ended · / }).dispatchEvent("click");
  await page.clock.runFor(300);
  await coords
    .getByRole("button", { name: `Show ${ENDED_WAVE} on the canvas` })
    .dispatchEvent("click");
  await page.clock.runFor(1500);
  await shot("wave-ended", page.getByRole("region", { name: ENDED_WAVE, exact: true }));
  await page.locator(".dock-wrap").getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.waitFor();
  await dialog
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await page.clock.runFor(400);
  await shot("appearance", dialog);
  if (device === "desktop") await shot("current-step", dialog.locator("fieldset.fx-grid"));
  await audit("appearance", page);
  await ctx.close();

  const signin = await open(theme, "clawd", viewport, device, false, opts);
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
    await audit("signin", signin.page);
  } else {
    cell.crops.signin = "skipped: the dev server signed in on its own";
  }
  await signin.ctx.close();
  return cell;
}

/** Under reduced motion the current step is its first keyframe: two shots 400 ms apart match. */
async function stillCell(theme, fx) {
  const { ctx, page } = await open(theme, "clawd", DESKTOP, "desktop", true, { fx });
  await page.locator(".world .pipe li.fx-cur").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const cur = page.locator(".world .pipe li.fx-cur").first();
  const a = await cur.screenshot();
  await page.waitForTimeout(400);
  const c = await cur.screenshot();
  await ctx.close();
  return a.equals(c);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The sheet: one row per theme, one column per effect × device, each cell its agent crop. */
function matrixSheet(m) {
  const cols = MATRIX_FX.flatMap((fx) => DEVICES.map(([d]) => [fx, d]));
  const rel = (p) => (p ? p.slice(p.lastIndexOf("/") + 1) : null);
  const td = (theme, fx, d) => {
    const c = m.cells[`${theme}/${fx}/${d}`];
    if (!c) return `<td class="bad">missing</td>`;
    const links = Object.entries(c.crops)
      .filter(([, p]) => p && !p.startsWith("skipped"))
      .map(([w, p]) => `<a href="${esc(rel(p))}">${esc(w)}</a>`)
      .join(" · ");
    const t = c.tokens ?? {};
    return `<td class="${c.violations || c.errors ? "bad" : ""}">${c.crops.agent ? `<img src="${esc(rel(c.crops.agent))}">` : ""}<div class="v">ground ${esc(t["--ground"])} · acc ${esc(t["--t-acc"])} · cur ${esc(t["--cur1"])}</div><div class="v">contrast violations: ${c.violations}${c.errors ? ` · ${esc(c.errors.join("; "))}` : ""}</div><div class="v">${links}</div></td>`;
  };
  const head = cols.map(([fx, d]) => `<th>${esc(fx)} · ${esc(d)}</th>`).join("");
  const rows = m.themes
    .map((t) => `<tr><th>${esc(t)}</th>${cols.map(([fx, d]) => td(t, fx, d)).join("")}</tr>`)
    .join("");
  const still = Object.entries(m.still)
    .map(([k, v]) => `<span class="${v ? "" : "bad"}">${esc(k)}: ${v ? "still" : "MOVES"}</span>`)
    .join(" · ");
  return `<!doctype html><meta charset="utf-8"><title>Theme × effect matrix (${esc(m.tag)})</title><style>
body{margin:0;padding:20px;background:#0b0c14;color:#e8ecf4;font:12px system-ui,sans-serif}
h1{font-size:16px;margin:0 0 6px} p{margin:0 0 12px;color:#9aa3b8} table{border-collapse:separate;border-spacing:6px}
th{text-align:left;vertical-align:top;font-weight:600} td{vertical-align:top;background:#151826;border-radius:8px;padding:6px;width:200px}
td.bad{outline:2px solid #ff6b6b} img{display:block;max-width:200px;max-height:220px} .v{margin-top:4px;color:#9aa3b8;font-size:10px;word-break:break-all}
a{color:#7fd4ff} .bad{color:#ff9a9a}
</style><h1>Theme × effect matrix (${esc(m.tag)}): ${m.themes.length} themes × ${MATRIX_FX.length} effects × ${DEVICES.length} devices</h1>
<p>axe color-contrast violations: ${m.violations} · cells: ${Object.keys(m.cells).length}/${m.expected} · missing crops: ${m.missingCrops}</p>
<p>Still under reduced motion: ${still}</p><table><tr><th></th>${head}</tr>${rows}</table>`;
}

async function matrix() {
  const named = args.slice(1);
  const mThemes = named.length > 0 ? named : ALL_THEMES;
  const m = { tag, url: DESK_URL, themes: mThemes, fx: MATRIX_FX, cells: {}, still: {} };
  const jobs = mThemes.flatMap((theme) =>
    MATRIX_FX.flatMap((fx) =>
      DEVICES.map(([device, viewport]) => async () => {
        const key = `${theme}/${fx}/${device}`;
        try {
          m.cells[key] = await matrixCell(theme, fx, device, viewport);
        } catch (e) {
          console.error(`${key}: ${e.message.split("\n")[0]}`);
          return;
        }
        console.error(`${key}: ${m.cells[key].violations} violations`);
      }),
    ),
  );
  await pool(jobs, Number(process.env.MATRIX_JOBS ?? 3));
  for (const theme of STILL_THEMES)
    for (const fx of ALL_FX) m.still[`${theme}/${fx}`] = await stillCell(theme, fx);
  m.expected = jobs.length;
  m.violations = Object.values(m.cells).reduce((n, c) => n + c.violations, 0);
  m.missingCrops = Object.values(m.cells).reduce(
    (n, c) => n + Object.values(c.crops).filter((p) => p === null).length,
    0,
  );
  writeFileSync(join(out, `matrix-${tag}.json`), `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(join(out, `matrix-${tag}.html`), matrixSheet(m));
  const moving = Object.entries(m.still).filter(([, v]) => !v);
  console.log(
    `matrix: ${Object.keys(m.cells).length}/${m.expected} cells; axe color-contrast violations: ${m.violations}; missing crops: ${m.missingCrops}; moving under reduced motion: ${moving.map(([k]) => k).join(", ") || "none"}`,
  );
  console.log(`sheet → ${join(out, `matrix-${tag}.html`)}`);
  const bad =
    m.violations > 0 ||
    m.missingCrops > 0 ||
    Object.keys(m.cells).length < m.expected ||
    moving.length > 0;
  return bad ? 1 : 0;
}

if (MATRIX) {
  const code = await matrix();
  await b.close();
  process.exit(code);
}

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
    if (theme !== "volley" && device === "desktop") r.centre = await centre(page, agent.first());
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
const misses = Object.entries(report).filter(([, r]) => r.centre && !r.centre.pass);
for (const [run, r] of misses)
  console.error(`centre check missed: ${run} ${JSON.stringify(r.centre)}`);
if (violations > 0 || addedCount > 0 || misses.length) process.exitCode = 1;
