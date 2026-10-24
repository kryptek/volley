// The "why here" cards draw above the canvas (#349): the agent window's machine chip tooltip
// and the wave window's host-chip popover. On the demo (`?demo=1`, no broker, no sign-in), at
// desktop, phone (touch), desktop zoomed out two steps (the demo's fit is usually the minimum
// already; the report records the canvas transform) and zoomed in around the T6 host chip, open
// each card (hover on desktop,
// keyboard focus on the phone; a click for the host chip) and check it is fully on screen, not
// inside any window, uncovered near its bottom-right corner, and at most 360 px wide.
//   node popovers.mjs <out dir>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP, DESK_URL, PHONE, launch, outDir } from "./lib.mjs";

const out = outDir();
const b = await launch();
const report = {};
/** What failed, as "<case>-<device>: <what>"; any entry fails the check (exit 1). */
const failures = [];

/** The open card's box and whether it is clear: inside the viewport, outside every window, uncovered. */
const inspect = (page, selector) =>
  page.evaluate((sel) => {
    const card = document.querySelector(sel);
    if (!card) return null;
    const r = card.getBoundingClientRect();
    // 4 px in: a 2 px inset falls outside the card's 10 px rounded corner.
    const hit = document.elementFromPoint(r.right - 4, r.bottom - 4);
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      viewport: { w: innerWidth, h: innerHeight },
      inWindow: !!card.closest("section.win"),
      uncovered: !!hit && (hit === card || card.contains(hit)),
      side: card.getAttribute("data-side"),
    };
  }, selector);

function judge(tag, box) {
  if (!box) return failures.push(`${tag}: the card did not open`);
  const { x, y, right, bottom, width, viewport, inWindow, uncovered } = box;
  if (x < 0 || y < 0 || right > viewport.w || bottom > viewport.h)
    failures.push(
      `${tag}: off screen (${x},${y})–(${right},${bottom}) in ${viewport.w}×${viewport.h}`,
    );
  if (inWindow) failures.push(`${tag}: inside a section.win`);
  if (!uncovered) failures.push(`${tag}: its bottom-right corner is clipped or covered`);
  if (width > 360) failures.push(`${tag}: ${width} px wide`);
}

/** The first match whose centre is on screen (the canvas may hold several). */
async function onScreen(page, locator) {
  for (const l of await locator.all()) {
    const r = await l.boundingBox();
    const v = page.viewportSize();
    if (
      r &&
      r.x + r.width / 2 > 0 &&
      r.y + r.height / 2 > 0 &&
      r.x + r.width / 2 < v.width &&
      r.y + r.height / 2 < v.height
    )
      return l;
  }
  return null;
}

for (const [device, viewport, zoom] of [
  ["desktop", DESKTOP, 0],
  ["phone", PHONE, 0],
  ["desktop-zoomed-out", DESKTOP, -2],
  ["desktop-zoomed-in", DESKTOP, 3],
]) {
  const phone = device === "phone";
  const ctx = await b.newContext({
    viewport,
    deviceScaleFactor: 2,
    hasTouch: phone,
    isMobile: phone,
  });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem("volley-desk-look")) {
      localStorage.setItem("volley-desk-look", JSON.stringify({ bg: "none" }));
    }
  });
  const page = await ctx.newPage();
  const url = new URL(DESK_URL);
  url.searchParams.set("demo", "1");
  await page.goto(url.href);
  await page.locator(".world section.win").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500); // the demo settles and auto-arrange places the windows
  const stage = page.getByRole("region", { name: /^Desk canvas/ });
  await stage.focus();
  if (zoom < 0) for (let i = 0; i < -zoom; i++) await page.keyboard.press("-");
  else if (zoom > 0) {
    // Zoom in around the T6 host chip (Ctrl-wheel zooms about the pointer) so it stays on screen.
    const t6 = await page
      .getByRole("button", { name: "T6 on box-a: why here" })
      .first()
      .boundingBox();
    if (t6) await page.mouse.move(t6.x + t6.width / 2, t6.y + t6.height / 2);
    await page.keyboard.down("Control");
    for (let i = 0; i < zoom; i++) await page.mouse.wheel(0, -60);
    await page.keyboard.up("Control");
  }
  await page.waitForTimeout(400);
  const r = { canvas: await page.locator(".world").evaluate((w) => w.style.transform) };
  report[device] = r;

  // Case 1: the machine chip's tooltip.
  {
    const tag = `machine-${device}`;
    const chip = await onScreen(page, page.getByRole("button", { name: /^Runs on .+: why here$/ }));
    if (!chip) failures.push(`${tag}: no machine chip on screen`);
    else {
      if (phone) await chip.focus();
      else await chip.hover();
      await page.waitForTimeout(200);
      r.machine = await inspect(page, ".m-tip");
      judge(tag, r.machine);
      await page.screenshot({ path: join(out, `popovers-machine-${device}.png`) });
      if (phone) await chip.blur();
      else await page.mouse.move(1, 1);
      await page.waitForTimeout(300);
    }
  }

  // Case 2: the wave window's host chip.
  {
    const tag = `host-${device}`;
    // T6 on box-a; zoomed in it may be off screen, so then any task's host chip that is on it.
    const chip =
      (await onScreen(page, page.getByRole("button", { name: "T6 on box-a: why here" }))) ??
      (await onScreen(
        page,
        page.getByRole("button", { name: /^(?!Runs on ).+ on .+: why here$/ }),
      ));
    if (!chip) failures.push(`${tag}: no host chip on screen`);
    else {
      await chip.click();
      await page.waitForTimeout(200);
      r.host = await inspect(page, '.host-pop[role="dialog"]');
      judge(tag, r.host);
      await page.screenshot({ path: join(out, `popovers-host-${device}.png`) });
      await page.keyboard.press("Escape");
    }
  }
  await ctx.close();
}
await b.close();

const result = { url: DESK_URL, report, failures };
writeFileSync(join(out, "popovers.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(failures.length ? 1 : 0);
