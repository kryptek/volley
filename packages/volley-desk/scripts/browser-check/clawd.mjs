// The agent windows' Clawd characters (#350). On the demo (`?demo=1`, no broker, no sign-in), at
// desktop and phone (touch): screenshot each agent window's title bar and record its sprite's
// label, before and after the demo's spec reviewer spawns (22 s in); the labels cover implementing, reviewing, fixing up, merge-ready and needs you / waiting;
// every title bar is as tall as with the Classic spinner (±1 px); on the phone the merge-ready
// glow is off (`filter: none`). Then, under prefers-reduced-motion, one sprite is still: two
// screenshots 300 ms apart are byte-identical.
//   node clawd.mjs <out dir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP, DESK_URL, PHONE, launch, outDir } from "./lib.mjs";

const out = outDir();
const b = await launch();
const report = {};
/** What failed, as "<device>: <what>"; any entry fails the check (exit 1). */
const failures = [];
const WANT = ["implementing", "reviewing", "fixing up", "merge-ready"];

/** Each agent window's label, its sprite's label and filter, and its title bar's height. */
const windows = (page) =>
  page.locator(".world section.win").evaluateAll((els) =>
    els
      .filter((e) => e.querySelector(".win-bar .clawd-sprite, .win-bar .status-mark"))
      .map((e) => {
        const sprite = e.querySelector(".win-bar .clawd-sprite");
        return {
          label: e.getAttribute("aria-label"),
          sprite: sprite?.getAttribute("aria-label") ?? null,
          filter: sprite ? getComputedStyle(sprite).filter : null,
          bar: Math.round(e.querySelector(".win-bar").getBoundingClientRect().height),
        };
      }),
  );

async function open(device, viewport, icons, reducedMotion = "no-preference") {
  const page = await b.newPage({ viewport, deviceScaleFactor: 2, hasTouch: device === "phone" });
  await page.emulateMedia({ reducedMotion });
  await page.addInitScript(
    (look) => {
      localStorage.setItem("volley-desk-look", JSON.stringify(look));
    },
    { bg: "none", icons },
  );
  await page.goto(`${DESK_URL}?demo=1`);
  await page.locator(".world section.win .win-bar").first().waitFor();
  await page.waitForTimeout(1500);
  return page;
}

for (const [device, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
]) {
  const r = {};
  const expect = (ok, what) => {
    if (!ok) failures.push(`${device}: ${what}`);
  };

  const classic = await open(device, viewport, "classic");
  const classicBars = new Map((await windows(classic)).map((w) => [w.label, w.bar]));
  await classic.close();

  const page = await open(device, viewport, "clawd");
  const shot = new Set();
  /** One title-bar screenshot per sprite label. */
  const shoot = async () => {
    for (const sec of await page.locator(".world section.win").all()) {
      const sprite = sec.locator(".win-bar .clawd-sprite");
      if ((await sprite.count()) === 0) continue;
      const label = (await sprite.getAttribute("aria-label")).replace(/\s+/g, "-");
      if (shot.has(label)) continue;
      shot.add(label);
      await sec
        .locator(".win-bar")
        .screenshot({ path: join(out, `clawd-${device}-${label}.png`) })
        .catch((e) => failures.push(`${device}: screenshot ${label}: ${e.message}`));
    }
  };
  r.windows = await windows(page);
  await shoot();
  // The demo's spec reviewer (and T1's spec_review stage) arrives 22 s in.
  r.reviewerArrived = await page
    .locator('.world .win-bar .clawd-sprite[aria-label="reviewing"]')
    .first()
    .waitFor({ timeout: 40_000 })
    .then(() => true)
    .catch(() => false);
  r.later = await windows(page);
  await shoot();
  const labels = new Set([...r.windows, ...r.later].map((w) => w.sprite));
  for (const want of WANT) expect(labels.has(want), `no "${want}" sprite`);
  expect(labels.has("needs you") || labels.has("waiting"), 'no "needs you" / "waiting" sprite');
  for (const w of r.windows) {
    const c = classicBars.get(w.label);
    w.classicBar = c ?? null;
    expect(
      c !== undefined && Math.abs(c - w.bar) <= 1,
      `${w.label}: bar ${w.bar} px, classic ${c}`,
    );
  }
  if (device === "phone") {
    const glow = r.windows.find((w) => w.sprite === "merge-ready");
    expect(glow?.filter === "none", `merge-ready filter on a touch screen: ${glow?.filter}`);
  }
  await page.close();

  const still = await open(device, viewport, "clawd", "reduce");
  const sprite = still.locator(".world .win-bar .clawd-sprite").first();
  const a = await sprite.screenshot();
  await still.waitForTimeout(300);
  const c = await sprite.screenshot();
  r.reducedMotionStill = a.equals(c);
  expect(r.reducedMotionStill, "a sprite moved under prefers-reduced-motion");
  await still.close();

  report[device] = r;
}
writeFileSync(join(out, "clawd.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
await b.close();
if (failures.length > 0) {
  console.error(`FAILED:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("clawd: ok");
