import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The custom properties of desk.css `:root` (the Volley theme), comments removed. */
function rootTokens(): Map<string, string> {
  const css = readFileSync(join(__dirname, "../../src/styles/desk.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const at = css.indexOf(":root {");
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("\n}", at));
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1] ?? "",
      (m[2] ?? "").replace(/\s+/g, " ").trim(),
    ]),
  );
}

/** `text` with every `var(--x)` that desk.css `:root` declares replaced by its Volley value. */
export function resolveTokens(text: string): string {
  const tokens = rootTokens();
  let out = text;
  for (let i = 0; i < 5; i++) {
    out = out.replace(/var\((--[\w-]+)\)/g, (m, name: string) => tokens.get(name) ?? m);
  }
  return out;
}
