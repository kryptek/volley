// Text contrast measured on the rendered page, for the theme check (themes.mjs). axe-core's
// `color-contrast` rule leaves text on glass, gradients and backdrops "incomplete" (it cannot
// resolve a background it cannot read from CSS), and that is most of the Desk. So: record every
// visible text element's colour (its opacity and its ancestors' folded in), hide all text, take a
// screenshot, and measure the colour against the pixels painted under the element's box — the
// median over a sample of them. WCAG AA: 4.5:1, or 3:1 for large text (24px, or 18.66px bold).
// Disabled controls, aria-hidden and inert subtrees are exempt, as in WCAG; so is the label a
// Gooey Nav pill covers (its visible copy is the one drawn on the pill).
//
// The canvas fits every window on screen, so its text is a few pixels tall and the sampled box
// runs into borders and inset shadows. `canvasTextContrast` measures each canvas window at 1:1
// instead (the world transform reset, the other windows hidden), in screen-high slices, then the
// chrome outside the canvas (top bar, dock) as it stands.

const AUDIT = "data-text-audit";

/** The text elements under `root` (a selector), whole and on screen, below AA. */
async function measure(page, { root = "body", exclude = null } = {}) {
  // Settled colours: no transition or animation caught half-way.
  const still = await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  });
  const items = await page.evaluate(
    ({ root, exclude, AUDIT }) => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      const rgba = (c) => {
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = "#000";
        cx.fillStyle = c;
        cx.fillRect(0, 0, 1, 1);
        return [...cx.getImageData(0, 0, 1, 1).data];
      };
      const path = (el) => {
        const parts = [];
        for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
          const cls = [...e.classList].slice(0, 2).join(".");
          parts.unshift(e.tagName.toLowerCase() + (cls ? `.${cls}` : ""));
        }
        return parts.join(" > ");
      };
      const out = [];
      let i = 0;
      for (const top of document.querySelectorAll(root)) {
        for (const el of [top, ...top.querySelectorAll("*")]) {
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          if (!own) continue;
          if (exclude && el.closest(exclude)) continue;
          const s = getComputedStyle(el);
          if (s.visibility !== "visible" || s.display === "none") continue;
          if (el.closest("[aria-hidden='true'], [inert], .sr-only, .visually-hidden")) continue;
          if (
            el.closest(
              ".gooey-nav__list:not(.gooey-nav__list--active) .gooey-nav__item[data-active]",
            )
          )
            continue;
          if (el.matches(":disabled") || el.closest(":disabled")) continue;
          let op = 1;
          for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
          if (op < 0.05) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue;
          // Whole inside every scrolling or clipping box it sits in (else part of it is hidden).
          const clipped = (() => {
            for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
              const o = getComputedStyle(e);
              if (`${o.overflowX}${o.overflowY}`.replace(/visible/g, "") === "") continue;
              const b = e.getBoundingClientRect();
              if (r.top < b.top || r.left < b.left || r.bottom > b.bottom || r.right > b.right) {
                return true;
              }
            }
            return false;
          })();
          if (clipped) continue;
          const svg = el instanceof SVGElement;
          if (svg ? s.fill === "none" : rgba(s.webkitTextFillColor)[3] === 0) continue;
          const c = rgba(svg ? s.fill : s.color);
          c[3] = (c[3] / 255) * op;
          if (c[3] < 0.05) continue;
          const size = Number.parseFloat(s.fontSize);
          const bold = Number(s.fontWeight) >= 700;
          el.setAttribute(AUDIT, String(i++));
          out.push({
            path: path(el),
            text: el.textContent.trim().slice(0, 40),
            rect: [r.left, r.top, r.width, r.height],
            color: c,
            large: size >= 24 || (bold && size >= 18.66),
          });
        }
      }
      for (const el of document.querySelectorAll(`[${AUDIT}]`)) el.removeAttribute(AUDIT);
      return out;
    },
    { root, exclude, AUDIT },
  );
  if (items.length === 0) {
    await still.evaluate((n) => n.remove());
    return { checked: 0, bad: [] };
  }
  const hide = await page.addStyleTag({
    content:
      "*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } text, tspan { fill: transparent !important; }",
  });
  const png = (await page.screenshot({ animations: "disabled" })).toString("base64");
  await hide.evaluate((n) => n.remove());
  await still.evaluate((n) => n.remove());
  return page.evaluate(
    async ({ png, items }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const cv = document.createElement("canvas");
      cv.width = img.width;
      cv.height = img.height;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      const k = img.width / innerWidth;
      const lum = ([r, g, b]) => {
        const f = (c) => {
          const v = c / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const bad = [];
      for (const it of items) {
        const [l, t, w, h] = it.rect.map((v) => Math.round(v * k));
        const W = Math.min(w, cv.width - l);
        const H = Math.min(h, cv.height - t);
        if (W < 1 || H < 1) continue;
        const d = cx.getImageData(l, t, W, H).data;
        const ratios = [];
        const step = Math.max(1, Math.floor((W * H) / 400));
        for (let i = 0; i < W * H; i += step) {
          const bg = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
          const a = it.color[3];
          const fg = [0, 1, 2].map((j) => it.color[j] * a + bg[j] * (1 - a));
          ratios.push(ratio(fg, bg));
        }
        ratios.sort((p, q) => p - q);
        const median = ratios[Math.floor(ratios.length / 2)];
        const need = it.large ? 3 : 4.5;
        if (median < need) {
          bad.push({
            path: it.path,
            text: it.text,
            ratio: Math.round(median * 100) / 100,
            need,
            color: `rgba(${it.color.slice(0, 3).join(", ")}, ${Math.round(it.color[3] * 100) / 100})`,
          });
        }
      }
      return { checked: items.length, bad };
    },
    { png, items },
  );
}

/** The text under `root` (a selector: a dialog, the sign-in card) as it stands: `{ checked, bad }`. */
export const textContrast = (page, root = "body") => measure(page, { root });

/** Each canvas window at 1:1, then the chrome outside the canvas: `{ checked, bad }`. */
export async function canvasTextContrast(page) {
  const wins = await page.locator(".world section.win").count();
  const solo = await page.addStyleTag({
    content: `.world section.win:not([${AUDIT}-win]), .topbar, .dock-wrap { visibility: hidden !important; } .world--anim { transition: none !important; }`,
  });
  const saved = await page.evaluate(() => document.querySelector(".world")?.style.transform ?? "");
  let checked = 0;
  const bad = [];
  const seen = new Set();
  for (let n = 0; n < wins; n++) {
    const height = await page.evaluate(
      ({ n, AUDIT }) => {
        const win = document.querySelectorAll(".world section.win")[n];
        for (const w of document.querySelectorAll(`[${AUDIT}-win]`))
          w.removeAttribute(`${AUDIT}-win`);
        win.setAttribute(`${AUDIT}-win`, "");
        return win.offsetHeight;
      },
      { n, AUDIT },
    );
    for (let y = 0; y < height; y += 600) {
      await page.evaluate(
        ({ n, y }) => {
          const win = document.querySelectorAll(".world section.win")[n];
          const world = document.querySelector(".world");
          world.style.transform = `translate(${40 - win.offsetLeft}px, ${120 - win.offsetTop - y}px) scale(1)`;
        },
        { n, y },
      );
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
      const r = await measure(page, { root: `[${AUDIT}-win]` });
      checked += r.checked;
      for (const b of r.bad) {
        const key = `${n}|${b.path}|${b.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bad.push(b);
      }
    }
  }
  await page.evaluate(
    ({ saved, AUDIT }) => {
      for (const w of document.querySelectorAll(`[${AUDIT}-win]`))
        w.removeAttribute(`${AUDIT}-win`);
      const world = document.querySelector(".world");
      if (world) world.style.transform = saved;
    },
    { saved, AUDIT },
  );
  await solo.evaluate((n) => n.remove());
  const rest = await measure(page, { exclude: ".world" });
  return { checked: checked + rest.checked, bad: [...bad, ...rest.bad] };
}
