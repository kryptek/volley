/**
 * Applies the look's theme to the document: `applyTheme` writes a theme's
 * tokens as inline custom properties on `<html>`. Volley writes nothing (the
 * `:root` block of `styles/desk.css` is Volley); every other theme first
 * removes what a previous one wrote. `main.tsx` calls `applyLookToDocument`
 * before the first render (the sign-in card is themed too) and `App` again on
 * every change.
 */
import { TOKEN_PROPERTY, type ThemeDef, type ThemeTokens, themeById } from "./themes";
import type { Look } from "./useLook";

/** Every property a theme may write on `<html>`. */
export const OWNED_PROPERTIES: readonly string[] = [
  ...new Set([...Object.values(TOKEN_PROPERTY), "--t-acc-hi", "--t-acc-lo"]),
];

function clearTheme(root: HTMLElement): void {
  for (const p of OWNED_PROPERTIES) root.style.removeProperty(p);
  delete root.dataset.theme;
  delete root.dataset.tone;
  root.style.colorScheme = "";
}

/** Writes `def`'s tokens on `<html>` (after clearing the last theme's), then `data-theme`, `data-tone` and `color-scheme`. */
export function applyThemeTokens(def: ThemeDef): void {
  const root = document.documentElement;
  clearTheme(root);
  for (const [key, value] of Object.entries(def.v) as [keyof ThemeTokens, string][]) {
    if (value !== undefined) root.style.setProperty(TOKEN_PROPERTY[key], value);
  }
  root.dataset.theme = def.id;
  root.dataset.tone = def.tone;
  root.style.colorScheme = def.tone;
}

/** Applies the theme `id`: Volley clears everything, any other id writes its tokens. */
export function applyTheme(id: string): void {
  const def = themeById(id);
  if (def.id === "volley") clearTheme(document.documentElement);
  else applyThemeTokens(def);
}

export function applyLookToDocument(look: Pick<Look, "theme">): void {
  applyTheme(look.theme);
}
