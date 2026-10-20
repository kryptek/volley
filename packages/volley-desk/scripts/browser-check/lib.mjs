// Shared by the browser checks: Playwright (loaded from the directory the check runs in, so
// the workspace needs no Playwright dependency), the Desk's URL and signing in.
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/`);
const { chromium } = require("playwright");

/** The Desk dev server (see README.md): `DESK_URL`. */
export const DESK_URL = process.env.DESK_URL ?? "http://127.0.0.1:21320/";

/** Chromium; `CHROME` points at a browser binary when Playwright's own is not installed. */
export const launch = () =>
  chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});

export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };

/** Open the Desk and sign in anonymously (read-only). */
export async function openDesk(page) {
  await page.goto(DESK_URL);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The output directory: argv[2], required. */
export function outDir() {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: <check>.mjs <out dir> [tag]");
    process.exit(2);
  }
  return out;
}
