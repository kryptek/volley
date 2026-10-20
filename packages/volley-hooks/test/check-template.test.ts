import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkTemplate } from "../scripts/check-template";
import { PACKAGE_ROOT } from "./helpers/hooks";
import { tempDir } from "./helpers/tmp";

describe("settings template", () => {
  it("every command resolves to an existing hook script", () => {
    const result = checkTemplate(join(PACKAGE_ROOT, "settings.volley-hooks.json"), PACKAGE_ROOT);
    expect(result.missing).toEqual([]);
    expect(result.commands.length).toBeGreaterThanOrEqual(7);
    expect(result.commands).toContain('bun run "$VOLLEY_HOOKS_DIR/src/statusline/publish.ts"');
    expect(result.commands).toContain('bun run "$VOLLEY_HOOKS_DIR/src/hooks/pre-tool-use.ts"');
  });

  it("reports a statusLine command whose script does not exist", () => {
    const dir = tempDir("volley-hooks-tpl-");
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        statusLine: { type: "command", command: 'bun "$VOLLEY_HOOKS_DIR/src/statusline/nope.ts"' },
      }),
    );
    expect(checkTemplate(path, PACKAGE_ROOT).missing).toEqual(["src/statusline/nope.ts"]);
  });

  it("reports a command whose script does not exist", () => {
    const dir = tempDir("volley-hooks-tpl-");
    const path = join(dir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: 'bun "$VOLLEY_HOOKS_DIR/src/hooks/nope.ts"' }] },
          ],
        },
      }),
    );
    expect(checkTemplate(path, PACKAGE_ROOT).missing).toEqual(["src/hooks/nope.ts"]);
  });
});
