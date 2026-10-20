// C11 first load: with ~300 retained finished agents and 3 live ones on the broker (seeded by
// test/fixtures/seed-retained-burst.ts), no finished agent's window may ever be in the DOM.
// Records the most windows of each kind ever on the canvas from the first DOM mutation, and
// screenshots the first frame with any agent window, at desktop and phone width.
//   node first-load.mjs <out dir> [tag]
import { DESKTOP, PHONE, launch, openDesk, outDir } from "./lib.mjs";

const out = outDir();
const tag = process.argv[3] ?? "after";
const b = await launch();
const report = {};
for (const [name, viewport] of [
  ["desktop", DESKTOP],
  ["phone", PHONE],
]) {
  const page = await b.newPage({ viewport });
  await page.addInitScript(() => {
    window.__seen = { old: 0, live: 0 };
    const count = () => {
      const s = window.__seen;
      const n = (p) => document.querySelectorAll(`section[aria-label^="${p}"]`).length;
      s.old = Math.max(s.old, n("old-coord-"));
      s.live = Math.max(s.live, n("live-agent-"));
    };
    new MutationObserver(count).observe(document, { subtree: true, childList: true });
  });
  await openDesk(page);
  await page.waitForSelector(
    'section[aria-label^="live-agent-"], section[aria-label^="old-coord-"]',
    {
      timeout: 15000,
    },
  );
  await page.screenshot({ path: `${out}/first-load-${tag}-${name}.png` });
  await page.waitForTimeout(4000);
  report[name] = {
    maxEverSeen: await page.evaluate(() => window.__seen),
    settled: await page.evaluate(() => ({
      old: document.querySelectorAll('section[aria-label^="old-coord-"]').length,
      live: document.querySelectorAll('section[aria-label^="live-agent-"]').length,
      hiddenNote: document.body.innerText.match(/\d+ finished[^\n]*hidden/)?.[0] ?? null,
    })),
  };
  await page.close();
}
console.log(JSON.stringify(report, null, 1));
await b.close();
