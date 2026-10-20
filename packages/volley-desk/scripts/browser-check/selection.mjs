// Text selection: a drag that starts on the canvas or on window chrome selects nothing, and
// neither does a triple-click or Ctrl+A on the canvas; a feed row's text still selects (and the
// drag does not expand the row). Needs a Desk with at least one agent feed row.
//   node selection.mjs <out dir> [tag]
import { DESKTOP, launch, openDesk, outDir } from "./lib.mjs";

const out = outDir();
const tag = process.argv[3] ?? "after";
const b = await launch();
const page = await b.newPage({ viewport: DESKTOP });
await openDesk(page);
await page.locator(".env-row").first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
const sel = () => page.evaluate(() => window.getSelection()?.toString() ?? "");
const clear = () => page.evaluate(() => window.getSelection()?.removeAllRanges());
const drag = async (x0, y0, x1, y1) => {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 20 });
  await page.mouse.up();
};
const r = {};
const vp = page.viewportSize();

// A feed row first: a drag across the canvas would pan it away.
const row = page.locator(".env-row").first();
const rb = await row.boundingBox();
await drag(rb.x + 12, rb.y + rb.height / 2, rb.x + rb.width - 3, rb.y + rb.height / 2);
const rowText = ((await row.textContent()) ?? "").replace(/\s+/g, "");
const got = (await sel()).replace(/\s+/g, "");
r.feedRowSelected = got.length > 0 && rowText.includes(got.slice(0, 10));
r.feedRowExpanded = await row.getAttribute("aria-expanded");
await page.screenshot({ path: `${out}/selection-feed-row-${tag}.png` });
await clear();

await drag(8, vp.height - 120, vp.width - 20, 60);
r.canvasDragChars = (await sel()).length;
await clear();

const tabs = page.locator(".win .tabs, .win [role=tablist]").first();
const tb = await tabs.boundingBox().catch(() => null);
if (tb) {
  await drag(tb.x + 4, tb.y + tb.height / 2, 10, vp.height - 100);
  r.chromeDragChars = (await sel()).length;
  await clear();
}

await page.mouse.click(8, vp.height - 120, { clickCount: 3 });
r.canvasTripleClickChars = (await sel()).length;
await clear();
await page.locator(".stage").focus();
await page.keyboard.press("Control+A");
r.ctrlAChars = (await sel()).length;
await page.screenshot({ path: `${out}/selection-canvas-${tag}.png` });

console.log(JSON.stringify(r, null, 1));
await b.close();
