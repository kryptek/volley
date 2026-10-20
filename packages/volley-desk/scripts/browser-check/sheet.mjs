// Comparison sheet: one row per window style, its 3 hovered panels, with the audit's verdicts.
// Reads what styles-audit.mjs wrote to <out dir> and writes <out>/window-styles-<tag>.png.
//   node sheet.mjs <out dir> [tag]
import { readFileSync } from "node:fs";
import { launch, outDir } from "./lib.mjs";

const dir = outDir();
const tag = process.argv[3] ?? "after";
const outPng = `${dir}/window-styles-${tag}.png`;
const audit = JSON.parse(readFileSync(`${dir}/window-styles-${tag}.json`, "utf8"));
const CHROMES = ["glass", "liquid", "spotlight", "glow", "solid"];
const LABEL = {
  glass: "Frosted glass",
  liquid: "Liquid glass",
  spotlight: "Spotlight",
  glow: "Border glow",
  solid: "Solid",
};
const PANELS = ["release-c", "release-c · T1 · implementer", "Wave coordinators"];
const img = (c, i) =>
  `data:image/png;base64,${readFileSync(`${dir}/style-${tag}-${c}-${i}.png`).toString("base64")}`;
const verdict = (x) =>
  [
    x.sameBoxAsDefault ? "box = default" : `box ≠ default (${x.box.w}×${x.box.h})`,
    x.newOverflow.length ? `hover overflow: ${x.newOverflow.join(", ")}` : "no hover overflow",
    `under body Δ${x.underBodyDelta}`,
  ].join(" · ");
const rows = CHROMES.map(
  (c) =>
    `<tr><th>${LABEL[c]}</th>${PANELS.map((p, i) => `<td><img src="${img(c, i)}"><div class="v ${audit[c][p].sameBoxAsDefault && !audit[c][p].newOverflow.length ? "" : "bad"}">${verdict(audit[c][p])}</div></td>`).join("")}</tr>`,
);
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:20px;background:#0b0c14;color:#e8ecf4;font:13px system-ui,sans-serif}
h1{font-size:16px;margin:0 0 12px} table{border-collapse:separate;border-spacing:10px}
th{text-align:left;vertical-align:middle;width:110px} td{vertical-align:top;background:#151826;border-radius:8px;padding:8px}
img{display:block;max-width:420px;max-height:340px} .v{margin-top:6px;color:#8ee6a8;font-size:11px;max-width:420px} .v.bad{color:#ff9a9a}
</style><h1>Window styles (${tag}): the same 3 panels, hovered, at desktop width</h1><table>${rows.join("")}</table>`;
const b = await launch();
const page = await b.newPage({ viewport: { width: 1500, height: 900 } });
await page.setContent(html);
await page.screenshot({ path: outPng, fullPage: true });
await b.close();
console.log(`sheet → ${outPng}`);
