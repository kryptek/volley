// The coordinators list (seeded by seed-waves.mjs): status chips, the collapsed Ended group,
// Show (the ended wave's window comes back and the view fits to it) and Dismiss (kept across
// a reload), at desktop and phone width.
//   node coordinators.mjs <out dir>
import { DESKTOP, PHONE, launch, openDesk, outDir } from "./lib.mjs";

const out = outDir();
const b = await launch();
const labels = (loc) => loc.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
const report = {};
for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
]) {
  const page = await b.newPage({ viewport, deviceScaleFactor: 2 });
  await openDesk(page);
  const coords = page.getByRole("region", { name: "Wave coordinators" });
  await coords.waitFor();
  await page.waitForTimeout(2500);
  const head = coords.getByRole("button", { name: /^Ended · / });
  const r = {
    endedHeader: await head.textContent(),
    rows: await labels(coords.locator("li[aria-label]")),
  };
  await head.click();
  await coords.scrollIntoViewIfNeeded();
  await coords.screenshot({ path: `${out}/coordinators-ended-${name}.png` });
  r.canvasBefore = await labels(page.locator('section[aria-label^="release-"]'));
  await coords.getByRole("button", { name: "Show release-a on the canvas" }).click();
  await page.waitForTimeout(1500);
  const box = await page.getByRole("region", { name: "release-a", exact: true }).boundingBox();
  r.shownInViewport =
    !!box &&
    box.x >= -1 &&
    box.y >= -1 &&
    box.x + box.width <= viewport.width + 1 &&
    box.y + box.height <= viewport.height + 1;
  await page.screenshot({ path: `${out}/coordinators-show-${name}.png` });
  // The fit can leave the list off-screen on a phone: click it where it is.
  await coords
    .getByRole("button", { name: "Dismiss release-b from the Desk" })
    .dispatchEvent("click");
  await page.waitForTimeout(300);
  r.rowsAfterDismiss = await labels(coords.locator("li[aria-label]"));
  await page.reload();
  await page
    .getByRole("button", { name: "Sign in" })
    .click()
    .catch(() => {});
  await coords.waitFor();
  await page.waitForTimeout(1500);
  r.endedAfterReload = await coords.getByRole("button", { name: /^Ended · / }).textContent();
  report[name] = r;
  await page.evaluate(() => localStorage.clear());
  await page.close();
}
console.log(JSON.stringify(report, null, 1));
await b.close();
