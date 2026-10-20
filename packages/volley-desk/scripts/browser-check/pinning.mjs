// Window pinning (seeded by seed-waves.mjs): anchor the Wave coordinators window to the top
// left of the screen, then arrange & fit, pan, resize the viewport and reload, and check it
// holds its place, that arranged windows leave it room, and (phone) that it collapses to its
// title bar, expands on tap and never covers the dock. Then pin a wave in place and check
// arrange leaves it where it is. At desktop and phone width.
//   node pinning.mjs <out dir>
import { DESKTOP, PHONE, launch, openDesk, outDir } from "./lib.mjs";

const out = outDir();
const b = await launch();
const PIN = /^(Not pinned|Pinned in place|Anchored to the screen) · /;
const overlap = (a, c) =>
  a.x < c.x + c.width && c.x < a.x + a.width && a.y < c.y + c.height && c.y < a.y + a.height;
const round = (r) => r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
const report = {};
for (const [name, viewport, smaller] of [
  ["desktop", DESKTOP, { width: 1200, height: 800 }],
  ["phone", PHONE, { width: 360, height: 740 }],
]) {
  const page = await b.newPage({ viewport, deviceScaleFactor: 2, hasTouch: name === "phone" });
  // The plain background keeps each step fast; pinning does not depend on it.
  await page.addInitScript(() => {
    if (!localStorage.getItem("volley-desk-look")) {
      localStorage.setItem("volley-desk-look", JSON.stringify({ bg: "none" }));
    }
  });
  await openDesk(page);
  const coords = page.getByRole("region", { name: "Wave coordinators" });
  await coords.waitFor();
  await page.waitForTimeout(2500);
  const r = {};
  const pin = coords.getByRole("button", { name: PIN });
  await pin.click();
  r.afterOne = await pin.getAttribute("aria-label");
  await pin.click();
  r.afterTwo = await pin.getAttribute("aria-label");
  r.inHud = await coords.evaluate((el) => el.parentElement?.classList.contains("hud") ?? false);
  // Drag it by its title bar as far up and left as it goes.
  const bar = coords.locator(".win-bar");
  const bb = await bar.boundingBox();
  await page.mouse.move(bb.x + 40, bb.y + 15);
  await page.mouse.down();
  await page.mouse.move(-500, -500, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  r.anchored = round(await coords.boundingBox());
  await page.screenshot({ path: `${out}/pinning-anchored-${name}.png` });

  await page.getByRole("button", { name: "Arrange & fit" }).click();
  await page.waitForTimeout(1200);
  r.afterArrange = round(await coords.boundingBox());
  const box = await coords.boundingBox();
  const canvas = await page.locator(".world section.win").evaluateAll((els) =>
    els.map((e) => {
      const q = e.getBoundingClientRect();
      return {
        label: e.getAttribute("aria-label"),
        x: q.x,
        y: q.y,
        width: q.width,
        height: q.height,
      };
    }),
  );
  r.arrangedCovering = canvas.filter((c) => overlap(c, box)).map((c) => c.label);
  await page.screenshot({ path: `${out}/pinning-arranged-${name}.png` });

  // Pan the canvas: the anchored window does not move.
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await page.mouse.wheel(300, 200);
  await page.waitForTimeout(300);
  r.afterPan = round(await coords.boundingBox());

  await page.setViewportSize(smaller);
  await page.waitForTimeout(1200);
  r.afterResize = round(await coords.boundingBox());
  await page.screenshot({ path: `${out}/pinning-resized-${name}.png` });

  await page.reload();
  await page
    .getByRole("button", { name: "Sign in" })
    .click()
    .catch(() => {});
  await coords.waitFor();
  await page.waitForTimeout(2000);
  r.afterReload = round(await coords.boundingBox());
  r.reloadLabel = await coords.getByRole("button", { name: PIN }).getAttribute("aria-label");
  await page.screenshot({ path: `${out}/pinning-reloaded-${name}.png` });

  if (name === "phone") {
    r.collapsed = await coords.evaluate((el) => el.classList.contains("win--collapsed"));
    const dock = await page.locator(".dock-wrap").boundingBox();
    r.coversDockCollapsed = !!dock && overlap(await coords.boundingBox(), dock);
    await coords.locator(".win-bar .win-title").tap();
    await page.waitForTimeout(400);
    r.expandedOnTap = await coords.evaluate((el) => !el.classList.contains("win--collapsed"));
    await page.screenshot({ path: `${out}/pinning-expanded-${name}.png` });
    await coords.getByRole("button", { name: "Collapse Wave coordinators" }).click();
  }

  // Pin a wave in place: arrange & fit leaves it where it is (on the canvas).
  const wave = page.locator(".world section.win").first();
  const waveName = await wave.getAttribute("aria-label");
  await wave.getByRole("button", { name: PIN }).dispatchEvent("click");
  const before = await wave.evaluate((el) => [el.style.left, el.style.top]);
  await page.getByRole("button", { name: "Arrange & fit" }).click();
  await page.waitForTimeout(1200);
  r.pinnedInPlace = {
    wave: waveName,
    kept:
      JSON.stringify(before) ===
      JSON.stringify(await wave.evaluate((el) => [el.style.left, el.style.top])),
  };
  await page.screenshot({ path: `${out}/pinning-in-place-${name}.png` });

  report[name] = r;
  await page.evaluate(() => localStorage.clear());
  await page.close();
}
console.log(JSON.stringify(report, null, 1));
await b.close();
